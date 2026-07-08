import { z } from "zod";
import type { DB } from "./db";
import { fetchWithRetry } from "./fetchWithRetry";
import { mapLimit } from "./mapLimit";

const DATA_API = "https://data-api.polymarket.com";
// Authoritative per-wallet net P/L — the exact figure Polymarket shows on a
// profile ("Profit/loss"). Verified live: the LAST point of the returned curve
// equals the data-api leaderboard PNL for the wallet and correctly NETS the
// held-to-zero losers that /closed-positions omits. One request, no offset cap.
const PNL_API = "https://user-pnl-api.polymarket.com";

// data-api /closed-positions caps limit at 50 per page (verified live: limit=500
// still returns 50 rows), so completeness comes from offset pagination.
const PAGE_SIZE = 50;

// Closed/open pagination cap. CRITICAL (verified live 2026-07): /closed-positions
// is sorted by realizedPnl DESCENDING, so the first pages hold a wallet's most
// PROFITABLE settled positions while its losses sit in the deep tail (e.g.
// offset 0 → +$2.07m, offset 4000 → −$1.3k). The old 8-page (400-row) cap fed
// winRate/roi a winners-only slice for any high-volume wallet — inflating both.
// netPnl no longer depends on this (it comes from PNL_API, one request on a
// SEPARATE host); winRate/roi still do. The cap balances two failure modes:
// too low re-inflates winRate on high-volume wallets; too high multiplies the
// per-wallet upstream fan-out (each page is one data-api request) and, when the
// dashboard cold-loads dozens of wallets at once, storms data-api's ~150req/10s
// limit into 429s. 20 pages (~1000 settled positions) covers the vast majority;
// beyond it the record is honestly flagged `truncated`. offset is NOT capped at
// 3000 here (unlike /activity & /trades — verified offset=4000 returns rows).
const DEFAULT_MAX_PAGES = 20; // ~1000 settled positions

// A wallet that has traded at least this many DISTINCT markets (data-api
// /traded) is a high-frequency market-maker / bot, not a directional bettor.
// Calibrated live (2026-07): the top-PnL population splits cleanly — directional
// traders sit at 2..192 distinct markets, then a wide empty gap, then bots at
// 1077..136094. A win rate is both uncomputable (thousands of settled positions)
// and meaningless (they capture spread, not directional bets) for these, so we
// SKIP the expensive /closed-positions pagination and label them instead. The
// wide gap makes false positives (a human at 1000+ markets) practically impossible.
// Exported for the admission gate's persistent-bot pre-filter (a cached bot
// verdict is durable — markets_traded only ever grows).
export const MARKET_MAKER_MIN_MARKETS = 1000;

// Single source of truth for the classification, used at compute time, on the
// PnL-API-only bot fast path, and on the SQLite cache read.
function isMarketMaker(marketsTraded: number | null): boolean {
  return marketsTraded != null && marketsTraded >= MARKET_MAKER_MIN_MARKETS;
}

// IMPORTANT unit note (verified live): `totalBought` is SHARES, not USD —
// realizedPnl === totalBought * (curPrice - avgPrice) holds exactly on real
// rows. Cost basis in USD is therefore totalBought * avgPrice.
const ClosedPositionSchema = z.object({
  realizedPnl: z.number(),
  totalBought: z.number(),
  avgPrice: z.number(),
});
export type ClosedPosition = z.infer<typeof ClosedPositionSchema>;

// Settled-market track record for a wallet. winRate/roi are derived from
// /closed-positions (+ the survivorship patch); netPnl is the authoritative
// Polymarket net P/L from PNL_API (see fetchUserPnl), independent of the page cap.
export interface WalletStats {
  winRate: number | null; // wins / settledCount; null when nothing settled, truncated, or a market maker
  netPnl: number | null; // USD net P/L (realized + unrealized), Polymarket-profile figure; null when unknowable (see computeWalletStats)
  roi: number | null; // settled realizedPnl / settled cost basis; null when basis is 0, truncated, or a market maker
  settledCount: number;
  truncated: boolean; // hit the page cap — the record is incomplete, so winRate/roi are null (unreliable)
  marketsTraded: number | null; // distinct markets ever traded (data-api /traded); high = automated operator
  isMarketMaker: boolean; // marketsTraded >= MARKET_MAKER_MIN_MARKETS — win rate skipped, wallet labeled
}

export async function fetchClosedPositions(
  wallet: string,
  opts: { maxPages?: number } = {},
): Promise<{ positions: ClosedPosition[]; truncated: boolean }> {
  const { maxPages = DEFAULT_MAX_PAGES } = opts;
  const positions: ClosedPosition[] = [];
  // Duplicate-page guard, same defensive posture as fetchLeaderboard's
  // wallet-level dedup: if the API ever re-serves rows we already collected
  // (deep offsets being silently clamped is a verified data-api behavior on
  // the leaderboard), an all-duplicate page means no forward progress —
  // appending it would double-count positions into the win rate. Fingerprints
  // come from the RAW rows (conditionId + asset): the parsed shape keeps only
  // three numeric fields, nowhere near unique.
  const seenFp = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const url = `${DATA_API}/closed-positions?user=${encodeURIComponent(wallet)}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;
    // Shared transient-5xx retry; a still-failing page throws as before (the
    // walletStats caller treats a throw as "uncached, retry next call").
    const res = await fetchWithRetry(url, {
      timeoutMs: 8000,
      headers: { "User-Agent": "polymarket-monitor" },
      label: "fetchClosedPositions",
    });
    if (!res.ok) throw new Error(`fetchClosedPositions ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) {
      return { positions, truncated: false };
    }
    let fresh = 0;
    const pageFps: string[] = [];
    for (const row of raw) {
      const r = row as Record<string, unknown> | null;
      const cid = r?.conditionId;
      const asset = r?.asset;
      // Rows without identity fields can't be fingerprinted — count them as
      // fresh so an upstream schema change can never falsely trip the guard.
      if (cid == null && asset == null) {
        fresh++;
        continue;
      }
      const fp = `${String(cid)}|${String(asset)}`;
      if (!seenFp.has(fp)) fresh++;
      pageFps.push(fp);
    }
    if (fresh === 0) {
      // Entire page already seen: drop it (appending would double-count) and
      // stop as truncated — older positions exist but are unreachable.
      console.warn(
        `[fetchClosedPositions] ${wallet} page ${page} re-served already-seen positions — stopping, treating as truncated`,
      );
      return { positions, truncated: true };
    }
    for (const fp of pageFps) seenFp.add(fp);
    for (const row of raw) {
      const parsed = ClosedPositionSchema.safeParse(row);
      if (parsed.success) positions.push(parsed.data);
    }
    if (raw.length < PAGE_SIZE) return { positions, truncated: false };
  }
  // Page cap reached with a full last page: older settled positions exist but
  // are not included. Newest-first ordering means we still cover recent form.
  return { positions, truncated: true };
}

// A RESOLVED position still sitting in /positions. This is the survivorship-
// bias fix (verified live): a position held to ZERO never produces a closing
// transaction — there is nothing to redeem — so it NEVER appears in
// /closed-positions. Wallets that ride losers into the ground would otherwise
// show a fake 100% win rate (one live sample: "100% · +$56.6m" with 39
// resolved-to-zero losers worth -$1.46m parked in open positions).
// `redeemable: true` marks a resolved market (it is true for LOSERS too);
// curPrice tells the verdict (0 = lost, 1 = unredeemed win).
const ResolvedOpenSchema = z.object({
  redeemable: z.boolean(),
  curPrice: z.number(),
  cashPnl: z.number(),
  initialValue: z.number(), // USD cost basis of the position
});
export type ResolvedOpenPosition = z.infer<typeof ResolvedOpenSchema>;

export async function fetchResolvedOpenPositions(
  wallet: string,
  opts: { maxPages?: number } = {},
): Promise<{ positions: ResolvedOpenPosition[]; truncated: boolean }> {
  const { maxPages = DEFAULT_MAX_PAGES } = opts;
  const positions: ResolvedOpenPosition[] = [];
  for (let page = 0; page < maxPages; page++) {
    const url = `${DATA_API}/positions?user=${encodeURIComponent(wallet)}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "polymarket-monitor" },
    });
    if (!res.ok) throw new Error(`fetchResolvedOpenPositions ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) {
      return { positions, truncated: false };
    }
    for (const row of raw) {
      const parsed = ResolvedOpenSchema.safeParse(row);
      // Keep only DECIDED positions: resolved markets with a clear verdict.
      // Live (unresolved) positions and 50/50 pushes stay out of the record.
      if (
        parsed.success &&
        parsed.data.redeemable &&
        (parsed.data.curPrice < 0.5 || parsed.data.curPrice > 0.5)
      ) {
        positions.push(parsed.data);
      }
    }
    if (raw.length < PAGE_SIZE) return { positions, truncated: false };
  }
  return { positions, truncated: true };
}

// Authoritative net P/L from Polymarket's own PnL-curve API — the number shown
// on a profile page. The endpoint returns the CUMULATIVE running P/L as a
// [{ t, p }] series; the last point's `p` is the current net P/L (realized +
// unrealized). A 1-month window (fidelity=1d) is a tiny payload whose final
// point still carries the full-history cumulative total (verified live: its `p`
// matches the interval=max series' last point and the ALL leaderboard PNL).
// Returns null when the series is empty or malformed so the caller can fall back
// to the settled realized sum. Throws only on a non-transient HTTP failure
// (fetchWithRetry already retries transient 5xx); the caller catches that.
export async function fetchUserPnl(wallet: string): Promise<number | null> {
  const url =
    `${PNL_API}/user-pnl?user_address=${encodeURIComponent(wallet)}` +
    `&interval=1m&fidelity=1d`;
  const res = await fetchWithRetry(url, {
    timeoutMs: 8000,
    headers: { "User-Agent": "polymarket-monitor" },
    label: "fetchUserPnl",
  });
  if (!res.ok) throw new Error(`fetchUserPnl ${res.status}`);
  const raw = await res.json();
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const last = raw[raw.length - 1] as { p?: unknown } | null;
  const p = last?.p;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

// Distinct markets the wallet has EVER traded (verified live: this is the value
// behind data-api /v1/user-stats.trades and the profile "预测" count). One cheap
// request — used to classify high-frequency market makers (see MARKET_MAKER_MIN_
// MARKETS) BEFORE committing to the expensive /closed-positions pagination.
// Returns null on any failure so the caller degrades to the normal path.
export async function fetchMarketsTraded(
  wallet: string,
): Promise<number | null> {
  const url = `${DATA_API}/traded?user=${encodeURIComponent(wallet)}`;
  const res = await fetchWithRetry(url, {
    timeoutMs: 8000,
    headers: { "User-Agent": "polymarket-monitor" },
    label: "fetchMarketsTraded",
  });
  if (!res.ok) throw new Error(`fetchMarketsTraded ${res.status}`);
  const raw = (await res.json()) as { traded?: unknown } | null;
  const n = raw?.traded;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// Pure aggregation. winRate/roi come from the settled positions; `netPnl` is the
// authoritative Polymarket net P/L (from fetchUserPnl), falling back to the
// settled realized sum only when the PnL API is unavailable AND the closed set
// is complete (see the return site — a truncated fallback would be inflated).
//  - closed positions (sold or redeemed): win = realizedPnl > 0
//  - resolved-but-unclosed positions: win = curPrice > 0.5 (1 = unredeemed win,
//    0 = held-to-zero loss); their cashPnl is final at resolution.
export function computeWalletStats(
  positions: ClosedPosition[],
  truncated: boolean,
  resolvedOpen: ResolvedOpenPosition[] = [],
  netPnl?: number | null,
  marketsTraded: number | null = null,
): WalletStats {
  let wins = 0;
  let settledRealized = 0; // realized gains over settled positions (roi numerator)
  let costBasis = 0;
  for (const p of positions) {
    if (p.realizedPnl > 0) wins++;
    settledRealized += p.realizedPnl;
    costBasis += p.totalBought * p.avgPrice;
  }
  for (const p of resolvedOpen) {
    if (p.curPrice > 0.5) wins++;
    settledRealized += p.cashPnl;
    costBasis += p.initialValue;
  }
  const settledCount = positions.length + resolvedOpen.length;
  // A TRUNCATED record is the top slice of /closed-positions, which is sorted by
  // realizedPnl DESC — a systematically WINNER-biased sample. Its winRate reads a
  // fake ~100% and its roi/settled-sum are inflated (verified live: a 15-day
  // market-maker with 6000+ settled positions, every fetched row profitable).
  // The true values are unrecoverable (the loss tail is unreachable and the
  // record can run to thousands of positions), so winRate/roi are null — an
  // honest "unknown" beats a wrong number. netPnl stays authoritative: it comes
  // from PNL_API and only falls back to the (inflated) settled sum when COMPLETE.
  return {
    winRate: truncated ? null : settledCount > 0 ? wins / settledCount : null,
    netPnl: netPnl ?? (truncated ? null : settledRealized),
    roi: truncated ? null : costBasis > 0 ? settledRealized / costBasis : null,
    settledCount,
    truncated,
    marketsTraded,
    isMarketMaker: isMarketMaker(marketsTraded),
  };
}

async function fetchWalletStats(wallet: string): Promise<WalletStats> {
  // Two cheap probes first: distinct markets (data-api /traded) to classify
  // market makers, and the authoritative net P/L (user-pnl-api, separate host).
  const [marketsTraded, netPnl] = await Promise.all([
    fetchMarketsTraded(wallet).catch((e) => {
      console.warn(`[walletStats] /traded fetch failed for ${wallet}:`, e);
      return null;
    }),
    // A PnL-API failure degrades to the settled realized sum (in
    // computeWalletStats) rather than failing the whole record.
    fetchUserPnl(wallet).catch((e) => {
      console.warn(`[walletStats] user-pnl fetch failed for ${wallet}:`, e);
      return null;
    }),
  ]);

  // Market maker → its win rate is meaningless AND its /closed-positions run to
  // thousands of pages; skip that pagination entirely (a ~20x request saving on
  // exactly the wallets that stress data-api's rate limit) and return a labeled,
  // win-rate-less record. netPnl stays authoritative.
  if (isMarketMaker(marketsTraded)) {
    return {
      winRate: null,
      netPnl,
      roi: null,
      settledCount: 0,
      truncated: false,
      marketsTraded,
      isMarketMaker: true,
    };
  }

  // Normal wallet: derive the settled win rate / roi from its (small) position set.
  const [closed, open] = await Promise.all([
    fetchClosedPositions(wallet),
    fetchResolvedOpenPositions(wallet),
  ]);
  return computeWalletStats(
    closed.positions,
    closed.truncated || open.truncated,
    open.positions,
    netPnl,
    marketsTraded,
  );
}

const DEFAULT_TTL_SEC = 86_400; // track records move slowly; a day is fresh enough

// In-flight dedup across concurrent calls (same pattern as walletAge): a
// wallet page and the daily seed enriching the same cold wallet would each
// pull up to 8 /closed-positions pages, with the loser's INSERT OR REPLACE
// overwriting the winner's for no gain. Keyed by lowercased wallet; entries
// drop once settled so failures retry next call.
const inFlightStats = new Map<string, Promise<WalletStats>>();

// Returns wallet(lowercased) -> WalletStats|null. SQLite-cached with a TTL
// (unlike wallet_age, a track record CHANGES as markets settle, so entries
// expire). Errors return null and stay uncached so the next call retries.
// Concurrent calls share one in-flight fetch per wallet. `fetcher`/`inFlight`
// are injectable for tests.
export async function getWalletStats(
  db: DB,
  wallets: string[],
  opts: {
    concurrency?: number;
    ttlSec?: number;
    fetcher?: (w: string) => Promise<WalletStats>;
    nowSec?: number;
    inFlight?: Map<string, Promise<WalletStats>>;
  } = {},
): Promise<Record<string, WalletStats | null>> {
  const {
    // 3 (not 4): each cold wallet now fans out to closed+open pagination + the
    // user-pnl call, so 4-wide over a dashboard's worth of cold wallets storms
    // data-api's ~150req/10s limit (429s → exhausted retries → null → "—").
    concurrency = 3,
    ttlSec = DEFAULT_TTL_SEC,
    fetcher = fetchWalletStats,
    nowSec = Math.floor(Date.now() / 1000),
    inFlight = inFlightStats,
  } = opts;
  const distinct = [...new Set(wallets.map((w) => w.toLowerCase()))];
  const sel = db.prepare(
    "SELECT win_rate, realized_pnl, roi, settled_count, truncated, markets_traded, fetched_at FROM wallet_stats WHERE wallet = ?",
  );
  const ins = db.prepare(
    `INSERT OR REPLACE INTO wallet_stats
       (wallet, win_rate, realized_pnl, roi, settled_count, truncated, markets_traded, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const result: Record<string, WalletStats | null> = {};
  const misses: string[] = [];
  for (const w of distinct) {
    const row = sel.get(w) as
      | {
          win_rate: number | null;
          realized_pnl: number | null; // stores netPnl, which can be null
          roi: number | null;
          settled_count: number;
          truncated: number;
          markets_traded: number | null;
          fetched_at: number;
        }
      | undefined;
    if (row && nowSec - row.fetched_at < ttlSec) {
      result[w] = {
        winRate: row.win_rate,
        // Physical column stays `realized_pnl`; it now stores the net P/L.
        netPnl: row.realized_pnl,
        roi: row.roi,
        settledCount: row.settled_count,
        truncated: !!row.truncated,
        marketsTraded: row.markets_traded,
        isMarketMaker: isMarketMaker(row.markets_traded),
      };
    } else {
      misses.push(w);
    }
  }
  const fetched = await mapLimit(misses, concurrency, async (w) => {
    let p = inFlight.get(w);
    if (!p) {
      p = fetcher(w);
      inFlight.set(w, p);
      // Settle-time cleanup; the leading catch keeps a rejected fetch from
      // surfacing as unhandled here (every awaiter handles it below).
      p.catch(() => {}).finally(() => inFlight.delete(w));
    }
    try {
      return await p;
    } catch (e) {
      console.warn(`[walletStats] fetch failed for ${w}:`, e);
      return null;
    }
  });
  misses.forEach((w, idx) => {
    const s = fetched[idx];
    if (s) {
      ins.run(
        w,
        s.winRate,
        s.netPnl, // → realized_pnl column
        s.roi,
        s.settledCount,
        s.truncated ? 1 : 0,
        s.marketsTraded,
        nowSec,
      );
    }
    result[w] = s;
  });
  return result;
}
