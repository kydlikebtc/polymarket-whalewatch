import type { DB } from "./db";
import {
  fetchLeaderboard,
  type LeaderboardPeriod,
  type LeaderboardRow,
} from "./leaderboard";
import { getWalletStats, type WalletStats } from "./walletStats";

// A smart-wallet tag as consumed by the alert engine and the dashboards.
export interface SmartTag {
  score: number | null;
  winRate: number | null;
  realizedPnl: number | null;
  isWhitelist: boolean;
}

/**
 * Composite 0-100 smart-money score. Heuristic, deliberately explainable:
 *  - up to 40 pts for absolute profit ($1m+ saturates)
 *  - up to 30 pts for capital efficiency pnl/vol (10%+ saturates) — this is the
 *    axis that separates informed money from high-volume market makers
 *  - up to 30 pts for settled win rate (unknown treated as a neutral 0.5)
 * Weights are config-free v1 seeds; the validation loop can calibrate later.
 */
export function computeScore(input: {
  pnl: number;
  vol: number;
  winRate: number | null;
}): number {
  const pnlNorm = Math.min(1, Math.max(0, input.pnl) / 1_000_000);
  const eff =
    input.vol > 0 ? Math.min(1, Math.max(0, input.pnl / input.vol) / 0.1) : 0;
  const wr = input.winRate ?? 0.5;
  return Math.round(40 * pnlNorm + 30 * eff + 30 * wr);
}

export interface SeedResult {
  seeded: number;
  enriched: number;
}

/**
 * Seed/refresh the smart_wallets table from the official profit leaderboards.
 * Boards are merged per wallet keeping the best pnl/vol showing across periods.
 * vol=0 rows are dropped (pure holding/redeem accounts — verified these appear
 * on DAY/WEEK boards). The top `enrichTop` wallets by pnl get a settled
 * track-record enrichment via /closed-positions (walletStats, cached 24h);
 * beyond that the mark-to-market leaderboard pnl seeds the score alone.
 * Manual whitelist flags (is_whitelist=1) survive re-seeding.
 */
export async function seedSmartWallets(
  db: DB,
  opts: {
    periods?: LeaderboardPeriod[];
    perPeriod?: number;
    enrichTop?: number;
    fetchBoard?: typeof fetchLeaderboard;
    statsFetcher?: (w: string) => Promise<WalletStats>;
    nowSec?: number;
  } = {},
): Promise<SeedResult> {
  const {
    periods = ["WEEK", "MONTH", "ALL"],
    perPeriod = 100,
    enrichTop = 100,
    fetchBoard = fetchLeaderboard,
    statsFetcher,
    nowSec = Math.floor(Date.now() / 1000),
  } = opts;

  // Merge the boards; a wallet on several boards keeps its best showing.
  const merged = new Map<string, { pnl: number; vol: number }>();
  for (const period of periods) {
    let rows: LeaderboardRow[];
    try {
      rows = await fetchBoard({
        period,
        orderBy: "PNL",
        maxEntries: perPeriod,
      });
    } catch (e) {
      console.warn(`[smartWallets] leaderboard ${period} failed:`, e);
      continue; // partial seeding beats no seeding
    }
    for (const r of rows) {
      if (r.vol <= 0) continue; // holding/redeem-only accounts carry no signal
      const wallet = r.proxyWallet.toLowerCase(); // defensive; don't rely on the fetcher
      const prev = merged.get(wallet);
      merged.set(wallet, {
        pnl: Math.max(prev?.pnl ?? -Infinity, r.pnl),
        vol: Math.max(prev?.vol ?? 0, r.vol),
      });
    }
  }
  if (merged.size === 0) return { seeded: 0, enriched: 0 };

  // Settled-record enrichment for the biggest earners (bounded upstream cost;
  // getWalletStats caches per-wallet for a day so re-seeds are nearly free).
  const byPnl = [...merged.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
  const enrichWallets = byPnl.slice(0, enrichTop).map(([w]) => w);
  const stats = await getWalletStats(db, enrichWallets, {
    concurrency: 3,
    ...(statsFetcher ? { fetcher: statsFetcher } : {}),
    nowSec,
  });

  const upsert = db.prepare(
    `INSERT INTO smart_wallets (address, score, realized_pnl, win_rate, roi, volume, consistency, is_whitelist, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)
     ON CONFLICT(address) DO UPDATE SET
       score = excluded.score,
       realized_pnl = excluded.realized_pnl,
       win_rate = excluded.win_rate,
       roi = excluded.roi,
       volume = excluded.volume,
       updated_at = excluded.updated_at`,
  );
  let enriched = 0;
  const tx = db.transaction(() => {
    for (const [wallet, lb] of merged) {
      const s = stats[wallet] ?? null;
      if (s) enriched++;
      // Prefer the settled realizedPnl when we have it; the leaderboard's
      // mark-to-market pnl is only the fallback.
      const pnl = s ? s.realizedPnl : lb.pnl;
      const score = computeScore({
        pnl,
        vol: lb.vol,
        winRate: s?.winRate ?? null,
      });
      upsert.run(
        wallet,
        score,
        pnl,
        s?.winRate ?? null,
        s?.roi ?? null,
        lb.vol,
        nowSec,
      );
    }
    // Retention: auto-seeded wallets that haven't re-appeared on any board for
    // 30 days (a full MONTH-board cycle) age out — otherwise the pool only
    // grows and stale frozen scores dilute smartOnly/consensus. Runs only on a
    // successful seed (merged non-empty), so an API outage never mass-deletes.
    // Manual whitelist rows (is_whitelist=1) are permanent.
    db.prepare(
      "DELETE FROM smart_wallets WHERE is_whitelist = 0 AND (updated_at IS NULL OR updated_at < ?)",
    ).run(nowSec - STALE_AFTER_SEC);
  });
  tx();
  return { seeded: merged.size, enriched };
}

const STALE_AFTER_SEC = 30 * 86_400;

const SEED_DAY_KEY = "smart_seed_last_day";

const utcDay = (nowSec: number) =>
  new Date(nowSec * 1000).toISOString().slice(0, 10);

/**
 * Day-gated seeding: returns the seeding promise on the first call of a UTC
 * day, null otherwise. The day marker is written BEFORE the async work starts
 * so overlapping poll cycles can't double-trigger; a failed seed logs and
 * retries the next day (a one-day-stale seed pool is acceptable).
 */
export function maybeDailySeed(
  db: DB,
  opts: Parameters<typeof seedSmartWallets>[1] = {},
): Promise<SeedResult> | null {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const today = utcDay(nowSec);
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(SEED_DAY_KEY) as { value: string | null } | undefined;
  if (row?.value === today) return null;
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    SEED_DAY_KEY,
    today,
  );
  return seedSmartWallets(db, { ...opts, nowSec });
}

// Sync lookup for the alert engine / API routes: wallet(lowercased) -> tag.
export function getSmartTags(
  db: DB,
  wallets: string[],
): Record<string, SmartTag> {
  const distinct = [...new Set(wallets.map((w) => w.toLowerCase()))];
  if (distinct.length === 0) return {};
  const placeholders = distinct.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT address, score, win_rate, realized_pnl, is_whitelist
       FROM smart_wallets WHERE address IN (${placeholders})`,
    )
    .all(...distinct) as {
    address: string;
    score: number | null;
    win_rate: number | null;
    realized_pnl: number | null;
    is_whitelist: number;
  }[];
  const out: Record<string, SmartTag> = {};
  for (const r of rows) {
    out[r.address] = {
      score: r.score,
      winRate: r.win_rate,
      realizedPnl: r.realized_pnl,
      isWhitelist: !!r.is_whitelist,
    };
  }
  return out;
}

// Full smart-wallet map (address -> tag) for consensus detection over a trade
// window. Table stays small (hundreds of rows), so loading it whole is cheap.
export function getAllSmartTags(db: DB): Map<string, SmartTag> {
  const rows = db
    .prepare(
      "SELECT address, score, win_rate, realized_pnl, is_whitelist FROM smart_wallets",
    )
    .all() as {
    address: string;
    score: number | null;
    win_rate: number | null;
    realized_pnl: number | null;
    is_whitelist: number;
  }[];
  const out = new Map<string, SmartTag>();
  for (const r of rows) {
    out.set(r.address, {
      score: r.score,
      winRate: r.win_rate,
      realizedPnl: r.realized_pnl,
      isWhitelist: !!r.is_whitelist,
    });
  }
  return out;
}
