import { describe, it, expect } from "vitest";
import {
  OUTCOME_EPSILON,
  directionVerdict,
  settleWon,
  wilsonInterval,
  summarizeOutcomes,
} from "./outcomeStats";

describe("settleWon", () => {
  it("judges by P&L direction vs the fill price, not a fixed 0.5 divider", () => {
    // The headline bug: BUY@0.9 settling 0.6 is a real 0.3/share LOSS.
    expect(settleWon("BUY", 0.9, 0.6)).toBe(false);
    // …and BUY@0.3 settling 0.45 is a real profit.
    expect(settleWon("BUY", 0.3, 0.45)).toBe(true);
    // SELL mirrors both.
    expect(settleWon("SELL", 0.9, 0.6)).toBe(true);
    expect(settleWon("SELL", 0.3, 0.45)).toBe(false);
  });

  it("matches the old rule on standard 0/1 settlements", () => {
    expect(settleWon("BUY", 0.6, 1)).toBe(true);
    expect(settleWon("BUY", 0.6, 0)).toBe(false);
    expect(settleWon("SELL", 0.6, 0)).toBe(true);
    expect(settleWon("SELL", 0.6, 1)).toBe(false);
  });

  it("returns null (push) for ≈50/50 rulings and settles within ε of the fill", () => {
    // Cancelled event / draw ruling: both sides refunded at 0.5.
    expect(settleWon("BUY", 0.9, 0.5)).toBeNull();
    expect(settleWon("SELL", 0.1, 0.5)).toBeNull();
    // Settle inside the deadband around the fill: P&L noise, not a verdict.
    expect(settleWon("BUY", 0.6, 0.6 + OUTCOME_EPSILON / 2)).toBeNull();
    expect(settleWon("SELL", 0.6, 0.6 - OUTCOME_EPSILON / 2)).toBeNull();
  });
});

describe("directionVerdict", () => {
  it("BUY hits on a rise, SELL hits on a fall", () => {
    expect(directionVerdict("BUY", 0.5, 0.56)).toBe("hit");
    expect(directionVerdict("BUY", 0.5, 0.44)).toBe("miss");
    expect(directionVerdict("SELL", 0.5, 0.44)).toBe("hit");
    expect(directionVerdict("SELL", 0.5, 0.56)).toBe("miss");
  });

  it("moves inside the ε deadband are pushes, not hits or misses", () => {
    expect(directionVerdict("BUY", 0.5, 0.5 + OUTCOME_EPSILON / 2)).toBe(
      "push",
    );
    expect(directionVerdict("SELL", 0.5, 0.5 - OUTCOME_EPSILON / 2)).toBe(
      "push",
    );
    // Exactly at the boundary counts (strict inequality inside).
    expect(directionVerdict("BUY", 0.5, 0.5 + OUTCOME_EPSILON)).toBe("hit");
  });
});

describe("wilsonInterval", () => {
  it("exposes how unreliable a small sample really is (2/3 ≈ 21%–94%)", () => {
    const { lo, hi } = wilsonInterval(2, 3);
    expect(lo).toBeCloseTo(0.208, 2);
    expect(hi).toBeCloseTo(0.939, 2);
  });

  it("tightens with sample size and stays clamped to [0, 1]", () => {
    const small = wilsonInterval(2, 3);
    const big = wilsonInterval(67, 100);
    expect(big.hi - big.lo).toBeLessThan(small.hi - small.lo);
    expect(wilsonInterval(0, 10).lo).toBeGreaterThanOrEqual(0);
    expect(wilsonInterval(10, 10).hi).toBeLessThanOrEqual(1);
  });

  it("degrades to the trivial [0,1] interval on an empty sample", () => {
    expect(wilsonInterval(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
});

describe("summarizeOutcomes", () => {
  const alerts = [
    { id: 1, type: "large", side: "BUY", price: 0.5 },
    { id: 2, type: "smart", side: "SELL", price: 0.5 },
    { id: 3, type: "consensus", side: "BUY", price: 0.4 },
    { id: 4, type: "large", side: "BUY", price: 0.5 },
    { id: 5, type: "large", side: "BUY", price: 0.5 }, // no outcome yet
  ];
  const outcomes = {
    // 1h hit, 24h hit, settled win.
    1: { price1h: 0.56, price24h: 0.6, resolved: true, won: true },
    // SELL that rose: 1h miss; settled loss.
    2: { price1h: 0.6, price24h: null, resolved: true, won: false },
    // 1h inside the deadband (push → excluded), 24h hit; unresolved.
    3: { price1h: 0.401, price24h: 0.5, resolved: false, won: null },
    // Settled push (won=null) stays out of the win-rate entirely.
    4: { price1h: null, price24h: null, resolved: true, won: null },
  };

  it("groups by type, tallies 1h separately, and drops pushes from both sides", () => {
    const s = summarizeOutcomes(alerts, outcomes);
    expect(s.dir1h).toEqual({
      hits: 1,
      total: 2,
      byType: {
        large: { hits: 1, total: 1 },
        smart: { hits: 0, total: 1 },
      },
    });
    expect(s.dir24h).toEqual({
      hits: 2,
      total: 2,
      byType: {
        large: { hits: 1, total: 1 },
        consensus: { hits: 1, total: 1 },
      },
    });
    expect(s.settled).toEqual({
      hits: 1,
      total: 2,
      byType: {
        large: { hits: 1, total: 1 },
        smart: { hits: 0, total: 1 },
      },
    });
  });

  it("returns all-zero stats when nothing has been computed", () => {
    const s = summarizeOutcomes(alerts, {});
    expect(s.dir1h.total).toBe(0);
    expect(s.dir24h.total).toBe(0);
    expect(s.settled.total).toBe(0);
  });
});
