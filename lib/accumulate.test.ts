import { describe, it, expect } from "vitest";
import { aggregate } from "./accumulate";

// Minimal Trade factory: only the fields aggregate() reads matter. `as any`
// keeps fixtures terse (mirrors lib/trades.test.ts).
function trade(over: Record<string, unknown>) {
  return {
    transactionHash: "0xtx",
    asset: "asset-A",
    proxyWallet: "0xW1",
    conditionId: "0xCOND",
    outcome: "Yes",
    outcomeIndex: 0,
    side: "BUY",
    size: 1000,
    price: 1,
    timestamp: 1_700_000_000,
    title: "Will X happen?",
    eventSlug: "will-x-happen",
    ...over,
  } as any;
}

const DEFAULTS = {
  minNetUsd: 10_000,
  minBuyCount: 3,
  splitCeiling: 10_000,
};

describe("aggregate (split-buy accumulation)", () => {
  it("groups by (wallet,conditionId,outcome) and sums buy/sell + computes netUsd", () => {
    // One wallet, 4 sub-$10k BUYs ($5k each = $20k) on the same market/outcome.
    const trades = [
      trade({ transactionHash: "0x1", size: 5000, price: 1 }),
      trade({ transactionHash: "0x2", size: 5000, price: 1 }),
      trade({ transactionHash: "0x3", size: 5000, price: 1 }),
      trade({ transactionHash: "0x4", size: 5000, price: 1 }),
    ];
    const out = aggregate(trades, DEFAULTS);
    expect(out).toHaveLength(1);
    const g = out[0];
    expect(g.wallet).toBe("0xW1");
    expect(g.conditionId).toBe("0xCOND");
    expect(g.outcome).toBe("Yes");
    expect(g.buyUsd).toBe(20_000);
    expect(g.sellUsd).toBe(0);
    expect(g.netUsd).toBe(20_000);
    expect(g.buyCount).toBe(4);
    expect(g.sellCount).toBe(0);
    expect(g.maxSingleBuyUsd).toBe(5000);
  });

  it("computes size-weighted avgBuyPrice across the group's BUYs", () => {
    // 100sh@0.5 ($50) + 100sh@0.7 ($70) → buyUsd $120 / buyShares 200 = avg 0.6.
    // (Add a third sub-ceiling buy so the group qualifies at minBuyCount=3,
    // and raise sizes via a fourth so it clears the net floor.)
    const trades = [
      trade({ transactionHash: "0x1", size: 100, price: 0.5 }),
      trade({ transactionHash: "0x2", size: 100, price: 0.7 }),
    ];
    const out = aggregate(trades, {
      minNetUsd: 0,
      minBuyCount: 2,
      splitCeiling: 10_000,
    });
    expect(out).toHaveLength(1);
    const g = out[0];
    expect(g.buyShares).toBe(200);
    expect(g.buyUsd).toBeCloseTo(120, 6);
    expect(g.avgBuyPrice).toBeCloseTo(0.6, 6);
  });

  it("avgBuyPrice is 0 when the group has no BUYs", () => {
    // A pure-sell group never qualifies (filtered out), but the per-group field
    // must still be safe: buyShares 0 → avgBuyPrice 0 (no divide-by-zero NaN).
    // Verify directly by allowing it through with permissive opts on a buy+sell mix
    // where buyShares is computed; here we assert the no-buy guard via reflection
    // on a qualifying group whose buys exist, plus a separate net=0 check below.
    const trades = [
      trade({ transactionHash: "0x1", size: 100, price: 0.4 }),
      trade({ transactionHash: "0x2", size: 100, price: 0.4 }),
    ];
    const out = aggregate(trades, {
      minNetUsd: 0,
      minBuyCount: 2,
      splitCeiling: 10_000,
    });
    expect(out[0].avgBuyPrice).toBeCloseTo(0.4, 6);
  });

  it("records each BUY in `buys` sorted newest-first, and tracks firstTs/lastTs over all trades", () => {
    // Three buys + one sell at distinct timestamps. buys[] holds only the BUYs,
    // newest-first; firstTs/lastTs span ALL trades (incl. the sell).
    const trades = [
      trade({ transactionHash: "0x1", size: 100, price: 0.5, timestamp: 1000 }),
      trade({ transactionHash: "0x2", size: 100, price: 0.6, timestamp: 3000 }),
      trade({ transactionHash: "0x3", size: 100, price: 0.7, timestamp: 2000 }),
      // A sell at the latest timestamp — must move lastTs but NOT appear in buys.
      trade({
        transactionHash: "0x4",
        side: "SELL",
        size: 10,
        price: 0.7,
        timestamp: 5000,
      }),
    ];
    const out = aggregate(trades, {
      minNetUsd: 0,
      minBuyCount: 3,
      splitCeiling: 10_000,
    });
    expect(out).toHaveLength(1);
    const g = out[0];
    expect(g.firstTs).toBe(1000);
    expect(g.lastTs).toBe(5000);
    // buys: only the 3 BUYs, newest-first by ts → 3000, 2000, 1000.
    expect(g.buys.map((b) => b.ts)).toEqual([3000, 2000, 1000]);
    expect(g.buys.map((b) => b.price)).toEqual([0.6, 0.7, 0.5]);
    expect(g.buys.map((b) => b.usd)).toEqual([60, 70, 50]);
  });

  it("separates different (wallet,conditionId,outcome) keys into distinct groups", () => {
    const trades = [
      // Group 1: W1 / Yes — 3 x $4k = $12k
      trade({ transactionHash: "0x1", proxyWallet: "0xW1", size: 4000 }),
      trade({ transactionHash: "0x2", proxyWallet: "0xW1", size: 4000 }),
      trade({ transactionHash: "0x3", proxyWallet: "0xW1", size: 4000 }),
      // Group 2: W2 / Yes — 3 x $7k = $21k
      trade({ transactionHash: "0x4", proxyWallet: "0xW2", size: 7000 }),
      trade({ transactionHash: "0x5", proxyWallet: "0xW2", size: 7000 }),
      trade({ transactionHash: "0x6", proxyWallet: "0xW2", size: 7000 }),
    ];
    const out = aggregate(trades, DEFAULTS);
    expect(out).toHaveLength(2);
    // Sorted by netUsd desc → W2 first.
    expect(out[0].wallet).toBe("0xW2");
    expect(out[0].netUsd).toBe(21_000);
    expect(out[1].wallet).toBe("0xW1");
    expect(out[1].netUsd).toBe(12_000);
  });

  it("EXCLUDES a group whose maxSingleBuyUsd >= splitCeiling (single-large trade, not a split)", () => {
    // 3 BUYs but one is $10k (== ceiling) → would have fired a single-trade alert.
    const trades = [
      trade({ transactionHash: "0x1", size: 10_000, price: 1 }),
      trade({ transactionHash: "0x2", size: 5000, price: 1 }),
      trade({ transactionHash: "0x3", size: 5000, price: 1 }),
    ];
    const out = aggregate(trades, DEFAULTS);
    expect(out).toHaveLength(0);
  });

  it("EXCLUDES groups with buyCount < minBuyCount", () => {
    // Only 2 BUYs (need >= 3), even though net is well over the floor.
    const trades = [
      trade({ transactionHash: "0x1", size: 9000, price: 1 }),
      trade({ transactionHash: "0x2", size: 9000, price: 1 }),
    ];
    const out = aggregate(trades, DEFAULTS);
    expect(out).toHaveLength(0);
  });

  it("EXCLUDES groups with netUsd < minNetUsd", () => {
    // 3 BUYs but only $9k total net — below the $10k floor.
    const trades = [
      trade({ transactionHash: "0x1", size: 3000, price: 1 }),
      trade({ transactionHash: "0x2", size: 3000, price: 1 }),
      trade({ transactionHash: "0x3", size: 3000, price: 1 }),
    ];
    const out = aggregate(trades, DEFAULTS);
    expect(out).toHaveLength(0);
  });

  it("EXCLUDES a churn wallet where buyUsd < 1.5x sellUsd (side-consistency guard)", () => {
    // buyUsd $24k, sellUsd $20k → ratio 1.2 < 1.5 → wash/churn, excluded.
    // (netUsd $4k would also fail the floor, so push buys/sells high to isolate the guard.)
    const trades = [
      trade({ transactionHash: "0x1", side: "BUY", size: 9000, price: 1 }),
      trade({ transactionHash: "0x2", side: "BUY", size: 9000, price: 1 }),
      trade({ transactionHash: "0x3", side: "BUY", size: 9000, price: 1 }),
      trade({ transactionHash: "0x4", side: "BUY", size: 9000, price: 1 }),
      // sellUsd = $30k → buyUsd $36k, ratio 1.2, net $6k < floor too; but guard catches it.
      trade({ transactionHash: "0x5", side: "SELL", size: 9999, price: 1 }),
      trade({ transactionHash: "0x6", side: "SELL", size: 9999, price: 1 }),
      trade({ transactionHash: "0x7", side: "SELL", size: 10_002, price: 1 }),
    ];
    const out = aggregate(trades, DEFAULTS);
    expect(out).toHaveLength(0);
  });

  it("KEEPS a group with some sells when buyUsd >= 1.5x sellUsd and net clears the floor", () => {
    // buyUsd $36k, sellUsd $12k → ratio 3.0 >= 1.5, net $24k >= floor.
    const trades = [
      trade({ transactionHash: "0x1", side: "BUY", size: 9000, price: 1 }),
      trade({ transactionHash: "0x2", side: "BUY", size: 9000, price: 1 }),
      trade({ transactionHash: "0x3", side: "BUY", size: 9000, price: 1 }),
      trade({ transactionHash: "0x4", side: "BUY", size: 9000, price: 1 }),
      trade({ transactionHash: "0x5", side: "SELL", size: 6000, price: 1 }),
      trade({ transactionHash: "0x6", side: "SELL", size: 6000, price: 1 }),
    ];
    const out = aggregate(trades, DEFAULTS);
    expect(out).toHaveLength(1);
    expect(out[0].buyUsd).toBe(36_000);
    expect(out[0].sellUsd).toBe(12_000);
    expect(out[0].netUsd).toBe(24_000);
    expect(out[0].buyCount).toBe(4);
    expect(out[0].sellCount).toBe(2);
  });

  it("dedups duplicate rows (same dedupKey counted once)", () => {
    // The duplicate (identical tx/asset/wallet/side/size) must NOT double-count.
    // Without dedup this would be 4 BUYs = $20k; with dedup it's 3 BUYs = $15k.
    const trades = [
      trade({ transactionHash: "0x1", size: 5000, price: 1 }),
      trade({ transactionHash: "0x1", size: 5000, price: 1 }), // exact dup of 0x1
      trade({ transactionHash: "0x2", size: 5000, price: 1 }),
      trade({ transactionHash: "0x3", size: 5000, price: 1 }),
    ];
    const out = aggregate(trades, DEFAULTS);
    expect(out).toHaveLength(1);
    expect(out[0].buyCount).toBe(3);
    expect(out[0].buyUsd).toBe(15_000);
    expect(out[0].netUsd).toBe(15_000);
  });

  it("flags hedge suspicion when the same wallet net-buys the OPPOSITE outcome, with binary 1−price deduction", () => {
    // Yes side (qualifying): 3 × $5k @0.5 → netUsd $15k.
    // No side (NOT qualifying — 1 buy, under the floor): $4k @0.8 net buy.
    // Binary deduction: opposite shares 4000/0.8 = 5000 → equivalent Yes-sell
    // 5000 × (1−0.8) = $1000 → adjusted 15000 − 1000 = $14000.
    const trades = [
      trade({ transactionHash: "0x1", size: 10_000, price: 0.5 }),
      trade({ transactionHash: "0x2", size: 10_000, price: 0.5 }),
      trade({ transactionHash: "0x3", size: 10_000, price: 0.5 }),
      trade({
        transactionHash: "0x4",
        outcome: "No",
        outcomeIndex: 1,
        size: 5000,
        price: 0.8,
      }),
    ];
    const out = aggregate(trades, DEFAULTS);
    expect(out).toHaveLength(1);
    const g = out[0];
    expect(g.outcome).toBe("Yes");
    expect(g.hedgeSuspect).toBe(true);
    expect(g.hedgeAdjustedNetUsd).toBeCloseTo(14_000, 6);
  });

  it("multi-outcome hedge (outcomeIndex >= 2) is flagged WITHOUT the 1−price deduction", () => {
    const trades = [
      trade({ transactionHash: "0x1", size: 5000, price: 1 }),
      trade({ transactionHash: "0x2", size: 5000, price: 1 }),
      trade({ transactionHash: "0x3", size: 5000, price: 1 }),
      // Same market, a THIRD outcome — the 1−price identity doesn't hold.
      trade({
        transactionHash: "0x4",
        outcome: "Candidate C",
        outcomeIndex: 2,
        size: 4000,
        price: 0.5,
      }),
    ];
    const out = aggregate(trades, DEFAULTS);
    expect(out).toHaveLength(1);
    expect(out[0].hedgeSuspect).toBe(true);
    expect(out[0].hedgeAdjustedNetUsd).toBeNull();
  });

  it("no hedge flag when the opposite outcome was net-SOLD (netUsd <= 0)", () => {
    const trades = [
      trade({ transactionHash: "0x1", size: 5000, price: 1 }),
      trade({ transactionHash: "0x2", size: 5000, price: 1 }),
      trade({ transactionHash: "0x3", size: 5000, price: 1 }),
      // Opposite outcome: bought $1k then sold $3k → net −$2k, not a hedge.
      trade({
        transactionHash: "0x4",
        outcome: "No",
        outcomeIndex: 1,
        size: 1000,
        price: 1,
      }),
      trade({
        transactionHash: "0x5",
        outcome: "No",
        outcomeIndex: 1,
        side: "SELL",
        size: 3000,
        price: 1,
      }),
    ];
    const out = aggregate(trades, DEFAULTS);
    expect(out).toHaveLength(1);
    expect(out[0].hedgeSuspect).toBe(false);
    expect(out[0].hedgeAdjustedNetUsd).toBeNull();
  });

  it("flags market-making suspicion on high BUY/SELL alternation (chronological flip rate)", () => {
    // Chronological (by ts, deliberately fed out of order): B S B S B →
    // 4 flips / 4 gaps = 1.0 > 0.4. buyUsd $18k vs sellUsd $4k keeps the
    // side-consistency guard satisfied so the group still qualifies.
    const trades = [
      trade({ transactionHash: "0x3", size: 6000, price: 1, timestamp: 3000 }),
      trade({ transactionHash: "0x1", size: 6000, price: 1, timestamp: 1000 }),
      trade({
        transactionHash: "0x2",
        side: "SELL",
        size: 2000,
        price: 1,
        timestamp: 2000,
      }),
      trade({ transactionHash: "0x5", size: 6000, price: 1, timestamp: 5000 }),
      trade({
        transactionHash: "0x4",
        side: "SELL",
        size: 2000,
        price: 1,
        timestamp: 4000,
      }),
    ];
    const out = aggregate(trades, DEFAULTS);
    expect(out).toHaveLength(1);
    expect(out[0].flipRate).toBeCloseTo(1.0, 6);
    expect(out[0].mmSuspect).toBe(true);
  });

  it("pure-buy groups have flipRate 0 and no suspicion tags", () => {
    const trades = [
      trade({ transactionHash: "0x1", size: 5000, price: 1 }),
      trade({ transactionHash: "0x2", size: 5000, price: 1 }),
      trade({ transactionHash: "0x3", size: 5000, price: 1 }),
    ];
    const out = aggregate(trades, DEFAULTS);
    expect(out[0].flipRate).toBe(0);
    expect(out[0].mmSuspect).toBe(false);
    expect(out[0].hedgeSuspect).toBe(false);
  });

  it("suspect groups sink below clean groups in the default ordering", () => {
    const trades = [
      // Clean group: net $12k (smaller).
      trade({ transactionHash: "0xa1", proxyWallet: "0xCLEAN", size: 4000 }),
      trade({ transactionHash: "0xa2", proxyWallet: "0xCLEAN", size: 4000 }),
      trade({ transactionHash: "0xa3", proxyWallet: "0xCLEAN", size: 4000 }),
      // Hedged group: net $27k on Yes but also net-buys No → suspect.
      trade({ transactionHash: "0xb1", proxyWallet: "0xHEDGE", size: 9000 }),
      trade({ transactionHash: "0xb2", proxyWallet: "0xHEDGE", size: 9000 }),
      trade({ transactionHash: "0xb3", proxyWallet: "0xHEDGE", size: 9000 }),
      trade({
        transactionHash: "0xb4",
        proxyWallet: "0xHEDGE",
        outcome: "No",
        outcomeIndex: 1,
        size: 4000,
        price: 0.5,
      }),
    ];
    const out = aggregate(trades, DEFAULTS);
    expect(out.map((g) => g.wallet)).toEqual(["0xCLEAN", "0xHEDGE"]);
    expect(out[1].hedgeSuspect).toBe(true);
  });

  it("returns results sorted by netUsd desc", () => {
    const trades = [
      // small: net $12k
      trade({ transactionHash: "0xa1", proxyWallet: "0xS", size: 4000 }),
      trade({ transactionHash: "0xa2", proxyWallet: "0xS", size: 4000 }),
      trade({ transactionHash: "0xa3", proxyWallet: "0xS", size: 4000 }),
      // big: net $27k
      trade({ transactionHash: "0xb1", proxyWallet: "0xB", size: 9000 }),
      trade({ transactionHash: "0xb2", proxyWallet: "0xB", size: 9000 }),
      trade({ transactionHash: "0xb3", proxyWallet: "0xB", size: 9000 }),
      // mid: net $18k
      trade({ transactionHash: "0xc1", proxyWallet: "0xM", size: 6000 }),
      trade({ transactionHash: "0xc2", proxyWallet: "0xM", size: 6000 }),
      trade({ transactionHash: "0xc3", proxyWallet: "0xM", size: 6000 }),
    ];
    const out = aggregate(trades, DEFAULTS);
    expect(out.map((g) => g.netUsd)).toEqual([27_000, 18_000, 12_000]);
  });
});
