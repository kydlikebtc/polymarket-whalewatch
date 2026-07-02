import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import {
  fetchEventCategories,
  fetchMarketMeta,
  getEventCategories,
  getMarketMeta,
  tradeMarketContext,
  type MarketMeta,
} from "./gamma";

// Live-shape gamma row: liquidity as string, stringified JSON arrays.
const gammaRow = (cid: string, over: Record<string, unknown> = {}) => ({
  conditionId: cid,
  volume24hr: 627072.18,
  liquidity: "229073.1289",
  liquidityNum: 229073.1289,
  endDate: "2026-07-03T22:00:00Z",
  closed: false,
  category: null,
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.905", "0.095"]',
  ...over,
});

const meta = (cid: string, over: Partial<MarketMeta> = {}): MarketMeta => ({
  conditionId: cid,
  volume24hr: 100_000,
  liquidity: 50_000,
  endDate: "2026-07-03T22:00:00Z",
  closed: false,
  category: "Sports",
  outcomes: ["Yes", "No"],
  outcomePrices: [0.9, 0.1],
  ...over,
});

describe("fetchMarketMeta", () => {
  it("normalizes live field shapes (string liquidity, stringified arrays)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => [gammaRow("0xc1")] });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchMarketMeta(["0xc1"]);
    const m = out["0xc1"];
    expect(m.liquidity).toBeCloseTo(229073.1289);
    expect(m.outcomes).toEqual(["Yes", "No"]);
    expect(m.outcomePrices).toEqual([0.905, 0.095]);
    expect(m.closed).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toContain("condition_ids=0xc1");
  });

  it("keeps successful chunks when another chunk fails (independent failure)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ids = Array.from({ length: 25 }, (_, i) => `0xc${i}`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ids.slice(0, 20).map((c) => gammaRow(c)),
      })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      // closed=true retry sweep for the failed chunk's ids — also empty here.
      .mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchMarketMeta(ids);
    expect(Object.keys(out)).toHaveLength(20); // chunk 1 kept, chunk 2 skipped
    warnSpy.mockRestore();
  });

  it("finds SETTLED markets via the closed=true second sweep (plain query excludes them)", async () => {
    // Verified live: /markets?condition_ids= returns 0 rows for a closed
    // market unless closed=true is passed — the settlement backfill depends
    // on this second sweep.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) // open sweep: not found
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          gammaRow("0xsettled", { closed: true, outcomePrices: '["1", "0"]' }),
        ],
      });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchMarketMeta(["0xsettled"]);
    expect(out["0xsettled"]?.closed).toBe(true);
    expect(out["0xsettled"]?.outcomePrices).toEqual([1, 0]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("closed=true");
  });

  it("chunks large id sets into multiple requests", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `0xc${i}`);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ids.map((c) => gammaRow(c)),
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchMarketMeta(ids);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 20 + 5
  });
});

describe("getMarketMeta", () => {
  it("caches fetched meta and serves it within the TTL", async () => {
    const db = openDb(":memory:");
    const fetcher = vi.fn(async (ids: string[]) =>
      Object.fromEntries(ids.map((c) => [c, meta(c)])),
    );
    await getMarketMeta(db, ["0xc1"], { fetcher, nowSec: 1000 });
    const second = await getMarketMeta(db, ["0xc1"], {
      fetcher,
      nowSec: 1000 + 100,
    });
    expect(second["0xc1"]).toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refreshes an OPEN market after the TTL but keeps a CLOSED one forever", async () => {
    const db = openDb(":memory:");
    const fetcher = vi.fn(async (ids: string[]) =>
      Object.fromEntries(
        ids.map((c) => [c, meta(c, { closed: c === "0xclosed" })]),
      ),
    );
    await getMarketMeta(db, ["0xopen", "0xclosed"], { fetcher, nowSec: 1000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await getMarketMeta(db, ["0xopen", "0xclosed"], {
      fetcher,
      nowSec: 1000 + 100_000, // far past the 1h TTL
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Only the open market was refetched.
    expect(fetcher.mock.calls[1][0]).toEqual(["0xopen"]);
  });

  it("degrades to an empty result when the fetcher throws", async () => {
    const db = openDb(":memory:");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await getMarketMeta(db, ["0xc1"], {
      fetcher: async () => {
        throw new Error("boom");
      },
      nowSec: 1000,
    });
    expect(out).toEqual({});
    warnSpy.mockRestore();
  });
});

describe("event categories", () => {
  const event = (slug: string, labels: string[]) => ({
    slug,
    tags: labels.map((label) => ({ id: "1", label, slug: label })),
  });

  it("picks the primary category over niche tags (Sports beats Soccer/Games)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        event("ev-a", ["Soccer", "Games", "Sports", "FIFA World Cup"]),
        event("ev-b", ["Bitcoin", "Crypto"]),
        event("ev-c", []), // tagless → known-none ""
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchEventCategories(["ev-a", "ev-b", "ev-c"]);
    expect(out["ev-a"]).toBe("Sports");
    expect(out["ev-b"]).toBe("Crypto");
    expect(out["ev-c"]).toBe(""); // resolved but unknown
    expect(fetchMock.mock.calls[0][0]).toContain("slug=ev-a");
  });

  it("falls back to the first tag label when no primary category matches", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [event("ev-x", ["Chess", "Board Games"])],
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchEventCategories(["ev-x"]);
    expect(out["ev-x"]).toBe("Chess");
  });

  it("getEventCategories caches known results (including known-none) permanently", async () => {
    const db = openDb(":memory:");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ "ev-a": "Sports", "ev-b": "" });
    const first = await getEventCategories(db, ["ev-a", "ev-b"], { fetcher });
    expect(first).toEqual({ "ev-a": "Sports", "ev-b": null });
    const second = await getEventCategories(db, ["ev-a", "ev-b"], { fetcher });
    expect(second).toEqual({ "ev-a": "Sports", "ev-b": null });
    expect(fetcher).toHaveBeenCalledTimes(1); // both served from cache
  });

  it("getEventCategories leaves failed-chunk slugs uncached for retry", async () => {
    const db = openDb(":memory:");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({}) // chunk failed — slug absent
      .mockResolvedValueOnce({ "ev-a": "Politics" });
    const first = await getEventCategories(db, ["ev-a"], { fetcher });
    expect(first["ev-a"]).toBeNull();
    const second = await getEventCategories(db, ["ev-a"], { fetcher });
    expect(second["ev-a"]).toBe("Politics");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("tradeMarketContext", () => {
  const NOW = Math.floor(Date.parse("2026-07-01T22:00:00Z") / 1000);

  it("computes impact, liquidity share, and hours to end", () => {
    const ctx = tradeMarketContext(20_000, meta("0xc1"), NOW);
    expect(ctx?.impact24h).toBeCloseTo(0.2);
    expect(ctx?.liquidityShare).toBeCloseTo(0.4);
    expect(ctx?.hoursToEnd).toBeCloseTo(48);
  });

  it("returns null hoursToEnd for a closed market and null ctx for missing meta", () => {
    const closed = tradeMarketContext(
      1000,
      meta("0xc1", { closed: true }),
      NOW,
    );
    expect(closed?.hoursToEnd).toBeNull();
    expect(tradeMarketContext(1000, undefined, NOW)).toBeNull();
  });

  it("clamps a past endDate to 0 hours and handles zero volume", () => {
    const past = tradeMarketContext(
      1000,
      meta("0xc1", { endDate: "2026-06-30T00:00:00Z", volume24hr: 0 }),
      NOW,
    );
    expect(past?.hoursToEnd).toBe(0);
    expect(past?.impact24h).toBeNull();
  });
});
