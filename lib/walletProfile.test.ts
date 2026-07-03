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

  // Pages fire concurrently, so a short page 1 still issues (and discards)
  // the page-2 request. Route by offset in the mock.
  const mockByOffset = (pages: Record<number, unknown[]>) =>
    vi.fn(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      return { ok: true, json: async () => pages[offset] ?? [] };
    });

  it("discards page 2 after a short page 1 and filters malformed rows", async () => {
    const fetchMock = mockByOffset({
      0: [row(1), { bad: true }],
      1000: [row(2)], // must be DISCARDED — page 1 wasn't full
    });
    vi.stubGlobal("fetch", fetchMock);
    const trades = await fetchRecentTrades("0xabc");
    expect(trades).toHaveLength(1);
    expect(trades[0].transactionHash).toBe("0x1");
    expect(fetchMock).toHaveBeenCalledTimes(2); // concurrent pages
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("type=TRADE");
    expect(url).toContain("sortDirection=DESC");
    expect(url).toContain("limit=1000");
  });

  it("keeps both max-size pages (the verified offset cap)", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => row(i));
    const fetchMock = mockByOffset({ 0: fullPage, 1000: fullPage });
    vi.stubGlobal("fetch", fetchMock);
    const trades = await fetchRecentTrades("0xabc");
    expect(trades).toHaveLength(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("offset=1000"))).toBe(true);
  });

  it("retries a failed page once before giving up", async () => {
    const fetchMock = vi
      .fn()
      // page 0 attempt 1 + page 1000 attempt 1 fire together: fail page 0.
      .mockImplementationOnce(async () => {
        throw new Error("timeout");
      })
      .mockImplementation(async (url: string) => ({
        ok: true,
        json: async () => (String(url).includes("offset=0") ? [row(1)] : []),
      }));
    vi.stubGlobal("fetch", fetchMock);
    const trades = await fetchRecentTrades("0xabc");
    expect(trades).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 2 pages + 1 retry
  });
});
