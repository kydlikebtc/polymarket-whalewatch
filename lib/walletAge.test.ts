import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import { fetchFirstActivityTs, getWalletAges } from "./walletAge";

// Stub the /activity endpoint per request. The API's SORT is untrustworthy,
// so fetchFirstActivityTs must verify its candidate with `end` probes.
const page = (rows: number[]) => ({
  ok: true,
  json: async () => rows.map((timestamp) => ({ timestamp })),
});

describe("fetchFirstActivityTs (probe-verified)", () => {
  it("returns the sorted candidate once the end-probe proves nothing older", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([100, 120, 150])) // sorted query
      .mockResolvedValueOnce(page([])); // end=99 probe → empty = verified
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchFirstActivityTs("0xabc")).resolves.toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("sortBy=TIMESTAMP");
    expect(fetchMock.mock.calls[1][0]).toContain("end=99");
  });

  it("walks past a LYING sort: probe finds older rows → candidate moves down", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([500])) // sort claims 500 is first (wrong)
      .mockResolvedValueOnce(page([450, 300])) // end=499 → older rows exist
      .mockResolvedValueOnce(page([])); // end=299 → verified
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchFirstActivityTs("0xabc")).resolves.toBe(300);
    expect(fetchMock.mock.calls[2][0]).toContain("end=299");
  });

  it("returns null for a wallet with no activity", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(page([]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchFirstActivityTs("0xabc")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps probing and returns the best candidate for a hyperactive wallet", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let ts = 1000;
    const fetchMock = vi.fn(async () => {
      ts -= 10;
      return page([ts]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchFirstActivityTs("0xabc");
    expect(result).toBe(1000 - 10 * 9); // sorted call + 8 probes, best seen
    expect(fetchMock).toHaveBeenCalledTimes(9);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unverified"));
    warnSpy.mockRestore();
  });
});

describe("getWalletAges", () => {
  it("fetches misses and returns a wallet->firstTs map", async () => {
    const db = openDb(":memory:");
    const fetcher = vi.fn(async (w: string) =>
      w === "0xaaa" ? 1700000000 : 1600000000,
    );
    const result = await getWalletAges(db, ["0xAAA", "0xBBB"], { fetcher });
    expect(result).toEqual({ "0xaaa": 1700000000, "0xbbb": 1600000000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("hits the cache on a second call and does NOT call the fetcher again", async () => {
    const db = openDb(":memory:");
    const fetcher = vi.fn(async () => 1700000000);
    await getWalletAges(db, ["0xAAA"], { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const second = await getWalletAges(db, ["0xAAA"], { fetcher });
    expect(second).toEqual({ "0xaaa": 1700000000 });
    // still 1 — the second lookup was served from SQLite, not the fetcher.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not drop wallets when the concurrency cap is below the wallet count", async () => {
    const db = openDb(":memory:");
    const wallets = Array.from({ length: 10 }, (_, i) => `0x${i}`);
    const fetcher = vi.fn(async (w: string) => Number(w.slice(2)) + 1);
    const result = await getWalletAges(db, wallets, {
      concurrency: 3,
      fetcher,
    });
    expect(Object.keys(result)).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(result[`0x${i}`]).toBe(i + 1);
    }
    expect(fetcher).toHaveBeenCalledTimes(10);
  });

  it("returns null for a fetcher that throws and does NOT cache it (next call retries)", async () => {
    const db = openDb(":memory:");
    const fetcher = vi
      .fn<(w: string) => Promise<number | null>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(1700000000);
    const first = await getWalletAges(db, ["0xAAA"], { fetcher });
    expect(first).toEqual({ "0xaaa": null });
    // Not cached → a retry actually re-invokes the fetcher and now resolves.
    const second = await getWalletAges(db, ["0xAAA"], { fetcher });
    expect(second).toEqual({ "0xaaa": 1700000000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("caches a successful null-free lookup so a real first_ts persists across calls", async () => {
    const db = openDb(":memory:");
    const fetcher = vi.fn(async () => 1650000000);
    await getWalletAges(db, ["0xABC"], { fetcher });
    const row = db
      .prepare("SELECT first_ts FROM wallet_age WHERE wallet = ?")
      .get("0xabc") as { first_ts: number } | undefined;
    expect(row?.first_ts).toBe(1650000000);
  });
});
