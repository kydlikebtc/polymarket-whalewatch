import { describe, it, expect } from "vitest";
import { mergeStatsBatch } from "./useWalletIntel";
import type { WalletStatsLite } from "./ui";

const wl = (over: Partial<WalletStatsLite> = {}): WalletStatsLite => ({
  winRate: 0.6,
  netPnl: 1000,
  roi: 0.2,
  settledCount: 10,
  truncated: false,
  ...over,
});

describe("mergeStatsBatch", () => {
  it("resolves a wallet with a WalletStats object (kept, not retried)", () => {
    const r = mergeStatsBatch(["0xa"], {
      stats: { "0xa": wl() },
      smart: { "0xa": { score: 80, isWhitelist: true } },
    });
    expect(r.stats).toEqual({ "0xa": wl() });
    expect(r.smart).toEqual({ "0xa": { score: 80, isWhitelist: true } });
    expect(r.retry).toEqual([]);
  });

  it("treats settledCount:0 as RESOLVED (genuine no history), NOT a retry", () => {
    // The critical distinction: a wallet that was successfully fetched but has
    // no settled markets must NOT be retried forever — it renders a stable "—".
    const empty = wl({ winRate: null, roi: null, settledCount: 0, netPnl: 0 });
    const r = mergeStatsBatch(["0xa"], { stats: { "0xa": empty } });
    expect(r.stats).toEqual({ "0xa": empty });
    expect(r.retry).toEqual([]);
  });

  it("marks a NULL stat for retry (server-side fetch failed, not cached)", () => {
    const r = mergeStatsBatch(["0xa"], { stats: { "0xa": null } });
    expect(r.stats).toEqual({}); // never write a sticky null
    expect(r.retry).toEqual(["0xa"]);
  });

  it("marks a wallet MISSING from the response for retry", () => {
    const r = mergeStatsBatch(["0xa", "0xb"], { stats: { "0xa": wl() } });
    expect(r.stats).toEqual({ "0xa": wl() });
    expect(r.retry).toEqual(["0xb"]);
  });

  it("a malformed response (no stats/smart) retries every wallet, smart→null", () => {
    const r = mergeStatsBatch(["0xa", "0xb"], {});
    expect(r.stats).toEqual({});
    expect(r.retry).toEqual(["0xa", "0xb"]);
    expect(r.smart).toEqual({ "0xa": null, "0xb": null });
  });

  it("splits a mixed batch: resolved kept, failed retried", () => {
    const r = mergeStatsBatch(["0xok", "0xfail", "0xempty"], {
      stats: {
        "0xok": wl({ netPnl: 5000 }),
        "0xfail": null,
        "0xempty": wl({ settledCount: 0, winRate: null }),
      },
      smart: { "0xok": { score: 90, isWhitelist: false } },
    });
    expect(Object.keys(r.stats).sort()).toEqual(["0xempty", "0xok"]);
    expect(r.retry).toEqual(["0xfail"]);
    expect(r.smart["0xfail"]).toBeNull();
  });
});
