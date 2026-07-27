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
};
export const DEFAULT_STALE_AFTER_SEC = 60 * 60;

export interface LoopStatus {
  loop: string;
  /** null = this expected loop has never beaten (it may never have started). */
  lastTs: number | null;
  ageSec: number | null;
  staleAfterSec: number;
  stale: boolean;
  missing?: true;
}

export interface HealthReport {
  ok: boolean;
  nowSec: number;
  loops: LoopStatus[];
  staleLoops: string[];
  reason?: string;
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
    };
  });
  if (startedAtSec != null) {
    const upSec = Math.max(0, nowSec - startedAtSec);
    const seen = new Set(beats.map((b) => b.loop));
    for (const [loop, staleAfterSec] of Object.entries(LOOP_STALE_AFTER_SEC)) {
      if (seen.has(loop)) continue;
      loops.push({
        loop,
        lastTs: null,
        ageSec: null,
        staleAfterSec,
        // Within the grace period a loop that simply hasn't had its first
        // pass yet (consensus starts at 30s, backfill at 90s) is not a fault.
        stale: upSec > staleAfterSec,
        missing: true,
      });
    }
  }
  const staleLoops = loops.filter((l) => l.stale).map((l) => l.loop);
  return { ok: staleLoops.length === 0, nowSec, loops, staleLoops };
}
