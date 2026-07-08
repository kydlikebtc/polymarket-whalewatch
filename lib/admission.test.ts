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
  it("admits on positive netPnl with real capital efficiency", () => {
    expect(
      evaluateAdmission(
        stats({ winRate: null, settledCount: 0, netPnl: 5_000, roi: 0.05 }),
      ),
    ).toBe("admit");
  });
  it("holds thin, weak, or unknowable records", () => {
    expect(evaluateAdmission(null)).toBe("hold");
    // win rate under the bar, roi under the bar
    expect(
      evaluateAdmission(stats({ winRate: 0.54, roi: 0.04, netPnl: 100 })),
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
