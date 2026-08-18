import type { LoopHealth } from "./heartbeat";

// Engine liveness evaluation over the heartbeats table. The daily 🩺 digest
// proves the engine WAS alive; this answers "is it alive RIGHT NOW" for two
// consumers that must work while the engine is dead:
//   - GET /api/health → 503 lets any external prober (uptime service, docker
//     healthcheck, host cron) see a stalled engine without parsing logs;
//   - the in-engine dead-man's-switch SKIPS its outbound ping when a loop is
//     stale, so the ping service's "no ping" alarm fires for hangs too — not
//     just full process death.
// Thresholds are generous multiples of each loop's cadence so one slow
// upstream sweep never flaps the endpoint.

export const LOOP_STALE_AFTER_SEC: Record<string, number> = {
  alert: 5 * 60, // 4s cadence
  consensus: 20 * 60, // 5min cadence, one deep-window sweep can run long
  outcome_backfill: 35 * 60, // 10min cadence
  delivery: 10 * 60, // 30s cadence(对外信号投递,批次 1)
};
export const DEFAULT_STALE_AFTER_SEC = 60 * 60;

// 条件循环:只在其通道配置齐全时才启动(delivery 需要 Telegram 凭证)。
// records-only 部署里它们从不 beat —— 这是配置形态不是故障,expected-but-
// absent 判定必须跳过它们,否则无 TG 凭证的安装会永远 /api/health 503。
// 一旦 beat 过,停跳staleness照常按上表阈值判定。
export const CONDITIONAL_LOOPS: ReadonlySet<string> = new Set(["delivery"]);

export interface LoopStatus {
  loop: string;
  /** null = this expected loop has never beaten (it may never have started). */
  lastTs: number | null;
  ageSec: number | null;
  staleAfterSec: number;
  stale: boolean;
  missing?: true;
  /**
   * 今日(UTC)完成的循环轮次。additive 字段(2026-08-18,公开状态页 /status)。
   * 一个只有绿点的状态页说不出「它在干活」和「它刚好还没超时」的区别 ——
   * 轮次是那个区别。missing 循环恒 0。
   */
  cycles: number;
  /**
   * 今日(UTC)最长的一次循环间隔(秒)。绿点看当下,这个看这一天里有没有
   * 卡顿过 —— 恢复了的停顿在 lastTs 上不留痕迹,只在这里。missing 循环恒 0。
   */
  maxGapSec: number;
}

export interface HealthReport {
  ok: boolean;
  nowSec: number;
  loops: LoopStatus[];
  staleLoops: string[];
  reason?: string;
  /**
   * 本次引擎进程的启动时刻,null = 从未有引擎跑过这个库。
   * additive 字段(2026-08-18,公开状态页 /status):此前只有运营页能看到
   * 运行时长(走 ADMIN_TOKEN 的 ops 概览),而「跑了多久」正是状态页第一个
   * 该回答的问题,不该是运营专属。
   */
  startedAt: number | null;
}

/**
 * @param startedAtSec when this engine process started (config
 * `engine_started_at`). Needed to judge a loop that has NEVER beaten: beat()
 * only runs at the end of a successful cycle, so a loop that throws on every
 * pass never writes a row at all — with only "rows present" to go on, the
 * most complete failure would read as perfectly healthy. Past its own
 * threshold since startup, an expected-but-absent loop is stale.
 */
export function evaluateHealth(
  beats: LoopHealth[],
  nowSec: number,
  startedAtSec?: number | null,
): HealthReport {
  if (beats.length === 0) {
    return {
      ok: false,
      nowSec,
      loops: [],
      staleLoops: [],
      reason: "no heartbeats recorded — engine has never run against this db",
      startedAt: startedAtSec ?? null,
    };
  }
  const loops: LoopStatus[] = beats.map((b) => {
    const staleAfterSec =
      LOOP_STALE_AFTER_SEC[b.loop] ?? DEFAULT_STALE_AFTER_SEC;
    const ageSec = Math.max(0, nowSec - b.lastTs);
    return {
      loop: b.loop,
      lastTs: b.lastTs,
      ageSec,
      staleAfterSec,
      stale: ageSec > staleAfterSec,
      cycles: b.cycles,
      maxGapSec: b.maxGapSec,
    };
  });
  if (startedAtSec != null) {
    const upSec = Math.max(0, nowSec - startedAtSec);
    const seen = new Set(beats.map((b) => b.loop));
    for (const [loop, staleAfterSec] of Object.entries(LOOP_STALE_AFTER_SEC)) {
      if (seen.has(loop)) continue;
      // 条件循环缺席 ≠ 故障(通道未配置的部署根本不会启动它)。
      if (CONDITIONAL_LOOPS.has(loop)) continue;
      loops.push({
        loop,
        lastTs: null,
        ageSec: null,
        staleAfterSec,
        // Within the grace period a loop that simply hasn't had its first
        // pass yet (consensus starts at 30s, backfill at 90s) is not a fault.
        stale: upSec > staleAfterSec,
        missing: true,
        cycles: 0,
        maxGapSec: 0,
      });
    }
  }
  const staleLoops = loops.filter((l) => l.stale).map((l) => l.loop);
  return {
    ok: staleLoops.length === 0,
    nowSec,
    loops,
    staleLoops,
    startedAt: startedAtSec ?? null,
  };
}
