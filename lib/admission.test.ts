import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import type { WalletStats } from "./walletStats";
import {
  evaluateAdmission,
  admitCandidates,
  maybeDailyDiscovery,
} from "./admission";
import { recordEvidence, type CandidateEvidence } from "./discovery";

const stats = (over: Partial<WalletStats> = {}): WalletStats => ({
  winRate: 0.65,
  netPnl: 40_000,
  roi: 0.12,
  settledCount: 30,
  truncated: false,
  marketsTraded: 50,
  isMarketMaker: false,
  ...over,
});

const ev = (
  address: string,
  channel: CandidateEvidence["channel"],
  conditionId: string,
): CandidateEvidence => ({
  address,
  channel,
  conditionId,
  ts: 1_000,
  usd: 6_000,
  price: 0.5,
  note: "n",
  title: "Test Market",
  slug: "test-market",
  eventSlug: "test-event",
  outcome: "Yes",
});

describe("evaluateAdmission", () => {
  it("hard-rejects market-maker bots", () => {
    expect(
      evaluateAdmission(stats({ isMarketMaker: true, winRate: null })),
    ).toBe("reject_bot");
  });
  it("admits on a solid settled win rate", () => {
    expect(evaluateAdmission(stats({ winRate: 0.55, settledCount: 10 }))).toBe(
      "admit",
    );
  });
  it("admits on positive netPnl with real capital efficiency over enough settled markets", () => {
    expect(
      evaluateAdmission(
        stats({ winRate: null, settledCount: 5, netPnl: 5_000, roi: 0.05 }),
      ),
    ).toBe("admit");
  });
  it("holds thin, weak, or unknowable records", () => {
    expect(evaluateAdmission(null)).toBe("hold");
    // win rate under the bar, roi under the bar
    expect(
      evaluateAdmission(stats({ winRate: 0.54, roi: 0.04, netPnl: 100 })),
    ).toBe("hold");
    // the ROI path has its own settled floor: one lucky $200 win reads as
    // roi>=5% but is noise, not capital efficiency
    expect(
      evaluateAdmission(
        stats({ winRate: null, settledCount: 1, netPnl: 5_000, roi: 0.5 }),
      ),
    ).toBe("hold");
    // good win rate but too few settled markets to trust it
    expect(
      evaluateAdmission(
        stats({ winRate: 0.9, settledCount: 9, roi: null, netPnl: null }),
      ),
    ).toBe("hold");
    // truncated record: winRate/roi are null by walletStats contract
    expect(
      evaluateAdmission(
        stats({ winRate: null, roi: null, truncated: true, netPnl: 9_999 }),
      ),
    ).toBe("hold");
  });
});

describe("admitCandidates", () => {
  it("enriches only recurrent candidates and admits with first-channel attribution", async () => {
    const db = openDb(":memory:");
    // 0xgood: 3 distinct markets (echo×2 + splitter×1) → evaluated, admitted
    // with the majority channel as its source.
    recordEvidence(
      db,
      [
        ev("0xgood", "echo", "0xm1"),
        ev("0xgood", "echo", "0xm2"),
        ev("0xgood", "splitter", "0xm3"),
        // 0xthin: only 2 markets → below the recurrence bar, never enriched
        ev("0xthin", "echo", "0xm1"),
        ev("0xthin", "echo", "0xm2"),
      ],
      1_000,
    );
    const fetcher = vi.fn(async () => stats());
    const r = await admitCandidates(db, {
      nowSec: 2_000,
      statsFetcher: fetcher as never,
    });
    expect(r.admitted).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1); // 0xthin never enriched
    const row = db
      .prepare(
        "SELECT source, score, win_rate, is_whitelist FROM smart_wallets WHERE address = '0xgood'",
      )
      .get() as {
      source: string;
      score: number;
      win_rate: number;
      is_whitelist: number;
    };
    expect(row.source).toBe("discovered:echo");
    expect(row.is_whitelist).toBe(0); // pool member, not manual whitelist
    expect(row.score).toBeGreaterThan(0);
    expect(row.win_rate).toBe(0.65);
  });

  it("skips wallets the pool already tracks via other pipelines, refreshes its own", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO smart_wallets (address, source, updated_at) VALUES ('0xboard', 'leaderboard', 100), ('0xmine', 'discovered:echo', 100)",
    ).run();
    for (const w of ["0xboard", "0xmine"]) {
      recordEvidence(
        db,
        [ev(w, "echo", "0xm1"), ev(w, "echo", "0xm2"), ev(w, "echo", "0xm3")],
        1_000,
      );
    }
    const fetcher = vi.fn(async () => stats());
    const r = await admitCandidates(db, {
      nowSec: 2_000,
      statsFetcher: fetcher as never,
    });
    // Only 0xmine re-evaluated: a still-qualifying discovered wallet gets its
    // updated_at renewed so the 30-day aging clock restarts.
    expect(r.admitted).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const mine = db
      .prepare("SELECT updated_at FROM smart_wallets WHERE address = '0xmine'")
      .get() as { updated_at: number };
    expect(mine.updated_at).toBe(2_000);
    const board = db
      .prepare("SELECT updated_at FROM smart_wallets WHERE address = '0xboard'")
      .get() as { updated_at: number };
    expect(board.updated_at).toBe(100); // untouched
  });

  it("re-qualifies a standing member on track record alone (no fresh evidence needed)", async () => {
    const db = openDb(":memory:");
    // In the pool, detectors skip the wallet, so it can never accrue new
    // evidence — the aging clock must renew on quality alone.
    db.prepare(
      "INSERT INTO smart_wallets (address, source, updated_at) VALUES ('0xmember', 'discovered:splitter', 100), ('0xdecayed', 'discovered:echo', 100)",
    ).run();
    const fetcher = vi.fn(async (w: string) =>
      w === "0xmember"
        ? stats()
        : stats({ winRate: 0.3, roi: -0.2, netPnl: -5_000 }),
    );
    const r = await admitCandidates(db, {
      nowSec: 2_000,
      statsFetcher: fetcher as never,
    });
    expect(r.evaluated).toBe(2);
    expect(r.admitted).toBe(1);
    const at = (a: string) =>
      (
        db
          .prepare("SELECT updated_at FROM smart_wallets WHERE address = ?")
          .get(a) as { updated_at: number }
      ).updated_at;
    expect(at("0xmember")).toBe(2_000); // renewed — survives the aging sweep
    expect(at("0xdecayed")).toBe(100); // quality decayed — left to age out
  });

  it("excludes persistently-classified bots from the evaluation slots", async () => {
    const db = openDb(":memory:");
    // A known bot with heavy evidence would otherwise take the only slot.
    db.prepare(
      "INSERT INTO wallet_stats (wallet, markets_traded, fetched_at) VALUES ('0xbot', 5000, 1)",
    ).run();
    for (const [w, markets] of [
      ["0xbot", ["0xm1", "0xm2", "0xm3", "0xm4"]],
      ["0xreal", ["0xm1", "0xm2", "0xm3"]],
    ] as const) {
      recordEvidence(
        db,
        markets.map((m) => ev(w, "echo", m)),
        1_000,
      );
    }
    const fetcher = vi.fn(async () => stats());
    const r = await admitCandidates(db, {
      nowSec: 2_000,
      maxEnrichPerRun: 1,
      statsFetcher: fetcher as never,
    });
    expect(r.admitted).toBe(1); // 0xreal got the slot, not the bot
    expect(db.prepare("SELECT address FROM smart_wallets").all()).toEqual([
      { address: "0xreal" },
    ]);
  });

  it("never admits bots or weak records", async () => {
    const db = openDb(":memory:");
    recordEvidence(
      db,
      [
        ev("0xbot", "echo", "0xm1"),
        ev("0xbot", "echo", "0xm2"),
        ev("0xbot", "echo", "0xm3"),
      ],
      1_000,
    );
    const fetcher = vi.fn(async () =>
      stats({ isMarketMaker: true, winRate: null, roi: null }),
    );
    const r = await admitCandidates(db, {
      nowSec: 2_000,
      statsFetcher: fetcher as never,
    });
    expect(r.admitted).toBe(0);
    expect(r.rejectedBot).toBe(1);
    const n = (
      db.prepare("SELECT COUNT(*) AS c FROM smart_wallets").get() as {
        c: number;
      }
    ).c;
    expect(n).toBe(0);
  });

  it("ignores evidence older than the recurrence window", async () => {
    const db = openDb(":memory:");
    const old = 1_000;
    recordEvidence(
      db,
      [
        ev("0xstale", "echo", "0xm1"),
        ev("0xstale", "echo", "0xm2"),
        ev("0xstale", "echo", "0xm3"),
      ],
      old,
    );
    const fetcher = vi.fn(async () => stats());
    const nowSec = old + 40 * 86_400; // evidence 40d old vs the 30d window
    const r = await admitCandidates(db, {
      nowSec,
      statsFetcher: fetcher as never,
    });
    expect(r.evaluated).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("maybeDailyDiscovery", () => {
  it("runs once per UTC day (scan + admission) and no-ops after", async () => {
    const db = openDb(":memory:");
    const marketsFetcher = vi.fn(async () => []);
    const statsFetcher = vi.fn(async () => stats());
    const p = maybeDailyDiscovery(db, {
      nowSec: 1_751_900_000,
      scan: { marketsFetcher: marketsFetcher as never },
      admission: { statsFetcher: statsFetcher as never },
    });
    expect(p).not.toBeNull();
    const r = await p!;
    expect(r.scan.scanned).toBe(0);
    expect(marketsFetcher).toHaveBeenCalledTimes(1);
    // Same day: gated off.
    expect(maybeDailyDiscovery(db, { nowSec: 1_751_900_100 })).toBeNull();
    // Next UTC day: runs again.
    const p2 = maybeDailyDiscovery(db, {
      nowSec: 1_751_900_000 + 86_400,
      scan: { marketsFetcher: marketsFetcher as never },
      admission: { statsFetcher: statsFetcher as never },
    });
    expect(p2).not.toBeNull();
    await p2!;
  });
});
