import { describe, it, expect, vi } from "vitest";
import {
  analyzeTrades,
  fetchRecentTrades,
  type ActivityTrade,
} from "./walletProfile";

const mk = (over: Partial<ActivityTrade> = {}): ActivityTrade => ({
  timestamp: 1000,
  conditionId: "0xc1",
  side: "BUY",
  size: 100,
  usdcSize: 50,
  price: 0.5,
  title: "Market A",
  outcome: "Yes",
  eventSlug: "event-a",
  transactionHash: "0xh",
  ...over,
});

describe("analyzeTrades", () => {
  it("handles an empty window", () => {
    const p = analyzeTrades([]);
    expect(p.tradeCount).toBe(0);
    expect(p.smallBuyShare).toBeNull();
    expect(p.firstTs).toBeNull();
    expect(p.topMarkets).toEqual([]);
  });

  it("buckets BUY trades into price bands (price 1.0 lands in the top band)", () => {
    const p = analyzeTrades([
      mk({ price: 0.05, usdcSize: 100 }),
      mk({ price: 0.55, usdcSize: 200 }),
      mk({ price: 1.0, usdcSize: 300 }),
      mk({ side: "SELL", price: 0.55, usdcSize: 999 }), // sells don't band
    ]);
    expect(p.priceBands[0].buyUsd).toBe(100);
    expect(p.priceBands[5].buyUsd).toBe(200);
    expect(p.priceBands[9].buyUsd).toBe(300);
    expect(p.priceBands.reduce((s, b) => s + b.buyCount, 0)).toBe(3);
  });

  it("computes flow totals, small-buy share, and market focus", () => {
    const p = analyzeTrades([
      mk({ usdcSize: 500 }), // small buy
      mk({ usdcSize: 5000 }), // big buy
      mk({ side: "SELL", usdcSize: 2000 }),
      mk({
        conditionId: "0xc2",
        title: "Market B",
        usdcSize: 800,
        timestamp: 2000,
      }), // small buy
    ]);
    expect(p.buyUsd).toBe(6300);
    expect(p.sellUsd).toBe(2000);
    expect(p.smallBuyShare).toBeCloseTo(2 / 3);
    expect(p.firstTs).toBe(1000);
    expect(p.lastTs).toBe(2000);
    // Market A gross $7.5k > Market B $800.
    expect(p.topMarkets[0].conditionId).toBe("0xc1");
    expect(p.topMarkets[0].netUsd).toBe(3500);
    expect(p.topMarkets[1].conditionId).toBe("0xc2");
  });
});

describe("fetchRecentTrades", () => {
  const row = (i: number) => ({
    timestamp: 1000 + i,
    conditionId: "0xc",
    type: "TRADE",
    side: "BUY",
    size: 1,
    usdcSize: 1,
    price: 0.5,
    title: "M",
    outcome: "Yes",
    eventSlug: "e",
    transactionHash: `0x${i}`,
  });

  it("stops after a short page and filters malformed rows", async () => {
    const page = [row(1), { bad: true }];
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => page });
    vi.stubGlobal("fetch", fetchMock);
    const trades = await fetchRecentTrades("0xabc");
    expect(trades).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("type=TRADE");
    expect(url).toContain("sortDirection=DESC");
    expect(url).toContain("limit=1000");
  });

  it("fetches at most two max-size pages (the verified offset cap)", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => row(i));
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => fullPage });
    vi.stubGlobal("fetch", fetchMock);
    const trades = await fetchRecentTrades("0xabc");
    expect(trades).toHaveLength(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("offset=1000");
  });
});
