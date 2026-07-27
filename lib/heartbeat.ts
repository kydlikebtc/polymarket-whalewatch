import type { DB } from "./db";

// Engine liveness heartbeat (server-first deployment). The engine's failure
// mode is SILENT — a dead loop just stops writing rows, and "no signals" looks
// identical to "no whales today". Every loop beats here each cycle; a daily
// Telegram self-check turns the absence of a beat into a visible fact:
// cycles-per-loop, alerts fired, and the longest within-day gap (a restart or
// stall shows up as a gap even though nothing errored). This is the minimum
// "prove you were alive" layer under any latency/uptime claim the public
// channel will ever make.

export interface LoopHealth {
  loop: string;
  lastTs: number;
  day: string; // UTC yyyy-mm-dd the counters belong to
  cycles: number;
  maxGapSec: number;
}

const utcDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

/** One cycle completed for `loop` — call at the end of each engine cycle. */
export function beat(
  db: DB,
  loop: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): void {
  const prev = db
    .prepare(
      "SELECT last_ts, day, cycles, max_gap_sec FROM heartbeats WHERE loop = ?",
    )
    .get(loop) as
    | { last_ts: number; day: string; cycles: number; max_gap_sec: number }
    | undefined;
  const day = utcDay(nowSec);
  if (!prev || prev.day !== day) {
    // New day (or first beat ever): fresh counters. The overnight gap is NOT
    // charged to the new day — max_gap_sec answers "how long did today's
    // loop stall", not "when did yesterday end".
    db.prepare(
      `INSERT OR REPLACE INTO heartbeats (loop, last_ts, day, cycles, max_gap_sec)
       VALUES (?, ?, ?, 1, 0)`,
    ).run(loop, nowSec, day);
    return;
  }
  const gap = nowSec - prev.last_ts;
  db.prepare(
    `UPDATE heartbeats SET last_ts = ?, cycles = cycles + 1, max_gap_sec = MAX(max_gap_sec, ?)
     WHERE loop = ?`,
  ).run(nowSec, gap, loop);
}

export function getHeartbeats(db: DB): LoopHealth[] {
  return (
    db
      .prepare(
        "SELECT loop, last_ts, day, cycles, max_gap_sec FROM heartbeats ORDER BY loop",
      )
      .all() as {
      loop: string;
      last_ts: number;
      day: string;
      cycles: number;
      max_gap_sec: number;
    }[]
  ).map((r) => ({
    loop: r.loop,
    lastTs: r.last_ts,
    day: r.day,
    cycles: r.cycles,
    maxGapSec: r.max_gap_sec,
  }));
}

const SELFCHECK_DAY_KEY = "heartbeat_selfcheck_last_day";
const ENGINE_STARTED_KEY = "engine_started_at";

/** Record this engine process's start time (drives health's grace period). */
export function markEngineStart(
  db: DB,
  nowSec: number = Math.floor(Date.now() / 1000),
): void {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    ENGINE_STARTED_KEY,
    String(nowSec),
  );
}

/** Engine start time, or null if no engine has ever run against this db. */
export function getEngineStart(db: DB): number | null {
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(ENGINE_STARTED_KEY) as { value: string | null } | undefined;
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Once per UTC day, push a liveness digest through the (health-wrapped) send.
 * Without a configured Telegram send this is a no-op that does NOT consume the
 * day — configuring credentials mid-day still gets that day's digest.
 */
export async function maybeDailySelfCheck(
  db: DB,
  send: ((html: string) => Promise<void>) | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
  opts: { publicUrl?: string } = {},
): Promise<void> {
  if (!send) return;
  const day = utcDay(nowSec);
  const last = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(SELFCHECK_DAY_KEY) as { value: string | null } | undefined;
  if (last?.value === day) return;
  const beats = getHeartbeats(db);
  const alerts24h = (
    db
      .prepare("SELECT COUNT(*) AS n FROM alerts WHERE created_at >= ?")
      .get(nowSec - 86_400) as { n: number }
  ).n;
  const maxGap = beats.reduce((m, b) => Math.max(m, b.maxGapSec), 0);
  const loops = beats.map((b) => `${b.loop} ${b.cycles} 轮`).join(" · ");
  const html =
    `🩺 监控自检 · 过去 24h\n` +
    `${loops || "无循环心跳(引擎未运行?)"}\n` +
    `告警 ${alerts24h} 条 · 循环最长间隔 ${Math.round(maxGap / 60)} 分钟` +
    (opts.publicUrl
      ? `\n\n🔗 <a href="${opts.publicUrl}/discovery">看板 · 信号密度</a>`
      : "");
  // Mark BEFORE sending (mirrors the seed's claim-first pattern): a transient
  // send failure costs one digest, never a duplicate storm.
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    SELFCHECK_DAY_KEY,
    day,
  );
  await send(html);
}
