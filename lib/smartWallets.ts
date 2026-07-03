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

// Survivorship haircut on the win-rate axis: positions ridden to zero never
// reach /closed-positions (verified live: a "100% · +$56.6M" wallet hid 39
// zeroed positions worth -$1.46M — true rate 91.1%), so a FLAWLESS settled
// record is an upper bound, not a measurement. A truncated record (page cap
// hit) only covers the newest positions and inherits the same doubt.
const WIN_RATE_SURVIVORSHIP_DISCOUNT = 0.9;

/**
 * Composite 0-100 smart-money score. Heuristic, deliberately explainable:
 *  - up to 40 pts for absolute profit ($1m+ saturates)
 *  - up to 30 pts for capital efficiency (10%+ saturates) — this is the axis
 *    that separates informed money from high-volume market makers. Prefers the
 *    settled `roi` (realizedPnl/costBasis, numerator and denominator on the
 *    SAME basis) when the wallet is enriched; falls back to the leaderboard's
 *    paired pnl/vol row otherwise.
 *  - up to 30 pts for settled win rate (unknown treated as a neutral 0.5);
 *    a perfect (100%) or truncated record is discounted for survivorship bias
 *    (see WIN_RATE_SURVIVORSHIP_DISCOUNT) — win rates only count SETTLED
 *    positions, so "ride it to zero" wallets systematically overstate theirs.
 * Weights are config-free v1 seeds; the validation loop can calibrate later.
 */
export function computeScore(input: {
  pnl: number;
  vol: number;
  winRate: number | null;
  roi?: number | null;
  truncated?: boolean;
}): number {
  const pnlNorm = Math.min(1, Math.max(0, input.pnl) / 1_000_000);
  const effRatio =
    input.roi != null ? input.roi : input.vol > 0 ? input.pnl / input.vol : 0;
  const eff = Math.min(1, Math.max(0, effRatio) / 0.1);
  let wr = input.winRate ?? 0.5;
  if (input.winRate != null && (input.winRate >= 1 || input.truncated)) {
    wr *= WIN_RATE_SURVIVORSHIP_DISCOUNT;
  }
  return Math.round(40 * pnlNorm + 30 * eff + 30 * wr);
}

export interface SeedResult {
  seeded: number;
  enriched: number;
}

/**
 * Seed/refresh the smart_wallets table from the official profit leaderboards.
 * Boards are merged per wallet keeping the WHOLE row from the wallet's
 * best-pnl board (pnl and its paired vol — mixing maxima across boards would
 * make the efficiency ratio meaningless). vol=0 rows are dropped (pure
 * holding/redeem accounts — verified these appear on DAY/WEEK boards).
 * By default EVERY merged wallet gets a settled track-record enrichment via
 * /closed-positions (walletStats, cached 24h, concurrency-capped) — an
 * un-enriched wallet scores with a neutral 0.5 win rate on mark-to-market pnl
 * alone, which let unrealized-gain whales into the pool at 85+; `enrichTop`
 * can still bound the enrichment for tests. Manual whitelist flags
 * (is_whitelist=1) survive re-seeding.
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
    // Whole merged pool (~300 wallets across three 100-row boards): the 24h
    // walletStats cache + concurrency 3 keep the daily incremental cost well
    // inside the ~150req/10s budget.
    enrichTop = Number.POSITIVE_INFINITY,
    fetchBoard = fetchLeaderboard,
    statsFetcher,
    nowSec = Math.floor(Date.now() / 1000),
  } = opts;

  // Merge the boards; a wallet on several boards keeps its best-pnl ROW.
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
      // PAIRED semantics: take pnl AND vol from the same (best-pnl) board.
      // Independently maxing pnl and vol across boards (old behavior) could
      // pair an ALL-board pnl with a WEEK-board vol — a ratio of nothing.
      if (!prev || r.pnl > prev.pnl) {
        merged.set(wallet, { pnl: r.pnl, vol: r.vol });
      }
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
        // Enriched wallets score the efficiency axis on the settled roi
        // already computed by walletStats (consistent numerator/denominator);
        // computeScore falls back to the paired lb pnl/vol when roi is null.
        roi: s?.roi ?? null,
        truncated: s?.truncated ?? false,
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
  // Coverage matters: an un-enriched wallet scores with a NEUTRAL 0.5 win rate
  // on mark-to-market pnl, so low coverage silently dilutes the pool with
  // unrealized-gain whales. Log the ratio so a regression (e.g. walletStats
  // failures shrinking coverage) is visible straight from the seed logs.
  console.log(
    `[smartWallets] seeded ${merged.size} wallets · enrichment coverage ${enriched}/${merged.size}` +
      ` (${Math.round((enriched / merged.size) * 100)}%)`,
  );
  return { seeded: merged.size, enriched };
}

const STALE_AFTER_SEC = 30 * 86_400;

const SEED_DAY_KEY = "smart_seed_last_day";

const utcDay = (nowSec: number) =>
  new Date(nowSec * 1000).toISOString().slice(0, 10);

// Failed seeds retry WITHIN the day (bounded): a transient data-api outage at
// the daily trigger must not leave the whitelist stale — or EMPTY on a fresh
// install, where every consensus cycle then no-ops until the next UTC day.
const SEED_RETRY_DELAY_SEC = 15 * 60;
const SEED_MAX_ATTEMPTS_PER_DAY = 4; // initial try + 3 retries

// Marker stored under SEED_DAY_KEY. A plain "YYYY-MM-DD" value (also the
// legacy format) means the day's seed is claimed/succeeded; the JSON form
// records a failure and when a retry becomes allowed.
type SeedMarker = { day: string; failedAttempts: number; nextRetryTs: number };

function parseSeedMarker(value: string | null | undefined): SeedMarker | null {
  if (!value) return null;
  if (!value.startsWith("{")) {
    return { day: value, failedAttempts: 0, nextRetryTs: 0 };
  }
  try {
    const p = JSON.parse(value) as Partial<SeedMarker>;
    if (typeof p.day !== "string") return null;
    return {
      day: p.day,
      failedAttempts:
        typeof p.failedAttempts === "number" ? p.failedAttempts : 0,
      nextRetryTs: typeof p.nextRetryTs === "number" ? p.nextRetryTs : 0,
    };
  } catch {
    return null; // unparseable marker — treat as absent and re-seed
  }
}

// In-process guard so a retry-eligible marker (or a UTC day rollover) can't
// start a second seed while one is still running.
let seedInFlight = false;

/**
 * Day-gated seeding: returns the seeding promise when a seed should run now,
 * null otherwise. The day marker is written BEFORE the async work starts —
 * this ordering is deliberate and must NOT move into a .then(): seeding takes
 * minutes (per-wallet /closed-positions enrichment) while the poll loop calls
 * this every ~4s, so a post-hoc marker would re-trigger the seed dozens of
 * times in parallel. The failure path (thrown error, or all boards down →
 * seeded 0) rewrites the marker with a retry timestamp instead of consuming
 * the day: retries are allowed after SEED_RETRY_DELAY_SEC, capped at
 * SEED_MAX_ATTEMPTS_PER_DAY per UTC day. Known tradeoff: a crash between
 * claim and failure-rewrite still consumes the day.
 */
export function maybeDailySeed(
  db: DB,
  opts: Parameters<typeof seedSmartWallets>[1] = {},
): Promise<SeedResult> | null {
  if (seedInFlight) return null;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const today = utcDay(nowSec);
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(SEED_DAY_KEY) as { value: string | null } | undefined;
  const marker = parseSeedMarker(row?.value);
  let priorFailures = 0;
  if (marker?.day === today) {
    if (marker.failedAttempts === 0) return null; // claimed/succeeded today
    if (marker.failedAttempts >= SEED_MAX_ATTEMPTS_PER_DAY) return null;
    if (nowSec < marker.nextRetryTs) return null; // retry window not open yet
    priorFailures = marker.failedAttempts;
    console.log(
      `[smartWallets] retrying failed seed (attempt ${priorFailures + 1}/${SEED_MAX_ATTEMPTS_PER_DAY} today)`,
    );
  }
  const writeMarker = (value: string) =>
    db
      .prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)")
      .run(SEED_DAY_KEY, value);
  // Claim first (see docstring); success keeps this plain-day marker.
  writeMarker(today);
  const recordFailure = (reason: string) => {
    const attempt = priorFailures + 1;
    writeMarker(
      JSON.stringify({
        day: today,
        failedAttempts: attempt,
        nextRetryTs: nowSec + SEED_RETRY_DELAY_SEC,
      } satisfies SeedMarker),
    );
    console.warn(
      `[smartWallets] seed failed (attempt ${attempt}/${SEED_MAX_ATTEMPTS_PER_DAY} today): ${reason} — ` +
        (attempt >= SEED_MAX_ATTEMPTS_PER_DAY
          ? "giving up until the next UTC day"
          : `retry allowed in ${SEED_RETRY_DELAY_SEC / 60} min`),
    );
  };
  seedInFlight = true;
  return seedSmartWallets(db, { ...opts, nowSec })
    .then((r) => {
      if (r.seeded === 0) {
        // Every board failed/empty (per-board warns already logged): nothing
        // was written, so don't consume the day marker.
        recordFailure("all leaderboards empty or failed");
      }
      return r;
    })
    .catch((e) => {
      recordFailure(String(e));
      throw e; // callers keep their own failure logging
    })
    .finally(() => {
      seedInFlight = false;
    });
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

// Pool-status snapshot for the dashboard's smartOnly feedback: whitelist size
// plus the last-24h 🏆 alert count. Each count degrades to null INDEPENDENTLY
// (the alerts page opens a readonly db that may predate either table) so the
// alerts feed itself never breaks over a missing counter.
export interface SmartPoolStatus {
  smartWalletCount: number | null;
  smartAlerts24h: number | null;
}

export function getSmartPoolStatus(
  db: DB,
  nowSec: number = Math.floor(Date.now() / 1000),
): SmartPoolStatus {
  let smartWalletCount: number | null = null;
  try {
    smartWalletCount = (
      db.prepare("SELECT COUNT(*) AS n FROM smart_wallets").get() as {
        n: number;
      }
    ).n;
  } catch (e) {
    console.warn("[smartWallets] pool-status wallet count failed:", e);
  }
  let smartAlerts24h: number | null = null;
  try {
    smartAlerts24h = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM alerts WHERE type = 'smart' AND created_at >= ?",
        )
        .get(nowSec - 86_400) as { n: number }
    ).n;
  } catch (e) {
    console.warn("[smartWallets] pool-status 24h alert count failed:", e);
  }
  return { smartWalletCount, smartAlerts24h };
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
