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

// Returns wallet(lowercased) -> WalletStats|null. SQLite-cached with a TTL
// (unlike wallet_age, a track record CHANGES as markets settle, so entries
// expire). Errors return null and stay uncached so the next call retries.
// `fetcher` is injectable for tests.
export async function getWalletStats(
  db: DB,
  wallets: string[],
  opts: {
    concurrency?: number;
    ttlSec?: number;
    fetcher?: (w: string) => Promise<WalletStats>;
    nowSec?: number;
  } = {},
): Promise<Record<string, WalletStats | null>> {
  const {
    concurrency = 4,
    ttlSec = DEFAULT_TTL_SEC,
    fetcher = fetchWalletStats,
    nowSec = Math.floor(Date.now() / 1000),
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
    try {
      return await fetcher(w);
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
