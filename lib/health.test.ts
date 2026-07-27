import { describe, expect, it } from "vitest";
import type { LoopHealth } from "./heartbeat";
import {
  DEFAULT_STALE_AFTER_SEC,
  evaluateHealth,
  LOOP_STALE_AFTER_SEC,
} from "./health";

const NOW = 1_785_200_000;

function beatRow(loop: string, ageSec: number): LoopHealth {
  return {
    loop,
    lastTs: NOW - ageSec,
    day: "2026-07-27",
    cycles: 100,
    maxGapSec: 10,
  };
}

describe("evaluateHealth", () => {
  it("all loops fresh → ok with no stale loops", () => {
    const r = evaluateHealth(
      [
        beatRow("alert", 5),
        beatRow("consensus", 60),
        beatRow("outcome_backfill", 300),
      ],
      NOW,
    );
    expect(r.ok).toBe(true);
    expect(r.staleLoops).toEqual([]);
    expect(r.loops).toHaveLength(3);
  });

  it("one stale loop → not ok, names the loop, others unaffected", () => {
    const r = evaluateHealth(
      [
        beatRow("alert", LOOP_STALE_AFTER_SEC.alert + 1),
        beatRow("consensus", 60),
      ],
      NOW,
    );
    expect(r.ok).toBe(false);
    expect(r.staleLoops).toEqual(["alert"]);
    expect(r.loops.find((l) => l.loop === "consensus")!.stale).toBe(false);
  });

  it("exactly at the threshold is still fresh (strict >)", () => {
    const r = evaluateHealth(
      [beatRow("alert", LOOP_STALE_AFTER_SEC.alert)],
      NOW,
    );
    expect(r.ok).toBe(true);
  });

  it("no heartbeat rows at all → not ok with an explicit reason", () => {
    const r = evaluateHealth([], NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("never run");
  });

  it("unknown loops fall back to the default threshold", () => {
    const fresh = evaluateHealth(
      [beatRow("future_loop", DEFAULT_STALE_AFTER_SEC)],
      NOW,
    );
    expect(fresh.ok).toBe(true);
    const stale = evaluateHealth(
      [beatRow("future_loop", DEFAULT_STALE_AFTER_SEC + 1)],
      NOW,
    );
    expect(stale.ok).toBe(false);
    expect(stale.staleLoops).toEqual(["future_loop"]);
  });

  it("clock skew (beat in the future) reads as age 0, never negative", () => {
    const r = evaluateHealth([beatRow("alert", -30)], NOW);
    expect(r.loops[0].ageSec).toBe(0);
    expect(r.ok).toBe(true);
  });

  describe("expected-but-never-beaten loops", () => {
    // beat() only runs after a SUCCESSFUL cycle, so a loop that throws every
    // pass writes no row at all. Judging only the rows that exist would rate
    // the most complete failure as perfectly healthy.
    it("a known loop with no row is stale once its threshold has passed since start", () => {
      const startedAt = NOW - (LOOP_STALE_AFTER_SEC.consensus + 1);
      const r = evaluateHealth([beatRow("alert", 5)], NOW, startedAt);
      expect(r.ok).toBe(false);
      expect(r.staleLoops).toContain("consensus");
      expect(r.loops.find((l) => l.loop === "consensus")).toMatchObject({
        lastTs: null,
        missing: true,
      });
    });

    it("stays healthy during the startup grace period", () => {
      // 60s in: consensus (first pass at 30s) and outcome_backfill (90s) may
      // legitimately have no row yet.
      const r = evaluateHealth([beatRow("alert", 5)], NOW, NOW - 60);
      expect(r.ok).toBe(true);
      expect(r.staleLoops).toEqual([]);
    });

    it("without a known start time, absent loops are not judged (back-compat)", () => {
      const r = evaluateHealth([beatRow("alert", 5)], NOW);
      expect(r.ok).toBe(true);
      expect(r.loops).toHaveLength(1);
    });

    it("each absent loop uses its own threshold", () => {
      // Past alert's 5min but inside consensus's 20min: only alert is stale.
      const startedAt = NOW - (LOOP_STALE_AFTER_SEC.alert + 1);
      const r = evaluateHealth([beatRow("consensus", 5)], NOW, startedAt);
      expect(r.staleLoops).toEqual(["alert"]);
    });
  });
});
