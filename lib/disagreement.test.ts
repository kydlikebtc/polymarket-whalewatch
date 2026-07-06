import { describe, it, expect } from "vitest";
import { detectDisagreement, qualityWeight } from "./disagreement";
import type { SmartTag } from "./smartWallets";
import type { Trade } from "./types";

const mk = (over: Partial<Trade> = {}): Trade =>
  ({
    transactionHash: `0xtx${Math.random().toString(36).slice(2, 8)}`,
    asset: "assetYes",
    proxyWallet: "0xW1",
    side: "BUY",
    size: 20000,
    price: 0.5, // $10k notional by default
    timestamp: 1000,
    title: "Market",
    slug: "slug",
    eventSlug: "event",
    outcome: "Yes",
    outcomeIndex: 0,
    conditionId: "0xc",
    ...over,
  }) as Trade;

const tag = (score: number | null = 80): SmartTag => ({
  score,
  winRate: 0.7,
  realizedPnl: 100_000,
  isWhitelist: false,
});

// Smart-tag map with per-wallet scores (lowercased keys, like the real lookup).
const smartMap = (
  entries: Record<string, number | null>,
): Map<string, SmartTag> =>
  new Map(Object.entries(entries).map(([w, s]) => [w.toLowerCase(), tag(s)]));

const OPTS = {
  minPerSideUsd: 5000,
  minWalletsPerSide: 1,
  lopsidedTiltPct: 0.7,
};

describe("qualityWeight", () => {
  it("floors at 0.2 (score 0 / unknown), saturates at 1.0 (score 100)", () => {
    expect(qualityWeight(0)).toBeCloseTo(0.2);
    expect(qualityWeight(50)).toBeCloseTo(0.6);
    expect(qualityWeight(100)).toBeCloseTo(1.0);
    expect(qualityWeight(null)).toBeCloseTo(0.2);
    // Out-of-range scores are clamped, never negative or > 1.
    expect(qualityWeight(-20)).toBeCloseTo(0.2);
    expect(qualityWeight(140)).toBeCloseTo(1.0);
  });
});

describe("detectDisagreement", () => {
  it("surfaces a market where smart money net-buys BOTH opposing outcomes", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1", outcome: "Yes" }),
      mk({
        proxyWallet: "0xB",
        transactionHash: "0x2",
        outcome: "No",
        outcomeIndex: 1,
        asset: "assetNo",
      }),
    ];
    const markets = detectDisagreement(
      trades,
      smartMap({ "0xA": 80, "0xB": 80 }),
      OPTS,
    );
    expect(markets).toHaveLength(1);
    expect(markets[0].sides).toHaveLength(2);
    expect(markets[0].sides.map((s) => s.outcome).sort()).toEqual([
      "No",
      "Yes",
    ]);
    // Equal quality + equal amount → a dead-even split.
    expect(markets[0].tiltPct).toBeCloseTo(0.5);
    expect(markets[0].tilt).toBe("balanced");
  });

  it("ignores a market where only one side has smart buying (no disagreement)", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1", outcome: "Yes" }),
      mk({ proxyWallet: "0xB", transactionHash: "0x2", outcome: "Yes" }),
    ];
    const markets = detectDisagreement(
      trades,
      smartMap({ "0xA": 80, "0xB": 80 }),
      OPTS,
    );
    expect(markets).toHaveLength(0);
  });

  it("drops a wallet net-buying BOTH sides (hedger/market-maker = fake opposition)", () => {
    const trades = [
      // 0xMM plays both sides — a hedge, not an opinion.
      mk({ proxyWallet: "0xMM", transactionHash: "0x1", outcome: "Yes" }),
      mk({ proxyWallet: "0xMM", transactionHash: "0x2", outcome: "No" }),
      // Only a genuine Yes bet remains; No side has no real buyer left.
      mk({ proxyWallet: "0xA", transactionHash: "0x3", outcome: "Yes" }),
    ];
    const markets = detectDisagreement(
      trades,
      smartMap({ "0xMM": 80, "0xA": 80 }),
      OPTS,
    );
    expect(markets).toHaveLength(0);
  });

  it("excludes the both-sides hedger but still surfaces the genuine disagreement", () => {
    const trades = [
      mk({ proxyWallet: "0xMM", transactionHash: "0x1", outcome: "Yes" }),
      mk({ proxyWallet: "0xMM", transactionHash: "0x2", outcome: "No" }),
      mk({ proxyWallet: "0xA", transactionHash: "0x3", outcome: "Yes" }),
      mk({ proxyWallet: "0xB", transactionHash: "0x4", outcome: "No" }),
    ];
    const markets = detectDisagreement(
      trades,
      smartMap({ "0xMM": 80, "0xA": 80, "0xB": 80 }),
      OPTS,
    );
    expect(markets).toHaveLength(1);
    expect(markets[0].excludedWallets).toBe(1);
    for (const side of markets[0].sides) {
      expect(side.walletCount).toBe(1);
      expect(side.wallets.map((w) => w.wallet)).not.toContain("0xmm");
    }
  });

  it("tilts by QUALITY-weighted amount, not raw USD", () => {
    const trades = [
      // Yes: score-100 wallet, $10k → weighted 10000 × 1.0 = 10000
      mk({ proxyWallet: "0xHI", transactionHash: "0x1", outcome: "Yes" }),
      // No: score-0 wallet, BIGGER $20k → weighted 20000 × 0.2 = 4000
      mk({
        proxyWallet: "0xLO",
        transactionHash: "0x2",
        outcome: "No",
        size: 40000,
        price: 0.5,
      }),
    ];
    const markets = detectDisagreement(
      trades,
      smartMap({ "0xHI": 100, "0xLO": 0 }),
      OPTS,
    );
    expect(markets).toHaveLength(1);
    // Raw USD favors No ($20k > $10k) but quality-weight flips it to Yes.
    expect(markets[0].sides[0].outcome).toBe("Yes");
    expect(markets[0].tiltPct).toBeCloseTo(10000 / (10000 + 4000));
    expect(markets[0].tilt).toBe("lopsided"); // ~0.714 ≥ 0.7
  });

  it("requires each side to clear the per-side USD floor", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1", outcome: "Yes" }), // $10k
      mk({
        proxyWallet: "0xB",
        transactionHash: "0x2",
        outcome: "No",
        size: 4000,
        price: 0.5,
      }), // $2k < $5k floor
    ];
    const markets = detectDisagreement(
      trades,
      smartMap({ "0xA": 80, "0xB": 80 }),
      OPTS,
    );
    expect(markets).toHaveLength(0);
  });

  it("dedups re-served pagination rows so a side isn't double-counted", () => {
    const yesA = mk({
      proxyWallet: "0xA",
      transactionHash: "0xsame",
      outcome: "Yes",
    });
    const markets = detectDisagreement(
      [
        yesA,
        { ...yesA },
        mk({ proxyWallet: "0xB", transactionHash: "0xb", outcome: "No" }),
      ],
      smartMap({ "0xA": 80, "0xB": 80 }),
      OPTS,
    );
    const yesSide = markets[0].sides.find((s) => s.outcome === "Yes");
    expect(yesSide?.netUsd).toBe(10000);
  });

  it("ignores non-whitelist wallets entirely", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1", outcome: "Yes" }),
      mk({ proxyWallet: "0xDUMB", transactionHash: "0x2", outcome: "No" }),
    ];
    const markets = detectDisagreement(trades, smartMap({ "0xA": 80 }), OPTS);
    expect(markets).toHaveLength(0);
  });

  it("a net-seller of an outcome doesn't count as buying that side", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1", outcome: "Yes" }), // +$10k Yes
      mk({ proxyWallet: "0xB", transactionHash: "0x2", outcome: "No" }), // +$10k No
      mk({
        proxyWallet: "0xB",
        transactionHash: "0x3",
        outcome: "No",
        side: "SELL",
        size: 40000,
        price: 0.5,
      }), // -$20k No → net -$10k
    ];
    const markets = detectDisagreement(
      trades,
      smartMap({ "0xA": 80, "0xB": 80 }),
      OPTS,
    );
    expect(markets).toHaveLength(0);
  });
});
