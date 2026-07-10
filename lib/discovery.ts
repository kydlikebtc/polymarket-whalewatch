import type { DB } from "./db";
import type { Trade } from "./types";
import type { SmartTag } from "./smartWallets";
import {
  detectConsensus,
  DEFAULT_CONSENSUS,
  type ConsensusGroup,
} from "./consensus";
import { aggregate } from "./accumulate";
import { dedupKey, notionalUsd } from "./trades";
import { getWalletAges } from "./walletAge";
import { fetchWithRetry } from "./fetchWithRetry";

// ---------------------------------------------------------------------------
// Firehose discovery: the consensus loop already pulls the full $2k-floor 6h
// trade window every 5 minutes — but only ever MATCHES it against the existing
// pool. This module runs the same window BACKWARDS to find wallets that
// deserve candidacy: evidence rows land in wallet_candidates, and the daily
// admission gate (lib/admission) decides who graduates into smart_wallets.
// Discovery itself NEVER writes smart_wallets — candidacy must not silently
// change what the consensus whitelist means.
// ---------------------------------------------------------------------------

export type DiscoveryChannel = "echo" | "splitter" | "insider" | "early_winner";

// One piece of evidence: wallet X showed channel-Z behavior in market Y.
// Persisted with PRIMARY KEY (address, channel, condition_id), so the rolling
// window re-observing the same behavior every cycle is a no-op — recurrence is
// COUNT(DISTINCT condition_id), never "times seen".
export interface CandidateEvidence {
  address: string; // lowercased
  channel: DiscoveryChannel;
  conditionId: string;
  ts: number; // when the behavior happened (trade time, unix sec)
  usd: number;
  price: number;
  note: string; // one human-readable line for the discovery dashboard
  // Full market context for the evidence detail view — the note only carries a
  // 40-char truncated title, which is not enough to identify (let alone open)
  // the market. Nullable because rows written before these columns existed
  // stay NULL until the rolling window re-observes the behavior.
  title: string | null;
  slug: string | null; // MARKET slug (gamma /markets?slug= key)
  eventSlug: string | null;
  outcome: string | null;
}

// Echo floor: below the consensus fetch floor's own $2k visibility there is
// nothing to see anyway; $2k keeps "followed the smart money with real size"
// distinguishable from dust.
export const ECHO_MIN_USD = 2_000;

// Splitter thresholds mirror the accumulation page's defaults: >=3 buys each
// under the $10k single-fill alert ceiling, netting >=$5k.
export const SPLITTER_OPTS = {
  minNetUsd: 5_000,
  minBuyCount: 3,
  splitCeiling: 10_000,
} as const;

// Near-certainty ceiling for echo/splitter evidence, same convention as the
// alert engine's default maxPrice=0.95: buys at 99¢+ carry no directional
// information. Observed live on day one — dozens of wallets split-buying the
// same market at 99.8¢ in identical clips (parking/farming, not conviction)
// flooded the candidate funnel with breadth-1 noise.
export const EVIDENCE_MAX_PRICE = 0.95;

// Insider signature (the glossary's "内幕猎杀组合", automated): a single
// decisive BUY at favorite odds from a fresh address.
export const INSIDER_MIN_USD = 5_000;
export const INSIDER_MIN_PRICE = 0.5;
export const INSIDER_MAX_PRICE = 0.9;
export const INSIDER_MAX_AGE_DAYS = 7;
// Age lookups are network-bound (permanently cached after the first probe);
// cap the per-cycle NEW lookups so a hot window can't stall the cycle.
const INSIDER_AGE_LOOKUPS_PER_CYCLE = 50;

const shortTitle = (t: string) => (t.length > 40 ? `${t.slice(0, 39)}…` : t);
const fmtUsd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const fmtPrice = (p: number) => `${(p * 100).toFixed(1)}¢`;

/**
 * Non-pool wallets net-buying the SAME (market, outcome) a smart-money
 * consensus formed on, inside the same window. Mirrors detectConsensus's
 * accounting: dedup first, net = buys − sells, and a wallet net-buying >=2
 * outcomes of one market is a hedger with no directional opinion — dropped.
 */
export function detectEchoEvidence(
  trades: Trade[],
  smartTags: Map<string, SmartTag>,
  opts: {
    groups: Array<Pick<ConsensusGroup, "conditionId" | "outcome">>;
    echoMinUsd?: number;
  },
): CandidateEvidence[] {
  const { groups, echoMinUsd = ECHO_MIN_USD } = opts;
  if (groups.length === 0) return [];
  const targets = new Set(groups.map((g) => `${g.conditionId}:${g.outcome}`));
  const cids = new Set(groups.map((g) => g.conditionId));

  const seen = new Set<string>();
  type Acc = {
    buyUsd: number;
    sellUsd: number;
    buyShares: number;
    lastTs: number;
    title: string;
    slug: string;
    eventSlug: string;
  };
  // conditionId:outcome:wallet -> accumulator (consensus markets only)
  const byKey = new Map<string, Acc>();
  for (const t of trades) {
    if (!cids.has(t.conditionId)) continue;
    const wallet = t.proxyWallet.toLowerCase();
    if (smartTags.has(wallet)) continue; // pool members aren't discoveries
    const dk = dedupKey(t);
    if (seen.has(dk)) continue;
    seen.add(dk);
    const key = `${t.conditionId}:${t.outcome}:${wallet}`;
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        buyUsd: 0,
        sellUsd: 0,
        buyShares: 0,
        lastTs: t.timestamp,
        title: t.title,
        slug: t.slug,
        eventSlug: t.eventSlug,
      };
      byKey.set(key, acc);
    }
    if (t.timestamp > acc.lastTs) acc.lastTs = t.timestamp;
    const usd = notionalUsd(t);
    if (t.side === "BUY") {
      acc.buyUsd += usd;
      acc.buyShares += t.size;
    } else {
      acc.sellUsd += usd;
    }
  }

  // Hedger exclusion, same shape as detectConsensus: count net-bought outcomes
  // per (market, wallet) across ALL outcomes seen in that market.
  const netBoughtOutcomes = new Map<string, number>(); // cid:wallet -> n
  for (const [key, acc] of byKey) {
    if (acc.buyUsd - acc.sellUsd <= 0) continue;
    const [cid, , wallet] = key.split(":");
    const wm = `${cid}:${wallet}`;
    netBoughtOutcomes.set(wm, (netBoughtOutcomes.get(wm) ?? 0) + 1);
  }

  const out: CandidateEvidence[] = [];
  for (const [key, acc] of byKey) {
    const [cid, outcome, wallet] = key.split(":");
    if (!targets.has(`${cid}:${outcome}`)) continue;
    const netUsd = acc.buyUsd - acc.sellUsd;
    if (netUsd < echoMinUsd) continue;
    if ((netBoughtOutcomes.get(`${cid}:${wallet}`) ?? 0) >= 2) continue; // hedger
    const avgPrice = acc.buyShares > 0 ? acc.buyUsd / acc.buyShares : 0;
    if (avgPrice > EVIDENCE_MAX_PRICE) continue; // near-certainty — info-free
    out.push({
      address: wallet,
      channel: "echo",
      conditionId: cid,
      ts: acc.lastTs,
      usd: netUsd,
      price: avgPrice,
      note: `与共识同向净买 ${fmtUsd(netUsd)} @ ${fmtPrice(avgPrice)} · ${shortTitle(acc.title)}`,
      title: acc.title,
      slug: acc.slug,
      eventSlug: acc.eventSlug,
      outcome,
    });
  }
  return out;
}

/**
 * Wallets running a clean split-buy accumulation (>=3 sub-ceiling fills
 * netting >=$5k, no hedge/market-making suspicion). Reuses the accumulation
 * page's aggregate() verbatim — same thresholds, same tags.
 *
 * Pool members are RECORDED too: split-buying is a BEHAVIOR tag, equally
 * informative on a whitelist whale as on an unknown wallet. Candidacy and
 * admission stay pool-exclusive downstream (the candidates view filters pool
 * members out; admitCandidates skips non-discovered pool sources) — the
 * evidence table serves both the discovery funnel and the behavior-label
 * system (方向③), and conflating "who may be recorded" with "who may be
 * admitted" was exactly how pool rows ended up permanently tag-less.
 */
export function detectSplitterEvidence(
  trades: Trade[],
  _smartTags: Map<string, SmartTag>,
  opts: typeof SPLITTER_OPTS = SPLITTER_OPTS,
): CandidateEvidence[] {
  const out: CandidateEvidence[] = [];
  for (const g of aggregate(trades, opts)) {
    const wallet = g.wallet.toLowerCase();
    if (g.hedgeSuspect || g.mmSuspect) continue; // no directional conviction
    if (g.avgBuyPrice > EVIDENCE_MAX_PRICE) continue; // near-certainty — info-free
    out.push({
      address: wallet,
      channel: "splitter",
      conditionId: g.conditionId,
      ts: g.lastTs,
      usd: g.netUsd,
      price: g.avgBuyPrice,
      note: `拆单 ${g.buyCount} 笔净买 ${fmtUsd(g.netUsd)} @ ${fmtPrice(g.avgBuyPrice)} · ${shortTitle(g.title)}`,
      title: g.title,
      slug: g.slug,
      eventSlug: g.eventSlug,
      outcome: g.outcome,
    });
  }
  return out;
}

/**
 * Insider-shaped fills PENDING age verification: a big BUY at favorite odds
 * (0.5–0.9) from a non-pool wallet. Age is network-bound, so this pure pass
 * only shortlists; collectFirehoseEvidence checks the wallet age and keeps
 * fills from addresses younger than INSIDER_MAX_AGE_DAYS. One row per
 * (wallet, market): the largest fill is the signature.
 */
export function detectInsiderPending(
  trades: Trade[],
  smartTags: Map<string, SmartTag>,
  opts: { minUsd?: number; minPrice?: number; maxPrice?: number } = {},
): CandidateEvidence[] {
  const {
    minUsd = INSIDER_MIN_USD,
    minPrice = INSIDER_MIN_PRICE,
    maxPrice = INSIDER_MAX_PRICE,
  } = opts;
  const seen = new Set<string>();
  const best = new Map<string, CandidateEvidence>(); // wallet:cid -> largest fill
  for (const t of trades) {
    if (t.side !== "BUY") continue;
    if (t.price < minPrice || t.price > maxPrice) continue;
    const wallet = t.proxyWallet.toLowerCase();
    if (smartTags.has(wallet)) continue;
    const usd = notionalUsd(t);
    if (usd < minUsd) continue;
    const dk = dedupKey(t);
    if (seen.has(dk)) continue;
    seen.add(dk);
    const key = `${wallet}:${t.conditionId}`;
    const prev = best.get(key);
    if (prev && prev.usd >= usd) continue;
    best.set(key, {
      address: wallet,
      channel: "insider",
      conditionId: t.conditionId,
      ts: t.timestamp,
      usd,
      price: t.price,
      note: `单笔 ${fmtUsd(usd)} 买入 @ ${fmtPrice(t.price)} · ${shortTitle(t.title)}`,
      title: t.title,
      slug: t.slug,
      eventSlug: t.eventSlug,
      outcome: t.outcome,
    });
  }
  return [...best.values()];
}

/**
 * Persist evidence rows. The PK dedups per (wallet, channel, market), but a
 * strictly NEWER observation of the same behavior refreshes the row
 * (evidence_ts/usd/note) — the 30-day recurrence window keys on evidence_ts,
 * so a wallet still actively doing the thing must not read as stale just
 * because it was first seen a month ago. created_at stays frozen at first
 * discovery. Returns rows actually written (new or refreshed).
 */
export function recordEvidence(
  db: DB,
  evidence: CandidateEvidence[],
  nowSec: number,
): number {
  if (evidence.length === 0) return 0;
  // Two update paths: a strictly NEWER observation refreshes everything, and a
  // same-age re-observation may still BACKFILL market context onto a legacy
  // row (title IS NULL — written before those columns existed). Market context
  // is immutable per market, so taking it from any observation is safe;
  // MAX() keeps evidence_ts from regressing when a sliding window recomputes
  // the same behavior with an older lastTs on the backfill path.
  const ins = db.prepare(
    `INSERT INTO wallet_candidates
     (address, channel, condition_id, evidence_ts, usd, price, note,
      title, slug, event_slug, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address, channel, condition_id) DO UPDATE SET
       evidence_ts = MAX(excluded.evidence_ts, wallet_candidates.evidence_ts),
       usd = excluded.usd,
       price = excluded.price,
       note = excluded.note,
       title = COALESCE(excluded.title, wallet_candidates.title),
       slug = COALESCE(excluded.slug, wallet_candidates.slug),
       event_slug = COALESCE(excluded.event_slug, wallet_candidates.event_slug),
       outcome = COALESCE(excluded.outcome, wallet_candidates.outcome)
     WHERE excluded.evidence_ts > wallet_candidates.evidence_ts
        OR (wallet_candidates.title IS NULL AND excluded.title IS NOT NULL)`,
  );
  let written = 0;
  const tx = db.transaction(() => {
    for (const e of evidence) {
      written += ins.run(
        e.address,
        e.channel,
        e.conditionId,
        e.ts,
        e.usd,
        e.price,
        e.note,
        e.title,
        e.slug,
        e.eventSlug,
        e.outcome,
        nowSec,
      ).changes;
    }
  });
  tx();
  return written;
}

/* ------------------------------------------------------ legacy backfill */

// Mirrors lib/admission.ADMIT_EVIDENCE_WINDOW_SEC — duplicated instead of
// imported because admission → earlyWinner → discovery already chains, and
// discovery → admission would close an import cycle.
const BACKFILL_WINDOW_SEC = 30 * 86_400;
// Same chunking convention as lib/gamma: short URLs, independent failures.
const BACKFILL_CHUNK = 20;
// Per-pass ceiling on gamma requests; the remainder heals on later cycles.
const BACKFILL_MAX_IDS = 100;

const GAMMA_API = "https://gamma-api.polymarket.com";

// The slice of a gamma /markets row the backfill needs. Field shapes verified
// live (2026-07-10): `question` is the market title, `slug` the market slug,
// `events[0].slug` the event slug.
export interface MarketContext {
  title: string;
  slug: string | null;
  eventSlug: string | null;
}

type ContextFetcher = (url: string) => Promise<Response>;

async function sweepMarketContexts(
  ids: string[],
  extraQs: string,
  out: Record<string, MarketContext>,
  fetcher: ContextFetcher,
): Promise<void> {
  for (let i = 0; i < ids.length; i += BACKFILL_CHUNK) {
    const chunk = ids.slice(i, i + BACKFILL_CHUNK);
    const qs =
      chunk.map((c) => `condition_ids=${encodeURIComponent(c)}`).join("&") +
      extraQs;
    try {
      const res = await fetcher(`${GAMMA_API}/markets?${qs}`);
      if (!res.ok) {
        console.warn(
          `[discovery] backfill chunk failed (${res.status}), skipping ${chunk.length} ids`,
        );
        continue;
      }
      const raw = await res.json();
      if (!Array.isArray(raw)) continue;
      for (const row of raw as Record<string, unknown>[]) {
        const cid = typeof row.conditionId === "string" ? row.conditionId : "";
        const question = typeof row.question === "string" ? row.question : "";
        if (!cid || !question) continue;
        const events = Array.isArray(row.events)
          ? (row.events as Record<string, unknown>[])
          : [];
        out[cid] = {
          title: question,
          slug: typeof row.slug === "string" ? row.slug : null,
          eventSlug:
            typeof events[0]?.slug === "string" ? events[0].slug : null,
        };
      }
    } catch (e) {
      console.warn(
        `[discovery] backfill chunk error, skipping ${chunk.length} ids:`,
        e,
      );
    }
  }
}

/**
 * Heal evidence rows written before the market-context columns existed
 * (title IS NULL): one chunked gamma sweep per pass fills title/slug/
 * event_slug for every distinct legacy market still inside the evidence
 * window. Needed because the upsert-time backfill can't reach most legacy
 * rows — early_winner markets are scanned exactly ONCE (cursor table), and
 * the firehose channels only re-observe wallets that repeat the behavior.
 * `outcome` stays NULL (it is per-evidence, not per-market; the UI renders
 * without it). Once every row carries context the SELECT comes back empty
 * and the pass is a free no-op. Markets gamma no longer serves stay NULL and
 * age out of the window naturally.
 *
 * Two sweeps like lib/gamma.getMarketMeta: the plain /markets query EXCLUDES
 * closed markets (verified live), so whatever the first sweep misses gets a
 * second closed=true sweep — most legacy markets are settled by now.
 */
export async function backfillEvidenceMarketContext(
  db: DB,
  opts: {
    nowSec?: number;
    windowSec?: number;
    maxIds?: number;
    fetcher?: ContextFetcher;
  } = {},
): Promise<number> {
  const {
    nowSec = Math.floor(Date.now() / 1000),
    windowSec = BACKFILL_WINDOW_SEC,
    maxIds = BACKFILL_MAX_IDS,
    fetcher = (url: string) =>
      fetchWithRetry(url, { timeoutMs: 10_000, label: "evidenceBackfill" }),
  } = opts;
  const rows = db
    .prepare(
      `SELECT DISTINCT condition_id FROM wallet_candidates
        WHERE title IS NULL AND evidence_ts >= ?`,
    )
    .all(nowSec - windowSec) as { condition_id: string }[];
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.condition_id).slice(0, maxIds);

  const contexts: Record<string, MarketContext> = {};
  await sweepMarketContexts(ids, "", contexts, fetcher);
  const missing = ids.filter((c) => !contexts[c]);
  if (missing.length > 0) {
    await sweepMarketContexts(missing, "&closed=true", contexts, fetcher);
  }

  const upd = db.prepare(
    `UPDATE wallet_candidates SET title = ?, slug = ?, event_slug = ?
      WHERE condition_id = ? AND title IS NULL`,
  );
  let healed = 0;
  const tx = db.transaction(() => {
    for (const [cid, c] of Object.entries(contexts)) {
      healed += upd.run(c.title, c.slug, c.eventSlug, cid).changes;
    }
  });
  tx();
  if (healed > 0) {
    console.log(
      `[discovery] backfilled market context onto ${healed} legacy evidence row(s) across ${Object.keys(contexts).length} market(s)`,
    );
  }
  return healed;
}

export interface FirehoseResult {
  evidence: number; // rows detected this cycle (pre-dedup)
  inserted: number; // rows actually new
}

/**
 * One firehose discovery pass over an already-fetched trade window (piggybacks
 * on the consensus loop's fetch — zero extra trade requests). Runs the three
 * detectors, resolves ages for the insider shortlist (permanently cached per
 * wallet; capped per cycle), and persists the evidence. Failures must never
 * disturb the consensus cycle — callers fire-and-forget with their own catch.
 */
export async function collectFirehoseEvidence(
  db: DB,
  trades: Trade[],
  smartTags: Map<string, SmartTag>,
  opts: {
    nowSec?: number;
    groups?: Array<Pick<ConsensusGroup, "conditionId" | "outcome">>;
    agesFetcher?: typeof getWalletAges;
    maxAgeLookups?: number;
    insiderMaxAgeDays?: number;
  } = {},
): Promise<FirehoseResult> {
  const {
    nowSec = Math.floor(Date.now() / 1000),
    // Re-detecting here (pure, in-memory) keeps discovery decoupled from the
    // alert path's state machine; callers that already hold groups can inject.
    groups = detectConsensus(trades, smartTags, DEFAULT_CONSENSUS),
    agesFetcher = getWalletAges,
    maxAgeLookups = INSIDER_AGE_LOOKUPS_PER_CYCLE,
    insiderMaxAgeDays = INSIDER_MAX_AGE_DAYS,
  } = opts;

  const echo = detectEchoEvidence(trades, smartTags, { groups });
  const splitter = detectSplitterEvidence(trades, smartTags);
  const pending = detectInsiderPending(trades, smartTags).sort(
    (a, b) => b.ts - a.ts, // newest first — they get the capped age lookups
  );

  let insider: CandidateEvidence[] = [];
  if (pending.length > 0) {
    const distinct = [...new Set(pending.map((p) => p.address))];
    // The cap bounds NETWORK cost, so it must only spend on cache misses:
    // wallets whose age is already in wallet_age are free lookups and always
    // included — otherwise a hot window's cached wallets would consume the
    // budget and starve the (older-fill) uncached ones indefinitely.
    const placeholders = distinct.map(() => "?").join(",");
    const cached = new Set(
      (
        db
          .prepare(
            `SELECT wallet FROM wallet_age WHERE wallet IN (${placeholders})`,
          )
          .all(...distinct) as { wallet: string }[]
      ).map((r) => r.wallet),
    );
    const uncached = distinct.filter((w) => !cached.has(w));
    const wallets = [
      ...distinct.filter((w) => cached.has(w)),
      ...uncached.slice(0, maxAgeLookups),
    ];
    const walletSet = new Set(wallets);
    // Failed lookups are ABSENT from the map (not null) — those fills are
    // skipped this cycle and re-evaluated next cycle (the PK makes retries
    // free). null means "verified: no prior activity" — the freshest possible
    // wallet, which for a just-filled trade means it was born this window.
    const ages = await agesFetcher(db, wallets);
    insider = pending.filter((p) => {
      if (!walletSet.has(p.address)) return false; // over the lookup cap
      if (!(p.address in ages)) return false; // lookup failed — retry later
      const firstTs = ages[p.address];
      const ageDays =
        typeof firstTs === "number" ? (nowSec - firstTs) / 86_400 : 0;
      return ageDays <= insiderMaxAgeDays;
    });
  }

  const all = [...echo, ...splitter, ...insider];
  const inserted = recordEvidence(db, all, nowSec);
  if (all.length > 0) {
    console.log(
      `[discovery] firehose evidence: echo ${echo.length} · splitter ${splitter.length} · insider ${insider.length} — ${inserted} new/refreshed row(s)`,
    );
  }
  return { evidence: all.length, inserted };
}
