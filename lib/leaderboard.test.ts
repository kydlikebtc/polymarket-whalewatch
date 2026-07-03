import { describe, it, expect, vi } from "vitest";
import { fetchLeaderboard } from "./leaderboard";

// Live-shape row: rank is a STRING in the real API.
const row = (
  rank: number,
  wallet: string,
  over: Record<string, unknown> = {},
) => ({
  rank: String(rank),
  proxyWallet: wallet,
  userName: "u",
  vol: 1000,
  pnl: 500,
  ...over,
});

describe("fetchLeaderboard", () => {
  it("coerces string ranks, lowercases wallets, and stops on a short page", async () => {
    const page = [row(1, "0xAAA"), row(2, "0xBBB")];
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => page });
    vi.stubGlobal("fetch", fetchMock);
    const rows = await fetchLeaderboard({ period: "WEEK", maxEntries: 100 });
    expect(rows).toHaveLength(2);
    expect(rows[0].rank).toBe(1);
    expect(rows[0].proxyWallet).toBe("0xaaa");
    expect(fetchMock).toHaveBeenCalledTimes(1); // short page → no second request
    expect(fetchMock.mock.calls[0][0]).toContain("timePeriod=WEEK");
    expect(fetchMock.mock.calls[0][0]).toContain("orderBy=PNL");
  });

  it("paginates by offset up to maxEntries", async () => {
    const pageA = Array.from({ length: 50 }, (_, i) => row(i + 1, `0xa${i}`));
    const pageB = Array.from({ length: 50 }, (_, i) => row(i + 51, `0xb${i}`));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => pageA })
      .mockResolvedValueOnce({ ok: true, json: async () => pageB });
    vi.stubGlobal("fetch", fetchMock);
    const rows = await fetchLeaderboard({ period: "ALL", maxEntries: 100 });
    expect(rows).toHaveLength(100);
    expect(fetchMock.mock.calls[0][0]).toContain("offset=0");
    expect(fetchMock.mock.calls[1][0]).toContain("offset=50");
  });

  it("terminates when a clamped deep offset re-serves the same wallets", async () => {
    // The live API silently clamps deep offsets and repeats rows (no 4xx);
    // wallet dedup must stop the loop instead of spinning to the page cap.
    const samePage = Array.from({ length: 50 }, (_, i) =>
      row(i + 1, `0xa${i}`),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => samePage });
    vi.stubGlobal("fetch", fetchMock);
    const rows = await fetchLeaderboard({ period: "ALL", maxEntries: 500 });
    expect(rows).toHaveLength(50);
    expect(fetchMock).toHaveBeenCalledTimes(2); // page 2 made no progress → stop
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );
    await expect(fetchLeaderboard({ period: "WEEK" })).rejects.toThrow("400");
  });

  it("retries a transient 502 on a page then succeeds", async () => {
    const page = [row(1, "0xAAA")];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, json: async () => page });
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await fetchLeaderboard({ period: "WEEK", maxEntries: 50 });
    expect(rows).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("returns the collected prefix when a later page still fails after retries (partial beats none)", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pageA = Array.from({ length: 50 }, (_, i) => row(i + 1, `0xa${i}`));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => pageA })
      .mockResolvedValue({ ok: false, status: 502 }); // page 2: persistent 502
    vi.stubGlobal("fetch", fetchMock);
    const promise = fetchLeaderboard({ period: "ALL", maxEntries: 100 });
    await vi.runAllTimersAsync(); // drain the retry backoff sleeps
    const rows_ = await promise;
    expect(rows_).toHaveLength(50); // page 1 kept, not thrown away
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("returning 50 collected rows"),
    );
    warnSpy.mockRestore();
    vi.useRealTimers();
  });
});
