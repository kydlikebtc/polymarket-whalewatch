import { describe, it, expect } from "vitest";
import { parseHoldings } from "./holdings";

const row = (over: Record<string, unknown> = {}) => ({
  title: "Market",
  slug: "market-slug",
  eventSlug: "event",
  outcome: "Yes",
  size: 1000,
  avgPrice: 0.4,
  curPrice: 0.5,
  currentValue: 500,
  cashPnl: 100,
  percentPnl: 25,
  redeemable: false,
  endDate: null,
  ...over,
});

describe("parseHoldings", () => {
  it("keeps LIVE positions and drops resolved (redeemable) ones", () => {
    const s = parseHoldings([
      row({ title: "Live", redeemable: false }),
      row({ title: "Resolved", redeemable: true }),
    ]);
    expect(s.holdings.map((h) => h.title)).toEqual(["Live"]);
    expect(s.count).toBe(1);
  });

  it("sorts holdings by currentValue desc", () => {
    const s = parseHoldings([
      row({ title: "Small", currentValue: 100 }),
      row({ title: "Big", currentValue: 900 }),
      row({ title: "Mid", currentValue: 400 }),
    ]);
    expect(s.holdings.map((h) => h.title)).toEqual(["Big", "Mid", "Small"]);
  });

  it("drops sub-$1 dust rows", () => {
    const s = parseHoldings([
      row({ title: "Real", currentValue: 50 }),
      row({ title: "Dust", currentValue: 0.4 }),
    ]);
    expect(s.holdings.map((h) => h.title)).toEqual(["Real"]);
  });

  it("aggregates total value + cash PnL over LIVE holdings only", () => {
    const s = parseHoldings([
      row({ currentValue: 500, cashPnl: 100 }),
      row({ currentValue: 300, cashPnl: -50 }),
      row({ currentValue: 200, cashPnl: 25, redeemable: true }), // excluded
    ]);
    expect(s.totalValue).toBe(800);
    expect(s.totalCashPnl).toBe(50);
    expect(s.count).toBe(2);
  });

  it("skips malformed rows without throwing", () => {
    const s = parseHoldings([
      row(),
      { garbage: true },
      null,
      row({ title: "OK2" }),
    ]);
    expect(s.count).toBe(2);
  });

  it("maps display fields through", () => {
    const [h] = parseHoldings([
      row({
        title: "T",
        outcome: "No",
        size: 1234,
        avgPrice: 0.3,
        curPrice: 0.45,
        currentValue: 555,
        cashPnl: 66,
        percentPnl: 12.5,
      }),
    ]).holdings;
    expect(h).toMatchObject({
      title: "T",
      slug: "market-slug",
      outcome: "No",
      size: 1234,
      avgPrice: 0.3,
      curPrice: 0.45,
      currentValue: 555,
      cashPnl: 66,
      percentPnl: 12.5,
    });
  });

  it("carries the truncated flag through", () => {
    expect(parseHoldings([], true).truncated).toBe(true);
    expect(parseHoldings([]).truncated).toBe(false);
  });
});
