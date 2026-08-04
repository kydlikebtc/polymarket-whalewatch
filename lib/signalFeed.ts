import type { DB } from "./db";
import { gradeRows, type SignalRecord } from "./signalRecord";

// Signal feed for external consumers (the mobile 信号 tab). The dashboard and
// the Telegram channel both consume alerts as a STREAM — one row per fill,
// ~245/day. A phone cannot: the same day folds to ~35 markets, and below a
// $50k notional the rows are overwhelmingly noise (measured: notional <$25k is
// 69% of all alerts). So this module answers a different question than the
// alerts table does — not "what trades fired" but "what is worth a card":
//
//   1. fold to market × direction (one card per position, not per fill)
//   2. classify into the three kinds a trader reads differently
//   3. attach the price-adjusted record, computed by the SAME gradeRows the
//      push footer uses
//
// Kinds, in descending conviction:
//   consensus — ≥2 whitelist wallets net-bought the same outcome
//   split     — whitelist wallets on BOTH outcomes of one market. Deliberately
//               NOT two consensus cards: rendering "smart money likes A" above
//               "smart money likes B" destroys the page's credibility, and it
//               is not hypothetical (a live sample had $94,400 on one side of
//               a WTA match and $10,918 on the other).
//   heavy     — ONE whitelist wallet ≥$50k. Weaker than consensus, and
//               suppressed when consensus already covers that market+outcome
//               so a market never occupies two cards.

export type SignalKind = "consensus" | "split" | "heavy";

/** Window for the "in progress" list. */
export const ACTIVE_WINDOW_HOURS = 24;
/** Notional floor for a single-wallet card. Below this it is noise, not news. */
export const HEAVY_MIN_USD = 50_000;
/** How far back the settled ("认账") list reaches. */
export const SETTLED_DAYS = 3;
/** Record window, matching the push footer. */
export const RECORD_DAYS = 30;

export interface SignalWallet {
  wallet: string;
  netUsd: number;
  avgPrice: number;
}

/** One side of a split market. */
export interface SignalSide {
  outcome: string;
  outcomeIndex: number | null;
  asset: string | null;
  walletCount: number;
  netUsd: number;
  avgPrice: number;
}

export interface Signal {
  /** Stable identity for client-side dedup: conditionId, plus outcome when directional. */
  key: string;
  kind: SignalKind;
  conditionId: string;
  title: string;
  eventSlug: string;
  category: string | null;
  /** When the signal came into being (consensus formation / the fill). */
  formationTs: number;
  /** Directional signals only (consensus | heavy). */
  outcome: string | null;
  outcomeIndex: number | null;
  asset: string | null;
  walletCount: number;
  netUsd: number;
  /** Their cost basis — the number the client turns into a chase gate. */
  avgPrice: number;
  wallets: SignalWallet[];
  /** Split only: both sides, so the client renders ONE card. */
  sides?: SignalSide[];
}

export interface SettledSignal {
  title: string;
  outcome: string;
  kind: SignalKind;
  entryPrice: number;
  won: boolean;
  settledAt: number;
}

export interface SignalFeed {
  updatedAt: number;
  windowHours: number;
  heavyMinUsd: number;
  active: Signal[];
  settled: SettledSignal[];
  record30d: SignalRecord;
}

interface AlertRow {
  id: number;
  type: string;
  payload: string;
  created_at: number;
}

// Deliberately loose: alert payloads are written by several engine paths and
// gain fields over time, so this reads what it needs and tolerates the rest.
interface RawPayload {
  conditionId?: string;
  title?: string;
  eventSlug?: string;
  outcome?: string;
  outcomeIndex?: number;
  asset?: string;
  proxyWallet?: string;
  side?: string;
  size?: number;
  price?: number;
  avgBuyPrice?: number;
  totalNetUsd?: number;
  walletCount?: number;
  firstTs?: number;
  wallets?: { wallet?: string; netUsd?: number; avgBuyPrice?: number }[];
}

function parse(row: AlertRow): RawPayload | null {
  try {
    return JSON.parse(row.payload) as RawPayload;
  } catch {
    return null;
  }
}

function selectAlerts(db: DB, types: string[], sinceSec: number): AlertRow[] {
  const placeholders = types.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, type, payload, created_at FROM alerts
       WHERE type IN (${placeholders}) AND created_at >= ?
       ORDER BY created_at ASC`,
    )
    .all(...types, sinceSec) as AlertRow[];
}

function categoriesFor(db: DB, slugs: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const uniq = [...new Set(slugs.filter(Boolean))];
  if (uniq.length === 0) return out;
  const placeholders = uniq.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT event_slug, category FROM event_category WHERE event_slug IN (${placeholders})`,
    )
    .all(...uniq) as { event_slug: string; category: string | null }[];
  for (const r of rows) out[r.event_slug] = r.category;
  return out;
}

/** Consensus alerts fold to the LATEST state per (market, outcome). */
function foldConsensus(rows: AlertRow[]): Map<string, Signal> {
  const byKey = new Map<string, Signal>();
  for (const row of rows) {
    const p = parse(row);
    if (!p?.conditionId || !p.outcome) continue;
    const key = `${p.conditionId}|${p.outcome}`;
    // Later rows are escalations of the same formation — keep the newest
    // totals but the ORIGINAL formation time, which is what the card shows
    // and what a trader uses to judge staleness.
    const prev = byKey.get(key);
    byKey.set(key, {
      key,
      kind: "consensus",
      conditionId: p.conditionId,
      title: p.title ?? "",
      eventSlug: p.eventSlug ?? "",
      category: null,
      formationTs: prev?.formationTs ?? p.firstTs ?? row.created_at,
      outcome: p.outcome,
      outcomeIndex: p.outcomeIndex ?? null,
      asset: p.asset ?? null,
      walletCount: p.walletCount ?? p.wallets?.length ?? 0,
      netUsd: p.totalNetUsd ?? 0,
      avgPrice: p.avgBuyPrice ?? 0,
      wallets: (p.wallets ?? []).map((w) => ({
        wallet: w.wallet ?? "",
        netUsd: w.netUsd ?? 0,
        avgPrice: w.avgBuyPrice ?? 0,
      })),
    });
  }
  return byKey;
}

/**
 * Markets carrying consensus on more than one outcome collapse into a single
 * `split` card. Both sides survive in `sides` — the disagreement IS the
 * information, so nothing is dropped, it is just refused a direction.
 */
function collapseSplits(byKey: Map<string, Signal>): Signal[] {
  const byMarket = new Map<string, Signal[]>();
  for (const s of byKey.values()) {
    const list = byMarket.get(s.conditionId) ?? [];
    list.push(s);
    byMarket.set(s.conditionId, list);
  }
  const out: Signal[] = [];
  for (const [conditionId, group] of byMarket) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const sides = group
      .map((g) => ({
        outcome: g.outcome ?? "",
        outcomeIndex: g.outcomeIndex,
        asset: g.asset,
        walletCount: g.walletCount,
        netUsd: g.netUsd,
        avgPrice: g.avgPrice,
      }))
      .sort((a, b) => b.netUsd - a.netUsd);
    const lead = group.reduce((a, b) => (b.netUsd > a.netUsd ? b : a));
    out.push({
      key: conditionId,
      kind: "split",
      conditionId,
      title: lead.title,
      eventSlug: lead.eventSlug,
      category: null,
      formationTs: Math.min(...group.map((g) => g.formationTs)),
      // A split has no direction on purpose: the client must not print one.
      outcome: null,
      outcomeIndex: null,
      asset: null,
      walletCount: sides.reduce((n, s) => n + s.walletCount, 0),
      netUsd: sides.reduce((n, s) => n + s.netUsd, 0),
      avgPrice: 0,
      wallets: group.flatMap((g) => g.wallets),
      sides,
    });
  }
  return out;
}

/** Single-wallet ≥$50k fills, folded to market × outcome (largest fill wins). */
function foldHeavy(rows: AlertRow[], covered: Set<string>): Signal[] {
  const byKey = new Map<string, Signal>();
  for (const row of rows) {
    const p = parse(row);
    if (!p?.conditionId || !p.outcome || p.side !== "BUY") continue;
    const notional = (p.size ?? 0) * (p.price ?? 0);
    if (notional < HEAVY_MIN_USD) continue;
    const key = `${p.conditionId}|${p.outcome}`;
    // Consensus already owns this market+outcome — a second card for the same
    // position would just be the same news told twice.
    if (covered.has(key)) continue;
    const prev = byKey.get(key);
    if (prev && prev.netUsd >= notional) continue;
    byKey.set(key, {
      key,
      kind: "heavy",
      conditionId: p.conditionId,
      title: p.title ?? "",
      eventSlug: p.eventSlug ?? "",
      category: null,
      formationTs: prev?.formationTs ?? row.created_at,
      outcome: p.outcome,
      outcomeIndex: p.outcomeIndex ?? null,
      asset: p.asset ?? null,
      walletCount: 1,
      netUsd: notional,
      avgPrice: p.price ?? 0,
      wallets: [
        {
          wallet: (p.proxyWallet ?? "").toLowerCase(),
          netUsd: notional,
          avgPrice: p.price ?? 0,
        },
      ],
    });
  }
  return [...byKey.values()];
}

function settledList(db: DB, sinceSec: number): SettledSignal[] {
  const rows = db
    .prepare(
      `SELECT a.type, a.payload, ao.won, ao.checked_at
       FROM alerts a JOIN alert_outcomes ao ON ao.alert_id = a.id
       WHERE a.type IN ('consensus','smart') AND ao.won IS NOT NULL
         AND ao.checked_at >= ?
       ORDER BY ao.checked_at DESC LIMIT 20`,
    )
    .all(sinceSec) as {
    type: string;
    payload: string;
    won: number;
    checked_at: number;
  }[];
  const out: SettledSignal[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const p = parse(r as unknown as AlertRow);
    if (!p?.conditionId || !p.outcome) continue;
    const key = `${p.conditionId}|${p.outcome}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = p.price ?? p.avgBuyPrice;
    if (typeof entry !== "number") continue;
    out.push({
      title: p.title ?? "",
      outcome: p.outcome,
      kind: r.type === "consensus" ? "consensus" : "heavy",
      entryPrice: entry,
      won: r.won === 1,
      settledAt: r.checked_at,
    });
  }
  return out;
}

/**
 * 30-day price-adjusted record over the same signal families the feed shows.
 * Rows without a fill price carry no benchmark and leave both sides of the
 * ledger — same discipline as pushes.
 */
function feedRecord(db: DB, sinceSec: number): SignalRecord {
  const rows = db
    .prepare(
      `SELECT ao.won,
              COALESCE(json_extract(a.payload,'$.price'),
                       json_extract(a.payload,'$.avgBuyPrice')) AS price,
              COALESCE(json_extract(a.payload,'$.side'), 'BUY') AS side
       FROM alerts a JOIN alert_outcomes ao ON ao.alert_id = a.id
       WHERE a.type IN ('consensus','smart') AND a.created_at >= ?
         AND ao.won IS NOT NULL`,
    )
    .all(sinceSec) as { won: number; price: number | null; side: string }[];
  return gradeRows(rows);
}

/**
 * Build the whole feed. One db pass per family; no upstream calls at all —
 * everything here is already-persisted state, which is what makes this safe to
 * serve on a short cache to an app backend.
 */
export function buildSignalFeed(
  db: DB,
  opts: { nowSec?: number; windowHours?: number } = {},
): SignalFeed {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const windowHours = opts.windowHours ?? ACTIVE_WINDOW_HOURS;
  const activeSince = nowSec - windowHours * 3600;

  const consensusFolded = foldConsensus(
    selectAlerts(db, ["consensus"], activeSince),
  );
  const covered = new Set(consensusFolded.keys());
  const active = [
    ...collapseSplits(consensusFolded),
    ...foldHeavy(selectAlerts(db, ["smart"], activeSince), covered),
  ];

  const cats = categoriesFor(
    db,
    active.map((s) => s.eventSlug),
  );
  for (const s of active) s.category = cats[s.eventSlug] ?? null;

  // Newest first: a trader reads top-down and staleness is the first thing
  // that disqualifies a signal. Client re-sorts by its own relevance rules
  // (own positions first) — it knows things this server deliberately doesn't.
  active.sort((a, b) => b.formationTs - a.formationTs);

  return {
    updatedAt: nowSec,
    windowHours,
    heavyMinUsd: HEAVY_MIN_USD,
    active,
    settled: settledList(db, nowSec - SETTLED_DAYS * 86_400),
    record30d: feedRecord(db, nowSec - RECORD_DAYS * 86_400),
  };
}
