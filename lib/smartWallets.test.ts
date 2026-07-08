import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import {
  computeScore,
  getAllSmartTags,
  getSmartPoolStatus,
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
  netPnl: 500_000,
  roi: 0.2,
  settledCount: 40,
  truncated: false,
  marketsTraded: 30,
  isMarketMaker: false,
  ...over,
});

describe("computeScore", () => {
  it("saturates at 100 for a big, efficient, high-win-rate wallet", () => {
    // 40 + 30 + 30*0.99 = 99.7 → 100
    expect(
      computeScore({ pnl: 2_000_000, vol: 4_000_000, winRate: 0.99 }),
    ).toBe(100);
  });
  it("gives an unknown win rate the neutral half credit", () => {
    // pnl 0, vol>0 → 0 + 0 + 30*0.5 = 15
    expect(computeScore({ pnl: 0, vol: 1000, winRate: null })).toBe(15);
  });
  it("never goes below 0 for a losing wallet", () => {
    expect(computeScore({ pnl: -50_000, vol: 100_000, winRate: 0 })).toBe(0);
  });
  it("takes a COMPLETE perfect record at face value (survivorship fixed upstream)", () => {
    // walletStats merges held-to-zero losers from /positions, so an
    // untruncated 100% is honest: 40 + 30 + 30 = 100.
    expect(computeScore({ pnl: 2_000_000, vol: 4_000_000, winRate: 1 })).toBe(
      100,
    );
    // …but the same record with a page-cap truncation keeps the haircut:
    // 40 + 30 + 30*0.9 = 97.
    expect(
      computeScore({
        pnl: 2_000_000,
        vol: 4_000_000,
        winRate: 1,
        truncated: true,
      }),
    ).toBe(97);
  });
  it("haircuts a truncated record's win-rate axis", () => {
    // 30*0.8 = 24 untruncated; 30*(0.8*0.9) = 21.6 → 22 truncated.
    expect(computeScore({ pnl: 0, vol: 1000, winRate: 0.8 })).toBe(24);
    expect(
      computeScore({ pnl: 0, vol: 1000, winRate: 0.8, truncated: true }),
    ).toBe(22);
  });
  it("scores the efficiency axis on the settled roi when present", () => {
    // roi 0.2 saturates the 30-pt axis even though lb pnl/vol would give 0.
    expect(
      computeScore({ pnl: 0, vol: 1_000_000, winRate: null, roi: 0.2 }),
    ).toBe(45);
    expect(computeScore({ pnl: 0, vol: 1_000_000, winRate: null })).toBe(15);
  });
  it("clamps a negative roi to zero instead of falling back to pnl/vol", () => {
    // pnlNorm 0.5 → 20; roi -0.2 → eff 0 (NOT the saturated pnl/vol=500);
    // wr 0.5 → 15.
    expect(
      computeScore({ pnl: 500_000, vol: 1000, winRate: 0.5, roi: -0.2 }),
    ).toBe(35);
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
    // Authoritative netPnl (from stats) wins over the leaderboard board pnl.
    expect(tags["0xaaa"]?.netPnl).toBe(500_000);
    expect(tags["0xaaa"]?.winRate).toBe(0.7);
    expect(tags["0xbbb"]).toBeDefined();
    expect(tags["0xhold"]).toBeUndefined();
  });

  it("stamps new rows source='leaderboard' but never overwrites an existing source", async () => {
    const db = openDb(":memory:");
    // A wallet discovered earlier by the firehose channel: seeding must keep
    // its first-discoverer attribution (the effectiveness scorecard needs to
    // know which channel found it FIRST, not which touched it last).
    db.prepare(
      "INSERT INTO smart_wallets (address, source, updated_at) VALUES ('0xdisc', 'discovered:echo', 500)",
    ).run();
    const fetchBoard = vi.fn(async () => [
      lbRow("0xdisc", 200_000, 1_000_000),
      lbRow("0xnew", 100_000, 1_000_000),
    ]);
    await seedSmartWallets(db, {
      periods: ["ALL"],
      fetchBoard: fetchBoard as never,
      statsFetcher: async () => stats(),
      nowSec: 1000,
    });
    const rows = db
      .prepare("SELECT address, source FROM smart_wallets ORDER BY address")
      .all() as { address: string; source: string | null }[];
    expect(rows.find((r) => r.address === "0xdisc")?.source).toBe(
      "discovered:echo",
    );
    expect(rows.find((r) => r.address === "0xnew")?.source).toBe("leaderboard");
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

  it("keeps the PAIRED pnl/vol row from the best-pnl board when merging", async () => {
    const db = openDb(":memory:");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // WEEK is the best-pnl board (300k @ 500k vol); ALL has the bigger vol.
    // The old max-per-column merge would have stored the meaningless
    // cross-board pair (pnl 300k, vol 2M).
    const fetchBoard = vi.fn(async ({ period }: { period: string }) =>
      period === "WEEK"
        ? [lbRow("0xaaa", 300_000, 500_000)]
        : [lbRow("0xaaa", 100_000, 2_000_000)],
    );
    // Stats fetch fails → un-enriched, so the stored row is pure leaderboard.
    const r = await seedSmartWallets(db, {
      periods: ["WEEK", "ALL"],
      fetchBoard: fetchBoard as never,
      statsFetcher: async () => {
        throw new Error("stats down");
      },
      nowSec: 1000,
    });
    expect(r.enriched).toBe(0);
    const row = db
      .prepare(
        "SELECT realized_pnl, volume FROM smart_wallets WHERE address = '0xaaa'",
      )
      .get() as { realized_pnl: number; volume: number };
    expect(row.realized_pnl).toBe(300_000);
    expect(row.volume).toBe(500_000); // paired with the WEEK pnl, not max(vol)
    warnSpy.mockRestore();
  });

  it("enriches the WHOLE merged pool by default and logs coverage", async () => {
    const db = openDb(":memory:");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // 120 wallets > the old enrichTop=100 default — all must be enriched now.
    const rows = Array.from({ length: 120 }, (_, i) =>
      lbRow(`0x${String(i).padStart(3, "0")}`, 1000 + i, 10_000),
    );
    const statsFetcher = vi.fn(async () => stats());
    const r = await seedSmartWallets(db, {
      periods: ["ALL"],
      fetchBoard: (async () => rows) as never,
      statsFetcher,
      nowSec: 1000,
    });
    expect(r.seeded).toBe(120);
    expect(r.enriched).toBe(120);
    expect(statsFetcher).toHaveBeenCalledTimes(120);
    expect(
      logSpy.mock.calls.some((c) =>
        String(c[0]).includes("enrichment coverage 120/120 (100%)"),
      ),
    ).toBe(true);
    logSpy.mockRestore();
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

  it("rolls back to a retry marker on failure and retries the SAME day after the delay", async () => {
    const db = openDb(":memory:");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const T = 1_700_000_000; // 22:13 UTC — offsets below stay inside the day
    let boardUp = false;
    const fetchBoard = vi.fn(async () => {
      if (!boardUp) throw new Error("data-api down");
      return [lbRow("0xaaa", 1000, 1000)];
    });
    const opts = {
      periods: ["ALL"] as never,
      fetchBoard: fetchBoard as never,
      statsFetcher: async () => stats(),
    };
    const first = maybeDailySeed(db, { ...opts, nowSec: T });
    expect(first).not.toBeNull();
    expect((await first!).seeded).toBe(0); // every board failed
    // Before the retry delay: still gated (no hammering the boards).
    expect(maybeDailySeed(db, { ...opts, nowSec: T + 60 })).toBeNull();
    // After the delay the seed retries — and succeeds this time.
    boardUp = true;
    const retry = maybeDailySeed(db, { ...opts, nowSec: T + 901 });
    expect(retry).not.toBeNull();
    expect((await retry!).seeded).toBe(1);
    // Success consumes the day for real.
    expect(maybeDailySeed(db, { ...opts, nowSec: T + 2000 })).toBeNull();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("also rolls back when seedSmartWallets throws (not just empty boards)", async () => {
    const db = openDb(":memory:");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const T = 1_700_000_000;
    // A malformed row makes seedSmartWallets itself throw (the rows loop sits
    // outside the per-board try/catch).
    const badBoard = async () => [
      { rank: 1, proxyWallet: undefined, userName: "", vol: 5, pnl: 5 },
    ];
    await expect(
      maybeDailySeed(db, {
        periods: ["ALL"] as never,
        fetchBoard: badBoard as never,
        statsFetcher: async () => stats(),
        nowSec: T,
      }),
    ).rejects.toThrow();
    // Day marker became a retry marker, not consumed: a good board seeds the
    // same day once the delay passes.
    const good = maybeDailySeed(db, {
      periods: ["ALL"] as never,
      fetchBoard: (async () => [lbRow("0xaaa", 1000, 1000)]) as never,
      statsFetcher: async () => stats(),
      nowSec: T + 901,
    });
    expect(good).not.toBeNull();
    expect((await good!).seeded).toBe(1);
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("caps same-day retries and resumes the next UTC day", async () => {
    const db = openDb(":memory:");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const T = 1_700_000_000;
    const failing = vi.fn(async () => {
      throw new Error("down all day");
    });
    const opts = {
      periods: ["ALL"] as never,
      fetchBoard: failing as never,
      statsFetcher: async () => stats(),
    };
    // 4 attempts (initial + 3 retries), each after the previous retry window.
    for (const dt of [0, 1000, 2000, 3000]) {
      const p = maybeDailySeed(db, { ...opts, nowSec: T + dt });
      expect(p).not.toBeNull();
      await p;
    }
    // Attempt cap reached — even a wide-open retry window stays gated.
    expect(maybeDailySeed(db, { ...opts, nowSec: T + 4000 })).toBeNull();
    // The next UTC day starts fresh.
    const nextDay = maybeDailySeed(db, { ...opts, nowSec: T + 86_400 });
    expect(nextDay).not.toBeNull();
    await nextDay;
    expect(failing).toHaveBeenCalledTimes(5);
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("blocks overlapping seeds with the in-process in-flight flag", async () => {
    const db = openDb(":memory:");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const T = 1_700_000_000;
    let release!: (rows: LeaderboardRow[]) => void;
    const gate = new Promise<LeaderboardRow[]>((res) => {
      release = res;
    });
    const opts = {
      periods: ["ALL"] as never,
      statsFetcher: async () => stats(),
    };
    const p = maybeDailySeed(db, {
      ...opts,
      fetchBoard: (() => gate) as never,
      nowSec: T,
    });
    expect(p).not.toBeNull();
    // Even a next-day trigger is refused while the first seed is running.
    expect(
      maybeDailySeed(db, {
        ...opts,
        fetchBoard: (async () => []) as never,
        nowSec: T + 86_400,
      }),
    ).toBeNull();
    release([lbRow("0xaaa", 1000, 1000)]);
    await p;
    // Flag released: the next day seeds normally again.
    const nextDay = maybeDailySeed(db, {
      ...opts,
      fetchBoard: (async () => [lbRow("0xbbb", 1000, 1000)]) as never,
      nowSec: T + 86_400,
    });
    expect(nextDay).not.toBeNull();
    await nextDay;
    logSpy.mockRestore();
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

describe("getSmartPoolStatus", () => {
  const NOW = 1_700_000_000;

  it("counts the whitelist and only the last-24h 'smart' alerts", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO smart_wallets (address, score) VALUES ('0xaaa', 80), ('0xbbb', 60)",
    ).run();
    const ins = db.prepare(
      "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES (?, ?, '{}', ?)",
    );
    ins.run("smart", "k1", NOW - 100); // in window
    ins.run("smart", "k2", NOW - 86_400 - 1); // aged out
    ins.run("large", "k3", NOW - 100); // wrong type
    expect(getSmartPoolStatus(db, NOW)).toEqual({
      smartWalletCount: 2,
      smartAlerts24h: 1,
    });
  });

  it("empty tables report zero (an EMPTY pool is a real answer, not unknown)", () => {
    const db = openDb(":memory:");
    expect(getSmartPoolStatus(db, NOW)).toEqual({
      smartWalletCount: 0,
      smartAlerts24h: 0,
    });
  });

  it("a missing table degrades that counter to null without throwing", () => {
    const db = openDb(":memory:");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.prepare("DROP TABLE smart_wallets").run();
    expect(getSmartPoolStatus(db, NOW)).toEqual({
      smartWalletCount: null,
      smartAlerts24h: 0,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("pool-status"),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });
});
