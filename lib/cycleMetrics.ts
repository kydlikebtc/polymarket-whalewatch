import type { DB } from "./db";

// Signal-density instrumentation (P0.9). Every consensus cycle records its
// aggregate decision metadata — window size, raw groups, mutex drops, pushes.
// This is the ONLY dial that can distinguish "market heat collapsed" from
// "thresholds drifted out of tune": every qualification floor (2 wallets /
// $5k / 6h …) silently assumes the current volume regime, and when the
// prediction-market cycle turns (the PolyPick failure mode), signals dry up
// with no error anywhere. Aggregate metadata only — no raw trade rows land
// here, the query-only red line stands.

export interface ConsensusCycleMetric {
  ts: number;
  windowTrades: number;
  windowUsd: number;
  rawGroups: number; // detectConsensus output BEFORE the disagreement mutex
  contestedDropped: number;
  fired: number;
}

export function recordConsensusCycle(db: DB, m: ConsensusCycleMetric): void {
  db.prepare(
    `INSERT INTO cycle_metrics
       (loop, ts, window_trades, window_usd, raw_groups, contested_dropped, fired)
     VALUES ('consensus', ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.ts,
    m.windowTrades,
    m.windowUsd,
    m.rawGroups,
    m.contestedDropped,
    m.fired,
  );
}

export interface DailyDensity {
  day: string; // UTC yyyy-mm-dd
  cycles: number;
  avgWindowTrades: number;
  avgWindowUsd: number;
  rawGroups: number;
  contestedDropped: number;
  fired: number;
  // fired per $1M of AVERAGE window volume. The 6h window rolls every 5min,
  // so summing per-cycle volume would double-count massively; the day's mean
  // window volume is the honest heat proxy, and fired ÷ that mean is
  // comparable across days — a falling perM under stable heat means the
  // thresholds drifted, falling heat with stable perM means the market cooled.
  perM: number;
}

export function dailyDensity(
  db: DB,
  opts: { days?: number; nowSec?: number } = {},
): DailyDensity[] {
  const { days = 14, nowSec = Math.floor(Date.now() / 1000) } = opts;
  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', ts, 'unixepoch') AS day,
              COUNT(*) AS cycles,
              AVG(window_trades) AS avg_trades,
              AVG(window_usd) AS avg_usd,
              SUM(raw_groups) AS raw_groups,
              SUM(contested_dropped) AS contested_dropped,
              SUM(fired) AS fired
       FROM cycle_metrics
       WHERE loop = 'consensus' AND ts >= ?
       GROUP BY day
       ORDER BY day DESC`,
    )
    .all(nowSec - days * 86_400) as {
    day: string;
    cycles: number;
    avg_trades: number;
    avg_usd: number;
    raw_groups: number;
    contested_dropped: number;
    fired: number;
  }[];
  return rows.map((r) => ({
    day: r.day,
    cycles: r.cycles,
    avgWindowTrades: r.avg_trades,
    avgWindowUsd: r.avg_usd,
    rawGroups: r.raw_groups,
    contestedDropped: r.contested_dropped,
    fired: r.fired,
    perM: r.avg_usd > 0 ? r.fired / (r.avg_usd / 1_000_000) : 0,
  }));
}
