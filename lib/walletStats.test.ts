import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import {
  computeWalletStats,
  fetchClosedPositions,
  fetchMarketsTraded,
  fetchResolvedOpenPositions,
  fetchUserPnl,
  getWalletStats,
  type ResolvedOpenPosition,
  type WalletStats,
} from "./walletStats";

const stats = (over: Partial<WalletStats> = {}): WalletStats => ({
  winRate: 0.6,
  netPnl: 1000,
  roi: 0.2,
  settledCount: 10,
  truncated: false,
  marketsTraded: 20,
  isMarketMaker: false,
  ...over,
});

describe("computeWalletStats", () => {
  it("returns null winRate/roi for an empty history", () => {
    const s = computeWalletStats([], false);
    expect(s).toEqual({
      winRate: null,
      netPnl: 0,
      roi: null,
      settledCount: 0,
      truncated: false,
      marketsTraded: null,
      isMarketMaker: false,
    });
  });

  it("counts wins (pnl > 0), sums pnl (netPnl fallback when COMPLETE), and computes roi over cost basis", () => {
    // Cost basis uses totalBought * avgPrice — totalBought is SHARES, not USD.
    // Not truncated + no authoritative netPnl → netPnl falls back to the settled
    // sum (safe: a complete settled sum ≈ net for fully-settled wallets).
    const s = computeWalletStats(
      [
        { realizedPnl: 200, totalBought: 1000, avgPrice: 0.5 }, // win, cost 500
        { realizedPnl: -100, totalBought: 500, avgPrice: 0.6 }, // loss, cost 300
        { realizedPnl: 0, totalBought: 100, avgPrice: 0.5 }, // break-even = not a win, cost 50
      ],
      false,
    );
    expect(s.settledCount).toBe(3);
    expect(s.winRate).toBeCloseTo(1 / 3);
    expect(s.netPnl).toBe(100);
    expect(s.roi).toBeCloseTo(100 / 850);
    expect(s.truncated).toBe(false);
  });

  it("a TRUNCATED record nulls winRate/roi (winner-biased slice) AND netPnl when unauthoritative", () => {
    // /closed-positions is sorted by realizedPnl DESC, so a truncated fetch is a
    // winners-only slice (+300 here) → a fake 100% win rate and an inflated roi.
    // All three closed-derived metrics are null; only settledCount (with "+")
    // survives. netPnl would be authoritative if the PnL API succeeded.
    const s = computeWalletStats(
      [
        { realizedPnl: 200, totalBought: 1000, avgPrice: 0.5 },
        { realizedPnl: 100, totalBought: 500, avgPrice: 0.5 },
      ],
      true, // truncated
    );
    expect(s.winRate).toBeNull();
    expect(s.roi).toBeNull();
    expect(s.netPnl).toBeNull();
    expect(s.settledCount).toBe(2);
    expect(s.truncated).toBe(true);
  });

  it("keeps the authoritative netPnl even when truncated, but still nulls roi/winRate", () => {
    // netPnl comes from the PnL API (−5000 here) so it survives truncation, but
    // roi/winRate are derived from the winner-biased closed slice → null.
    const s = computeWalletStats(
      [
        { realizedPnl: 200, totalBought: 1000, avgPrice: 0.5 }, // cost 500
        { realizedPnl: -100, totalBought: 500, avgPrice: 0.6 }, // cost 300
      ],
      true, // even truncated — authoritative netPnl still wins
      [],
      -5000, // authoritative net P/L (realized + unrealized)
    );
    expect(s.netPnl).toBe(-5000); // displayed figure = the API value, NOT the +100 sum
    expect(s.roi).toBeNull(); // truncated → winner-biased → suppressed
    expect(s.winRate).toBeNull();
  });

  it("flags a market maker once marketsTraded crosses the threshold", () => {
    const bot = computeWalletStats([], false, [], null, 5000);
    expect(bot.isMarketMaker).toBe(true);
    expect(bot.marketsTraded).toBe(5000);
    const human = computeWalletStats([], false, [], null, 200);
    expect(human.isMarketMaker).toBe(false);
    expect(human.marketsTraded).toBe(200);
  });
});

describe("fetchUserPnl", () => {
  const series = (pts: { t: number; p: number }[]) =>
    vi.fn().mockResolvedValue({ ok: true, json: async () => pts });

  it("returns the LAST point's cumulative p as the net P/L", async () => {
    vi.stubGlobal(
      "fetch",
      series([
        { t: 1, p: 100 },
        { t: 2, p: 250 },
        { t: 3, p: -40 }, // net can be negative; the last point wins
      ]),
    );
    expect(await fetchUserPnl("0xabc")).toBe(-40);
  });

  it("returns null for an empty series so the caller falls back to the settled sum", async () => {
    vi.stubGlobal("fetch", series([]));
    expect(await fetchUserPnl("0xabc")).toBeNull();
  });

  it("returns null when the last point has no numeric p", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ t: 1, p: "oops" }],
      }),
    );
    expect(await fetchUserPnl("0xabc")).toBeNull();
  });

  it("throws on a non-transient non-ok response (caller catches and falls back)", async () => {
    // 404 is non-transient → fetchWithRetry returns it immediately (no backoff).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );
    await expect(fetchUserPnl("0xabc")).rejects.toThrow("404");
  });

  it("requests the cumulative-curve endpoint with the load-bearing params", async () => {
    // The interval/fidelity window is correctness-critical: its LAST point must
    // carry the full-history cumulative total. Pin the URL so a silent swap to a
    // window that doesn't (or to the wrong user_address param) fails the suite.
    const fetchMock = series([{ t: 1, p: 5 }]);
    vi.stubGlobal("fetch", fetchMock);
    await fetchUserPnl("0xAbC");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("user-pnl-api.polymarket.com");
    expect(url).toContain("user_address=0xAbC");
    expect(url).toContain("interval=1m");
    expect(url).toContain("fidelity=1d");
  });
});

describe("fetchWalletStats orchestration (real fetcher, P0 fallback wiring)", () => {
  it("truncated /closed-positions + failing user-pnl → netPnl null, NOT the winners-only sum", async () => {
    // Every /closed-positions page comes back full (50 winner rows), so the real
    // fetchClosedPositions paginates to DEFAULT_MAX_PAGES and reports truncated.
    // With user-pnl down (404), the ONLY safe netPnl is null — the +$200k
    // winners-only settled sum must never surface. This exercises the real
    // fetchWalletStats orchestration (no injected fetcher) that unit tests skip.
    const winnerPage = Array.from({ length: 50 }, () => ({
      realizedPnl: 100,
      totalBought: 100,
      avgPrice: 0.5,
    }));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/traded?"))
        return { ok: true, json: async () => ({ traded: 50 }) }; // not a market maker
      if (url.includes("user-pnl")) return { ok: false, status: 404 };
      if (url.includes("/closed-positions"))
        return { ok: true, json: async () => winnerPage };
      if (url.includes("/positions")) return { ok: true, json: async () => [] };
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = openDb(":memory:");
    const result = await getWalletStats(db, ["0xWHALE"]);
    const s = result["0xwhale"];
    expect(s).not.toBeNull();
    expect(s?.isMarketMaker).toBe(false);
    expect(s?.marketsTraded).toBe(50);
    expect(s?.truncated).toBe(true);
    expect(s?.winRate).toBeNull(); // truncated → winner-biased slice suppressed
    expect(s?.roi).toBeNull();
    expect(s?.netPnl).toBeNull(); // the P0 guard: inflated sum suppressed
    warnSpy.mockRestore();
  });

  it("classifies a market maker from /traded and SKIPS the /closed-positions pagination", async () => {
    // The whole point: a 136k-market bot must NOT trigger the (thousands-of-pages)
    // pagination — classification happens on one cheap /traded request.
    const paginationSpy = vi.fn();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/traded?"))
        return { ok: true, json: async () => ({ traded: 136089 }) };
      if (url.includes("user-pnl"))
        return { ok: true, json: async () => [{ t: 1, p: 16_800_000 }] };
      if (url.includes("/closed-positions") || url.includes("/positions")) {
        paginationSpy();
        return { ok: true, json: async () => [] };
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const db = openDb(":memory:");
    const result = await getWalletStats(db, ["0xBOT"]);
    const s = result["0xbot"];
    expect(s?.isMarketMaker).toBe(true);
    expect(s?.marketsTraded).toBe(136089);
    expect(s?.winRate).toBeNull();
    expect(s?.roi).toBeNull();
    expect(s?.netPnl).toBe(16_800_000); // authoritative netPnl still populated
    expect(paginationSpy).not.toHaveBeenCalled(); // pagination skipped — 20x saving
  });
});

describe("fetchMarketsTraded", () => {
  it("returns the traded (distinct markets) count", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ user: "0xabc", traded: 136089 }),
      }),
    );
    expect(await fetchMarketsTraded("0xabc")).toBe(136089);
  });

  it("returns null when the payload has no numeric traded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );
    expect(await fetchMarketsTraded("0xabc")).toBeNull();
  });

  it("throws on a non-ok response (caller catches → normal path)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );
    await expect(fetchMarketsTraded("0xabc")).rejects.toThrow("404");
  });
});

describe("computeWalletStats with resolved-open positions (survivorship fix)", () => {
  const zeroLoss = (cost: number): ResolvedOpenPosition => ({
    redeemable: true,
    curPrice: 0,
    cashPnl: -cost,
    initialValue: cost,
  });

  it("held-to-zero losers break a fake 100% win rate", () => {
    // 4 redeemed wins in closed-positions + 1 loser parked at zero.
    const closed = Array.from({ length: 4 }, () => ({
      realizedPnl: 100,
      totalBought: 400,
      avgPrice: 0.5,
    }));
    const s = computeWalletStats(closed, false, [zeroLoss(300)]);
    expect(s.settledCount).toBe(5);
    expect(s.winRate).toBeCloseTo(0.8); // was 1.0 before the fix
    expect(s.netPnl).toBe(400 - 300);
    expect(s.roi).toBeCloseTo(100 / (4 * 200 + 300));
  });

  it("counts an unredeemed win (curPrice=1) as a win with its final cashPnl", () => {
    const s = computeWalletStats([], false, [
      {
        redeemable: true,
        curPrice: 1,
        cashPnl: 500, // size*1 - cost, final at resolution
        initialValue: 500,
      },
    ]);
    expect(s.winRate).toBe(1);
    expect(s.netPnl).toBe(500);
    expect(s.settledCount).toBe(1);
  });
});

describe("fetchResolvedOpenPositions", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    redeemable: true,
    curPrice: 0,
    cashPnl: -100,
    initialValue: 100,
    title: "M",
    ...over,
  });

  it("keeps only decided positions: live rows and 50/50 pushes are excluded", async () => {
    const page = [
      row(), // resolved loss → kept
      row({ curPrice: 1, cashPnl: 80 }), // unredeemed win → kept
      row({ redeemable: false, curPrice: 0.4 }), // live market → out
      row({ curPrice: 0.5 }), // push → out
      { bad: true }, // malformed → out
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => page }),
    );
    const { positions, truncated } = await fetchResolvedOpenPositions("0xabc");
    expect(positions).toHaveLength(2);
    expect(truncated).toBe(false);
  });

  it("paginates by offset until a short page", async () => {
    const fullPage = Array.from({ length: 50 }, () => row());
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => fullPage })
      .mockResolvedValueOnce({ ok: true, json: async () => [row()] });
    vi.stubGlobal("fetch", fetchMock);
    const { positions } = await fetchResolvedOpenPositions("0xabc");
    expect(positions).toHaveLength(51);
    expect(fetchMock.mock.calls[1][0]).toContain("offset=50");
  });
});

describe("fetchClosedPositions", () => {
  const pos = (pnl: number) => ({
    realizedPnl: pnl,
    totalBought: 100,
    avgPrice: 0.5,
    extraField: "ignored",
  });

  it("paginates by offset until a short page and drops malformed rows", async () => {
    const fullPage = Array.from({ length: 50 }, () => pos(1));
    const lastPage = [pos(2), { realizedPnl: "bad" }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => fullPage })
      .mockResolvedValueOnce({ ok: true, json: async () => lastPage });
    vi.stubGlobal("fetch", fetchMock);
    const { positions, truncated } = await fetchClosedPositions("0xabc");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("offset=0");
    expect(fetchMock.mock.calls[1][0]).toContain("offset=50");
    expect(positions).toHaveLength(51); // malformed row dropped
    expect(truncated).toBe(false);
  });

  it("flags truncated when the page cap is hit with a full last page", async () => {
    const fullPage = Array.from({ length: 50 }, () => pos(1));
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => fullPage });
    vi.stubGlobal("fetch", fetchMock);
    const { positions, truncated } = await fetchClosedPositions("0xabc", {
      maxPages: 2,
    });
    expect(positions).toHaveLength(100);
    expect(truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops as truncated when a page re-serves already-seen positions", async () => {
    // Fingerprints come from the raw rows' conditionId+asset; the second page
    // re-serving the SAME rows (offset clamping) must not double-count them.
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      ...pos(1),
      conditionId: `c${i}`,
      asset: `a${i}`,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => fullPage })
      .mockResolvedValueOnce({ ok: true, json: async () => fullPage });
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { positions, truncated } = await fetchClosedPositions("0xabc");
    expect(positions).toHaveLength(50); // repeated page dropped, not appended
    expect(truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("a partially-fresh page still appends in full (guard only trips on ZERO progress)", async () => {
    const mk = (i: number) => ({ ...pos(1), conditionId: `c${i}`, asset: "a" });
    const page0 = Array.from({ length: 50 }, (_, i) => mk(i));
    // Page 1 overlaps page 0 by one row but brings fresh rows — legit data.
    const page1 = [mk(49), mk(50), mk(51)];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page0 })
      .mockResolvedValueOnce({ ok: true, json: async () => page1 });
    vi.stubGlobal("fetch", fetchMock);
    const { positions, truncated } = await fetchClosedPositions("0xabc");
    expect(positions).toHaveLength(53);
    expect(truncated).toBe(false); // short page = genuine end
  });

  it("throws on a non-ok response", async () => {
    // Non-transient status: no retry, immediate throw (persistent transient
    // 5xx exhaustion is covered by the fetchWithRetry tests).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );
    await expect(fetchClosedPositions("0xabc")).rejects.toThrow("404");
  });

  it("retries a transient 5xx page then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, json: async () => [pos(1)] });
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { positions, truncated } = await fetchClosedPositions("0xabc");
    expect(positions).toHaveLength(1);
    expect(truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});

describe("getWalletStats", () => {
  it("fetches misses and returns a wallet->stats map (keys lowercased)", async () => {
    const db = openDb(":memory:");
    const fetcher = vi.fn(async () => stats());
    const result = await getWalletStats(db, ["0xAAA"], { fetcher });
    expect(result["0xaaa"]).toEqual(stats());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves a fresh cache hit without calling the fetcher", async () => {
    const db = openDb(":memory:");
    const fetcher = vi.fn(async () => stats());
    await getWalletStats(db, ["0xAAA"], { fetcher, nowSec: 1000 });
    const second = await getWalletStats(db, ["0xAAA"], {
      fetcher,
      nowSec: 1000 + 100,
    });
    expect(second["0xaaa"]).toEqual(stats());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refetches after the TTL expires", async () => {
    const db = openDb(":memory:");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(stats())
      .mockResolvedValueOnce(stats({ netPnl: 2000 }));
    await getWalletStats(db, ["0xAAA"], { fetcher, nowSec: 1000 });
    const second = await getWalletStats(db, ["0xAAA"], {
      fetcher,
      nowSec: 1000 + 86_400, // exactly at TTL boundary → stale
    });
    expect(second["0xaaa"]?.netPnl).toBe(2000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns null for a throwing fetcher and does NOT cache it", async () => {
    const db = openDb(":memory:");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi
      .fn<() => Promise<WalletStats>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(stats());
    const first = await getWalletStats(db, ["0xAAA"], { fetcher });
    expect(first["0xaaa"]).toBeNull();
    const second = await getWalletStats(db, ["0xAAA"], { fetcher });
    expect(second["0xaaa"]).toEqual(stats());
    expect(fetcher).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("dedupes concurrent lookups for the same wallet via the in-flight map", async () => {
    const db1 = openDb(":memory:");
    const db2 = openDb(":memory:");
    let release!: (v: WalletStats) => void;
    const gate = new Promise<WalletStats>((r) => (release = r));
    const fetcher = vi.fn((_w: string) => gate);
    const inFlight = new Map<string, Promise<WalletStats>>();
    // Two overlapping calls (wallet page + daily seed enrichment) miss their
    // caches simultaneously — the second must JOIN the first's fetch (up to
    // DEFAULT_MAX_PAGES pages each for closed+open, plus the user-pnl call), not
    // start its own.
    const p1 = getWalletStats(db1, ["0xAAA"], { fetcher, inFlight });
    const p2 = getWalletStats(db2, ["0xAAA"], { fetcher, inFlight });
    release(stats());
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1["0xaaa"]).toEqual(stats());
    expect(r2["0xaaa"]).toEqual(stats());
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Entry removed on settle so a later cold call fetches fresh.
    expect(inFlight.size).toBe(0);
  });

  it("preserves null winRate/roi through the cache round-trip", async () => {
    const db = openDb(":memory:");
    const empty = stats({
      winRate: null,
      roi: null,
      settledCount: 0,
      netPnl: 0,
    });
    const fetcher = vi.fn(async () => empty);
    await getWalletStats(db, ["0xAAA"], { fetcher, nowSec: 1000 });
    const second = await getWalletStats(db, ["0xAAA"], {
      fetcher,
      nowSec: 1001,
    });
    expect(second["0xaaa"]).toEqual(empty);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("round-trips a truncated record AND a null netPnl through the SQLite cache", async () => {
    // Exercises the read path `!!row.truncated` (only ever seen as 0 elsewhere)
    // and a NULL realized_pnl column (the P0 degraded state) surviving the cache.
    const db = openDb(":memory:");
    const degraded = stats({ truncated: true, netPnl: null });
    const fetcher = vi.fn(async () => degraded);
    await getWalletStats(db, ["0xAAA"], { fetcher, nowSec: 1000 });
    const second = await getWalletStats(db, ["0xAAA"], {
      fetcher,
      nowSec: 1001,
    });
    expect(second["0xaaa"]).toEqual(degraded);
    expect(second["0xaaa"]?.truncated).toBe(true);
    expect(second["0xaaa"]?.netPnl).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
