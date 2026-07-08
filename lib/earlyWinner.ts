import type { DB } from "./db";
import type { Trade } from "./types";
import { parseTradeRows } from "./polymarket";
import { fetchWithRetry } from "./fetchWithRetry";
import { dedupKey, notionalUsd } from "./trades";
import { mapLimit } from "./mapLimit";
import { recordEvidence, type CandidateEvidence } from "./discovery";

// ---------------------------------------------------------------------------
// Early-winner discovery (channel 'early_winner'): in freshly-settled markets,
// find the wallets that bought the WINNING outcome early and cheap — skill the
// size-ranked leaderboards structurally miss. Verified live (2026-07-08):
//  - gamma /markets?closed=true&order=closedTime&ascending=false lists markets
//    by REAL resolution time (endDate is the nominal schedule — early-resolved
//    markets keep a future endDate, so ordering by it is useless here);
//  - data-api /trades?market=<conditionId> composes with filterType/
//    filterAmount and serves settled markets' full history (newest-first,
//    offset hard-capped at 3000 like every /trades query).
// Closed markets are immutable, so each is scanned exactly once
// (early_winner_scans cursor) — the daily run only ever pays for NEW
// settlements.
// ---------------------------------------------------------------------------

const GAMMA_API = "https://gamma-api.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";

// A cheap early buy is one at <=40¢ (>=2.5x if right) made at least 24h before
// resolution — the lead excludes both in-play sports swings and last-minute
// sure-thing sniping (that pattern belongs to the 'insider' channel).
export const EW_MAX_PRICE = 0.4;
export const EW_EARLY_LEAD_SEC = 86_400;
export const EW_MIN_TOTAL_USD = 500;
// Thin markets are noise: a $10k-volume floor keeps "beat a real market", and
// the $500 trade-fetch floor keeps a settled market's sweep inside the 3000-
// offset cap for all but the very largest markets (verified: a ~$600k-volume
// market compresses to ~91 rows at this floor).
export const EW_MIN_MARKET_VOLUME = 10_000;
export const EW_TRADE_FETCH_MIN_USD = 500;

/** gamma closedTime arrives as "YYYY-MM-DD HH:MM:SS+00" (not ISO); normalize. */
export function parseClosedTime(s: string | null | undefined): number | null {
  if (!s) return null;
  let iso = s.trim().replace(" ", "T");
  // "+00" / "+0000" → "+00:00" so Date.parse treats it as a proper offset.
  const m = iso.match(/([+-]\d{2})(\d{2})?$/);
  if (m && !iso.endsWith("Z") && !/[+-]\d{2}:\d{2}$/.test(iso)) {
    iso = iso.slice(0, -m[0].length) + m[1] + ":" + (m[2] ?? "00");
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export interface ClosedMarket {
  conditionId: string;
  title: string;
  closedTimeSec: number;
  volume: number;
  winnerIdx: number;
  winnerOutcome: string;
}

const asNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : null;

const asArr = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
};

/**
 * Recently-resolved markets, newest resolution first, down to `sinceSec`.
 * Per-row salvage: undecided/refunded markets (no outcome pinned >0.99, or
 * more than one — data glitch) and sub-floor volume are skipped, a stale row
 * terminates the sweep (rows are closedTime-descending).
 *
 * The volume floor is applied SERVER-SIDE (`volume_num_min`, verified live
 * 2026-07-08): the raw closed feed churns ~700 markets/hour (15-minute crypto
 * micros, in-play tennis games), so an unfiltered 100-row page spans only a
 * few MINUTES of settlements and no sane page budget ever reaches a 48h
 * boundary. Filtered, ~100 rows ≈ 3.3h — a 20-page budget genuinely covers
 * the lookback. If the budget still runs out before `sinceSec`, the gap is
 * loudly logged (a silent cap here once hid a 97% coverage collapse).
 */
export async function fetchRecentlyClosedMarkets(opts: {
  sinceSec: number;
  minVolume?: number;
  maxMarkets?: number;
  pageSize?: number;
  maxPages?: number;
  fetcher?: (url: string) => Promise<Response>;
}): Promise<ClosedMarket[]> {
  const {
    sinceSec,
    minVolume = EW_MIN_MARKET_VOLUME,
    maxMarkets = 1500,
    pageSize = 100,
    maxPages = 20,
    fetcher = (url: string) =>
      fetchWithRetry(url, { timeoutMs: 10_000, label: "fetchClosedMarkets" }),
  } = opts;
  const volParam = minVolume > 0 ? `&volume_num_min=${minVolume}` : "";
  const out: ClosedMarket[] = [];
  const seen = new Set<string>();
  let reachedSince = false;
  let oldestSeenSec: number | null = null;
  let page = 0;
  for (; page < maxPages && out.length < maxMarkets; page++) {
    const url = `${GAMMA_API}/markets?closed=true&order=closedTime&ascending=false&limit=${pageSize}&offset=${page * pageSize}${volParam}`;
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`fetchRecentlyClosedMarkets ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) {
      reachedSince = true; // feed exhausted — nothing older exists
      break;
    }
    let stale = false;
    for (const row of raw as Record<string, unknown>[]) {
      const cid = typeof row.conditionId === "string" ? row.conditionId : "";
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      const closedTimeSec = parseClosedTime(
        typeof row.closedTime === "string" ? row.closedTime : null,
      );
      if (closedTimeSec == null) continue;
      if (oldestSeenSec == null || closedTimeSec < oldestSeenSec) {
        oldestSeenSec = closedTimeSec;
      }
      if (closedTimeSec < sinceSec) {
        stale = true; // descending order: everything deeper is older
        continue;
      }
      // Belt-and-braces client check behind the server-side filter.
      const volume = asNum(row.volumeNum) ?? asNum(row.volume) ?? 0;
      if (volume < minVolume) continue;
      const prices = asArr(row.outcomePrices).map((p) => asNum(p) ?? 0);
      const winners = prices
        .map((p, i) => (p > 0.99 ? i : -1))
        .filter((i) => i >= 0);
      if (winners.length !== 1) continue; // refund/undecided/ambiguous
      const winnerIdx = winners[0];
      const outcomes = asArr(row.outcomes).map((o) => String(o));
      out.push({
        conditionId: cid,
        title: typeof row.question === "string" ? row.question : cid,
        closedTimeSec,
        volume,
        winnerIdx,
        winnerOutcome: outcomes[winnerIdx] ?? String(winnerIdx),
      });
      if (out.length >= maxMarkets) break;
    }
    if (stale) {
      reachedSince = true;
      break;
    }
    if (raw.length < pageSize) {
      reachedSince = true;
      break;
    }
  }
  if (!reachedSince) {
    const coveredH =
      oldestSeenSec != null
        ? ((Date.now() / 1000 - oldestSeenSec) / 3600).toFixed(1)
        : "?";
    const wantedH = ((Date.now() / 1000 - sinceSec) / 3600).toFixed(1);
    console.warn(
      `[discovery] closed-market listing exhausted its ${page}-page budget BEFORE reaching the lookback ` +
        `(covered ~${coveredH}h of the requested ${wantedH}h) — older settlements are invisible this run`,
    );
  }
  return out;
}

// Same 3000-offset hard cap as every /trades query (lib/polymarket.ts).
const MAX_TRADES_OFFSET = 3000;
const TRADES_PAGE_LIMIT = 250;

/** Full trade history of ONE market at a $ floor, newest-first, salvage-parsed. */
export async function fetchMarketTrades(
  conditionId: string,
  opts: {
    minUsd?: number;
    fetcher?: (url: string) => Promise<Response>;
  } = {},
): Promise<{ trades: Trade[]; truncated: boolean }> {
  const {
    minUsd = EW_TRADE_FETCH_MIN_USD,
    fetcher = (url: string) =>
      fetchWithRetry(url, { timeoutMs: 12_000, label: "fetchMarketTrades" }),
  } = opts;
  const out: Trade[] = [];
  let offset = 0;
  for (;;) {
    if (offset > MAX_TRADES_OFFSET) {
      // The earliest trades live at the DEEPEST offsets, so a truncated sweep
      // is missing exactly the most interesting rows — flag it honestly.
      return { trades: out, truncated: true };
    }
    const url = `${DATA_API}/trades?market=${encodeURIComponent(conditionId)}&filterType=CASH&filterAmount=${minUsd}&takerOnly=true&limit=${TRADES_PAGE_LIMIT}&offset=${offset}`;
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`fetchMarketTrades ${res.status}`);
    const rows = parseTradeRows(await res.json(), "fetchMarketTrades");
    out.push(...rows);
    if (rows.length < TRADES_PAGE_LIMIT)
      return { trades: out, truncated: false };
    offset += TRADES_PAGE_LIMIT;
  }
}

/**
 * Pure extraction: wallets whose early (>=24h pre-resolution) cheap (<=40¢)
 * buys of the WINNING outcome total >= $500. Buys on any other outcome count
 * against the wallet (a both-sides book is market-making, not foresight);
 * pool wallets are not discoveries.
 */
export function extractEarlyWinnerEvidence(
  trades: Trade[],
  market: ClosedMarket,
  opts: {
    maxPrice?: number;
    earlyLeadSec?: number;
    minTotalUsd?: number;
    poolAddresses?: Set<string>;
  } = {},
): CandidateEvidence[] {
  const {
    maxPrice = EW_MAX_PRICE,
    earlyLeadSec = EW_EARLY_LEAD_SEC,
    minTotalUsd = EW_MIN_TOTAL_USD,
    poolAddresses,
  } = opts;
  const cutoff = market.closedTimeSec - earlyLeadSec;
  const seen = new Set<string>();
  type Acc = {
    winUsd: number;
    winShares: number;
    lastTs: number;
    otherBuyUsd: number;
  };
  const byWallet = new Map<string, Acc>();
  for (const t of trades) {
    if (t.conditionId !== market.conditionId) continue;
    if (t.side !== "BUY") continue;
    const dk = dedupKey(t);
    if (seen.has(dk)) continue;
    seen.add(dk);
    const wallet = t.proxyWallet.toLowerCase();
    let acc = byWallet.get(wallet);
    if (!acc) {
      acc = { winUsd: 0, winShares: 0, lastTs: 0, otherBuyUsd: 0 };
      byWallet.set(wallet, acc);
    }
    const usd = notionalUsd(t);
    if (
      t.outcomeIndex === market.winnerIdx &&
      t.price <= maxPrice &&
      t.timestamp <= cutoff
    ) {
      acc.winUsd += usd;
      acc.winShares += t.size;
      if (t.timestamp > acc.lastTs) acc.lastTs = t.timestamp;
    } else if (t.outcomeIndex !== market.winnerIdx) {
      acc.otherBuyUsd += usd;
    }
  }
  const out: CandidateEvidence[] = [];
  for (const [wallet, acc] of byWallet) {
    if (poolAddresses?.has(wallet)) continue;
    if (acc.winUsd < minTotalUsd) continue;
    if (acc.winUsd <= acc.otherBuyUsd) continue; // both-sides book
    const avgPrice = acc.winShares > 0 ? acc.winUsd / acc.winShares : 0;
    const leadDays = (market.closedTimeSec - acc.lastTs) / 86_400;
    out.push({
      address: wallet,
      channel: "early_winner",
      conditionId: market.conditionId,
      ts: acc.lastTs,
      usd: acc.winUsd,
      price: avgPrice,
      note:
        `提前 ${leadDays.toFixed(1)} 天以 ${(avgPrice * 100).toFixed(1)}¢ ` +
        `买中「${market.winnerOutcome}」 $${Math.round(acc.winUsd).toLocaleString("en-US")} · ` +
        (market.title.length > 40
          ? `${market.title.slice(0, 39)}…`
          : market.title),
    });
  }
  return out;
}

export interface EarlyWinnerScanResult {
  candidateMarkets: number; // fresh settlements matching the volume floor
  scanned: number; // markets actually swept this run
  evidence: number;
  inserted: number;
}

/**
 * One scan pass: list fresh settlements, sweep the unscanned ones (bounded),
 * persist evidence, and record the per-market cursor. A failed market is left
 * UN-cursored so the next run retries it; closed-market immutability makes the
 * retry loss-free.
 */
export async function runEarlyWinnerScan(
  db: DB,
  opts: {
    nowSec?: number;
    lookbackSec?: number;
    maxMarketsPerRun?: number;
    concurrency?: number;
    marketsFetcher?: typeof fetchRecentlyClosedMarkets;
    tradesFetcher?: typeof fetchMarketTrades;
  } = {},
): Promise<EarlyWinnerScanResult> {
  const {
    nowSec = Math.floor(Date.now() / 1000),
    lookbackSec = 48 * 3600,
    // Sized to the qualified settlement flow (~30/h ≈ 720/day at the $10k
    // floor, measured live): the cap must EXCEED a day's inflow or a backlog
    // grows that the 48h listing window then silently drops. ~800 markets ×
    // 1-2 pages at concurrency 2 is a few hundred requests once a day — noise
    // against the ~150req/10s budget.
    maxMarketsPerRun = 800,
    concurrency = 2,
    marketsFetcher = fetchRecentlyClosedMarkets,
    tradesFetcher = fetchMarketTrades,
  } = opts;
  const markets = await marketsFetcher({ sinceSec: nowSec - lookbackSec });
  const isScanned = db.prepare(
    "SELECT 1 FROM early_winner_scans WHERE condition_id = ?",
  );
  const unscanned = markets.filter((m) => !isScanned.get(m.conditionId));
  // Drain OLDEST-first: whatever the cap cuts must be the newest markets —
  // those re-appear in tomorrow's 48h listing, while the oldest are about to
  // fall out of it forever.
  const fresh = unscanned
    .slice()
    .sort((a, b) => a.closedTimeSec - b.closedTimeSec)
    .slice(0, maxMarketsPerRun);
  if (unscanned.length > fresh.length) {
    console.warn(
      `[discovery] early-winner scan capped: ${fresh.length}/${unscanned.length} unscanned market(s) this run — the newest ${unscanned.length - fresh.length} roll over to tomorrow's listing`,
    );
  }
  if (fresh.length === 0) {
    return {
      candidateMarkets: markets.length,
      scanned: 0,
      evidence: 0,
      inserted: 0,
    };
  }
  // The pool snapshot: discoveries are wallets we DON'T already track.
  const pool = new Set(
    (
      db.prepare("SELECT address FROM smart_wallets").all() as {
        address: string;
      }[]
    ).map((r) => r.address.toLowerCase()),
  );
  const markScanned = db.prepare(
    "INSERT OR REPLACE INTO early_winner_scans (condition_id, scanned_at, trades_scanned, truncated) VALUES (?, ?, ?, ?)",
  );
  let scanned = 0;
  let evidence = 0;
  let inserted = 0;
  await mapLimit(fresh, concurrency, async (m) => {
    try {
      const { trades, truncated } = await tradesFetcher(m.conditionId, {});
      if (truncated) {
        // The 3000-offset cap cut exactly the DEEPEST (earliest) fills — the
        // most valuable rows for this channel. The evidence extracted from
        // the visible slice is still true, but early buyers beyond the cap
        // are invisible; say so instead of silently posing as a full sweep.
        console.warn(
          `[discovery] early-winner sweep TRUNCATED at the /trades offset cap for ${m.conditionId} ` +
            `(${trades.length} rows) — the earliest fills are beyond reach, evidence is a newest-slice lower bound`,
        );
      }
      const ev = extractEarlyWinnerEvidence(trades, m, { poolAddresses: pool });
      inserted += recordEvidence(db, ev, nowSec);
      evidence += ev.length;
      markScanned.run(m.conditionId, nowSec, trades.length, truncated ? 1 : 0);
      scanned++;
    } catch (e) {
      // No cursor row on failure: the market re-appears in tomorrow's 48h
      // listing (closed markets are immutable), so the retry is loss-free.
      console.warn(
        `[discovery] early-winner sweep failed for ${m.conditionId} (will retry next run):`,
        e,
      );
    }
  });
  console.log(
    `[discovery] early-winner scan: ${scanned}/${fresh.length} market(s) swept · ${evidence} evidence row(s), ${inserted} new`,
  );
  return { candidateMarkets: markets.length, scanned, evidence, inserted };
}
