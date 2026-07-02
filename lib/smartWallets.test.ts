import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import {
  computeScore,
  getAllSmartTags,
  getSmartTags,
  maybeDailySeed,
  seedSmartWallets,
} from "./smartWallets";
import type { LeaderboardRow } from "./leaderboard";
import type { WalletStats } from "./walletStats";

const lbRow = (wallet: string, pnl: number, vol: number): LeaderboardRow => ({
  rank: 1,
  proxyWallet: wallet,
  userName: "u",
  vol,
  pnl,
});

const stats = (over: Partial<WalletStats> = {}): WalletStats => ({
  winRate: 0.7,
  realizedPnl: 500_000,
  roi: 0.2,
  settledCount: 40,
  truncated: false,
  ...over,
});

describe("computeScore", () => {
  it("saturates at 100 for a big, efficient, high-win-rate wallet", () => {
    expect(computeScore({ pnl: 2_000_000, vol: 4_000_000, winRate: 1 })).toBe(
      100,
    );
  });
  it("gives an unknown win rate the neutral half credit", () => {
    // pnl 0, vol>0 → 0 + 0 + 30*0.5 = 15
    expect(computeScore({ pnl: 0, vol: 1000, winRate: null })).toBe(15);
  });
  it("never goes below 0 for a losing wallet", () => {
    expect(computeScore({ pnl: -50_000, vol: 100_000, winRate: 0 })).toBe(0);
  });
});

describe("seedSmartWallets", () => {
  it("merges boards per wallet, drops vol=0 rows, and enriches with settled stats", async () => {
    const db = openDb(":memory:");
    const fetchBoard = vi.fn(async ({ period }: { period: string }) =>
      period === "WEEK"
        ? [lbRow("0xAAA", 100_000, 1_000_000), lbRow("0xHOLD", 999_999, 0)]
        : [lbRow("0xaaa", 300_000, 2_000_000), lbRow("0xBBB", 50_000, 500_000)],
    );
    const statsFetcher = vi.fn(async () => stats());
    const r = await seedSmartWallets(db, {
      periods: ["WEEK", "ALL"],
      fetchBoard: fetchBoard as never,
      statsFetcher,
      nowSec: 1000,
    });
    expect(r.seeded).toBe(2); // 0xaaa merged across boards, 0xhold dropped
    expect(r.enriched).toBe(2);
    const tags = getSmartTags(db, ["0xAAA", "0xBBB", "0xHOLD"]);
    expect(tags["0xaaa"]).toBeDefined();
    // Settled realizedPnl (from stats) wins over the mark-to-market board pnl.
    expect(tags["0xaaa"]?.realizedPnl).toBe(500_000);
    expect(tags["0xaaa"]?.winRate).toBe(0.7);
    expect(tags["0xbbb"]).toBeDefined();
    expect(tags["0xhold"]).toBeUndefined();
  });

  it("preserves a manual whitelist flag across re-seeding", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO smart_wallets (address, is_whitelist) VALUES ('0xaaa', 1)",
    ).run();
    const fetchBoard = vi.fn(async () => [lbRow("0xaaa", 100_000, 1_000_000)]);
    await seedSmartWallets(db, {
      periods: ["ALL"],
      fetchBoard: fetchBoard as never,
      statsFetcher: async () => stats(),
      nowSec: 1000,
    });
    const tags = getSmartTags(db, ["0xaaa"]);
    expect(tags["0xaaa"]?.isWhitelist).toBe(true);
    expect(tags["0xaaa"]?.score).not.toBeNull();
  });

  it("continues seeding when one board fails", async () => {
    const db = openDb(":memory:");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchBoard = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([lbRow("0xaaa", 100_000, 1_000_000)]);
    const r = await seedSmartWallets(db, {
      periods: ["WEEK", "ALL"],
      fetchBoard: fetchBoard as never,
      statsFetcher: async () => stats(),
      nowSec: 1000,
    });
    expect(r.seeded).toBe(1);
    warnSpy.mockRestore();
  });
});

describe("seedSmartWallets retention", () => {
  it("evicts auto-seeded wallets stale for 30+ days but keeps manual whitelist rows", async () => {
    const db = openDb(":memory:");
    const NOW = 100 * 86_400;
    db.prepare(
      "INSERT INTO smart_wallets (address, is_whitelist, updated_at) VALUES ('0xstale', 0, ?), ('0xmanual', 1, ?), ('0xrecent', 0, ?)",
    ).run(NOW - 31 * 86_400, NOW - 31 * 86_400, NOW - 86_400);
    await seedSmartWallets(db, {
      periods: ["ALL"],
      fetchBoard: (async () => [lbRow("0xaaa", 100_000, 1_000_000)]) as never,
      statsFetcher: async () => stats(),
      nowSec: NOW,
    });
    const left = getSmartTags(db, ["0xstale", "0xmanual", "0xrecent", "0xaaa"]);
    expect(left["0xstale"]).toBeUndefined();
    expect(left["0xmanual"]).toBeDefined();
    expect(left["0xrecent"]).toBeDefined();
    expect(left["0xaaa"]).toBeDefined();
  });
});

describe("maybeDailySeed", () => {
  it("runs once per UTC day and returns null on repeat calls", async () => {
    const db = openDb(":memory:");
    const fetchBoard = vi.fn(async () => [lbRow("0xaaa", 1000, 1000)]);
    const opts = {
      periods: ["ALL"] as never,
      fetchBoard: fetchBoard as never,
      statsFetcher: async () => stats(),
      nowSec: 1_700_000_000,
    };
    const first = maybeDailySeed(db, opts);
    expect(first).not.toBeNull();
    await first;
    expect(maybeDailySeed(db, opts)).toBeNull();
    // Next UTC day → seeds again.
    const nextDay = maybeDailySeed(db, {
      ...opts,
      nowSec: 1_700_000_000 + 86_400,
    });
    expect(nextDay).not.toBeNull();
    await nextDay;
    expect(fetchBoard).toHaveBeenCalledTimes(2);
  });
});

describe("getAllSmartTags", () => {
  it("returns the full table as a map", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO smart_wallets (address, score, is_whitelist) VALUES ('0xaaa', 80, 0), ('0xbbb', 60, 1)",
    ).run();
    const map = getAllSmartTags(db);
    expect(map.size).toBe(2);
    expect(map.get("0xaaa")?.score).toBe(80);
    expect(map.get("0xbbb")?.isWhitelist).toBe(true);
  });
});
