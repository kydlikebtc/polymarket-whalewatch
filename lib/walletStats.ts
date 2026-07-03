import { z } from "zod";
import type { DB } from "./db";
import { fetchWithRetry } from "./fetchWithRetry";
import { mapLimit } from "./mapLimit";

const DATA_API = "https://data-api.polymarket.com";

// data-api /closed-positions caps limit at 50 per page (verified live: limit=500
// still returns 50 rows), so completeness comes from offset pagination.
const PAGE_SIZE = 50;

// IMPORTANT unit note (verified live): `totalBought` is SHARES, not USD —
// realizedPnl === totalBought * (curPrice - avgPrice) holds exactly on real
// rows. Cost basis in USD is therefore totalBought * avgPrice.
const ClosedPositionSchema = z.object({
  realizedPnl: z.number(),
  totalBought: z.number(),
  avgPrice: z.number(),
});
export type ClosedPosition = z.infer<typeof ClosedPositionSchema>;

// Settled-market track record for a wallet, derived from /closed-positions.
export interface WalletStats {
  winRate: number | null; // wins / settledCount, null when nothing settled
  realizedPnl: number; // USD, sum over settled positions
  roi: number | null; // realizedPnl / costBasis, null when costBasis is 0
  settledCount: number;
  truncated: boolean; // hit the page cap — stats cover the newest positions only
}

export async function fetchClosedPositions(
  wallet: string,
  opts: { maxPages?: number } = {},
): Promise<{ positions: ClosedPosition[]; truncated: boolean }> {
  const { maxPages = 8 } = opts;
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

// Pure aggregation — a position with realizedPnl > 0 counts as a win; break-even
// and losing positions both count against the win rate.
export function computeWalletStats(
  positions: ClosedPosition[],
  truncated: boolean,
): WalletStats {
  let wins = 0;
  let realizedPnl = 0;
  let costBasis = 0;
  for (const p of positions) {
    if (p.realizedPnl > 0) wins++;
    realizedPnl += p.realizedPnl;
    costBasis += p.totalBought * p.avgPrice;
  }
  const settledCount = positions.length;
  return {
    winRate: settledCount > 0 ? wins / settledCount : null,
    realizedPnl,
    roi: costBasis > 0 ? realizedPnl / costBasis : null,
    settledCount,
    truncated,
  };
}

async function fetchWalletStats(wallet: string): Promise<WalletStats> {
  const { positions, truncated } = await fetchClosedPositions(wallet);
  return computeWalletStats(positions, truncated);
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
    concurrency = 4,
    ttlSec = DEFAULT_TTL_SEC,
    fetcher = fetchWalletStats,
    nowSec = Math.floor(Date.now() / 1000),
    inFlight = inFlightStats,
  } = opts;
  const distinct = [...new Set(wallets.map((w) => w.toLowerCase()))];
  const sel = db.prepare(
    "SELECT win_rate, realized_pnl, roi, settled_count, truncated, fetched_at FROM wallet_stats WHERE wallet = ?",
  );
  const ins = db.prepare(
    `INSERT OR REPLACE INTO wallet_stats
       (wallet, win_rate, realized_pnl, roi, settled_count, truncated, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const result: Record<string, WalletStats | null> = {};
  const misses: string[] = [];
  for (const w of distinct) {
    const row = sel.get(w) as
      | {
          win_rate: number | null;
          realized_pnl: number;
          roi: number | null;
          settled_count: number;
          truncated: number;
          fetched_at: number;
        }
      | undefined;
    if (row && nowSec - row.fetched_at < ttlSec) {
      result[w] = {
        winRate: row.win_rate,
        realizedPnl: row.realized_pnl,
        roi: row.roi,
        settledCount: row.settled_count,
        truncated: !!row.truncated,
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
        s.realizedPnl,
        s.roi,
        s.settledCount,
        s.truncated ? 1 : 0,
        nowSec,
      );
    }
    result[w] = s;
  });
  return result;
}
