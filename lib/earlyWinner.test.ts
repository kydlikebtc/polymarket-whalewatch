import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import type { Trade } from "./types";
import {
  parseClosedTime,
  fetchRecentlyClosedMarkets,
  fetchMarketTrades,
  extractEarlyWinnerEvidence,
  runEarlyWinnerScan,
  type ClosedMarket,
} from "./earlyWinner";

let txSeq = 0;
const trade = (over: Partial<Trade> = {}): Trade => ({
  proxyWallet: "0xwallet",
  side: "BUY",
  asset: "tok1",
  conditionId: "0xc1",
  size: 10_000,
  price: 0.3,
  timestamp: 1_000,
  title: "Test Market",
  slug: "test-market",
  eventSlug: "test-event",
  outcome: "Yes",
  outcomeIndex: 0,
  transactionHash: `0xtx${txSeq++}`,
  ...over,
});

const CLOSE = 200_000; // market resolution time (unix sec)
const market: ClosedMarket = {
  conditionId: "0xc1",
  title: "Test Market",
  closedTimeSec: CLOSE,
  volume: 50_000,
  winnerIdx: 0,
  winnerOutcome: "Yes",
};

describe("parseClosedTime", () => {
  it("parses gamma's 'YYYY-MM-DD HH:MM:SS+00' format", () => {
    expect(parseClosedTime("2026-07-08 11:16:43+00")).toBe(
      Date.UTC(2026, 6, 8, 11, 16, 43) / 1000,
    );
  });
  it("parses plain ISO strings too", () => {
    expect(parseClosedTime("2026-07-08T11:16:43Z")).toBe(
      Date.UTC(2026, 6, 8, 11, 16, 43) / 1000,
    );
  });
  it("returns null on garbage", () => {
    expect(parseClosedTime("not a date")).toBeNull();
    expect(parseClosedTime("")).toBeNull();
  });
});

describe("extractEarlyWinnerEvidence", () => {
  it("aggregates a wallet's early cheap buys of the winning outcome", () => {
    const early = CLOSE - 2 * 86_400; // 2 days before resolution
    const trades = [
      trade({
        proxyWallet: "0xedge",
        size: 5_000,
        price: 0.2,
        timestamp: early,
      }),
      trade({
        proxyWallet: "0xedge",
        size: 5_000,
        price: 0.4,
        timestamp: early + 100,
      }),
    ];
    const out = extractEarlyWinnerEvidence(trades, market);
    expect(out).toHaveLength(1);
    expect(out[0].address).toBe("0xedge");
    expect(out[0].channel).toBe("early_winner");
    expect(out[0].usd).toBe(3_000); // 1000 + 2000
    expect(out[0].price).toBeCloseTo(0.3); // 3000 usd / 10000 shares
    expect(out[0].ts).toBe(early + 100);
  });

  it("excludes late buys, expensive buys, losing-outcome buys, sells, and dust", () => {
    const early = CLOSE - 2 * 86_400;
    const trades = [
      // inside the 24h pre-resolution window — that's sniping, not foresight
      trade({
        proxyWallet: "0xlate",
        size: 10_000,
        price: 0.3,
        timestamp: CLOSE - 3600,
      }),
      // cheap but on the LOSING outcome
      trade({
        proxyWallet: "0xwrong",
        size: 10_000,
        price: 0.3,
        outcome: "No",
        outcomeIndex: 1,
        timestamp: early,
      }),
      // early but at favorite odds — no contrarian edge
      trade({
        proxyWallet: "0xexp",
        size: 10_000,
        price: 0.7,
        timestamp: early,
      }),
      // a SELL of the winner
      trade({
        proxyWallet: "0xsell",
        side: "SELL",
        size: 10_000,
        price: 0.3,
        timestamp: early,
      }),
      // early + cheap + winner but only $150 — dust
      trade({ proxyWallet: "0xdust", size: 500, price: 0.3, timestamp: early }),
    ];
    expect(extractEarlyWinnerEvidence(trades, market)).toHaveLength(0);
  });

  it("drops both-sides buyers and pool wallets", () => {
    const early = CLOSE - 2 * 86_400;
    const trades = [
      // hedger: $3k early-cheap on the winner but $4k on the loser
      trade({
        proxyWallet: "0xhedge",
        size: 10_000,
        price: 0.3,
        timestamp: early,
      }),
      trade({
        proxyWallet: "0xhedge",
        size: 8_000,
        price: 0.5,
        outcome: "No",
        outcomeIndex: 1,
        timestamp: early,
      }),
      // clean early winner, but already in the pool
      trade({
        proxyWallet: "0xpool",
        size: 10_000,
        price: 0.3,
        timestamp: early,
      }),
    ];
    const out = extractEarlyWinnerEvidence(trades, market, {
      poolAddresses: new Set(["0xpool"]),
    });
    expect(out).toHaveLength(0);
  });
});

describe("fetchRecentlyClosedMarkets", () => {
  const gammaRow = (over: Record<string, unknown> = {}) => ({
    conditionId: "0xm1",
    question: "Q1",
    closedTime: "2026-07-08 10:00:00+00",
    volumeNum: 50_000,
    outcomes: '["Yes", "No"]',
    outcomePrices: '["1", "0"]',
    ...over,
  });

  it("parses rows, derives the winner, and filters thin/undecided markets", async () => {
    const rows = [
      gammaRow(),
      gammaRow({ conditionId: "0xthin", volumeNum: 500 }), // below volume floor
      gammaRow({ conditionId: "0xcancel", outcomePrices: '["0.5", "0.5"]' }), // no winner (refund)
    ];
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => rows });
    const out = await fetchRecentlyClosedMarkets({
      sinceSec: 0,
      minVolume: 10_000,
      fetcher: fetcher as never,
    });
    expect(out).toHaveLength(1);
    expect(out[0].conditionId).toBe("0xm1");
    expect(out[0].winnerIdx).toBe(0);
    expect(out[0].winnerOutcome).toBe("Yes");
    expect(fetcher.mock.calls[0][0]).toContain("closed=true");
    expect(fetcher.mock.calls[0][0]).toContain("order=closedTime");
  });

  it("stops paginating once rows age past sinceSec", async () => {
    const fresh = gammaRow({ closedTime: "2026-07-08 10:00:00+00" });
    const stale = gammaRow({
      conditionId: "0xold",
      closedTime: "2026-07-01 10:00:00+00",
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => [fresh, stale] });
    const sinceSec = Date.UTC(2026, 6, 7) / 1000; // July 7 — only 'fresh' qualifies
    const out = await fetchRecentlyClosedMarkets({
      sinceSec,
      fetcher: fetcher as never,
    });
    expect(out).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1); // stale row on page 1 → no page 2
  });
});

describe("fetchMarketTrades", () => {
  it("paginates the market-filtered feed and flags the offset-cap truncation", async () => {
    const page = (n: number) =>
      Array.from({ length: 250 }, (_, i) => trade({ timestamp: n * 1000 + i }));
    const fetcher = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => page(1),
    }));
    const r = await fetchMarketTrades("0xc1", {
      minUsd: 500,
      fetcher: fetcher as never,
    });
    // full pages until offset would pass 3000: offsets 0..3000 = 13 pages
    expect(fetcher.mock.calls.length).toBe(13);
    expect(r.truncated).toBe(true);
    expect(fetcher.mock.calls[0][0]).toContain("market=0xc1");
    expect(fetcher.mock.calls[0][0]).toContain("filterAmount=500");
  });

  it("stops on a short page without the truncation flag", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => [trade()],
    }));
    const r = await fetchMarketTrades("0xc1", { fetcher: fetcher as never });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(r.truncated).toBe(false);
    expect(r.trades).toHaveLength(1);
  });
});

describe("runEarlyWinnerScan", () => {
  const early = CLOSE - 2 * 86_400;

  it("scans unscanned markets once, records evidence + the scan cursor", async () => {
    const db = openDb(":memory:");
    const marketsFetcher = vi.fn(async () => [market]);
    const tradesFetcher = vi.fn(async () => ({
      trades: [
        trade({
          proxyWallet: "0xedge",
          size: 10_000,
          price: 0.3,
          timestamp: early,
        }),
      ],
      truncated: false,
    }));
    const r1 = await runEarlyWinnerScan(db, {
      nowSec: CLOSE + 3600,
      marketsFetcher: marketsFetcher as never,
      tradesFetcher: tradesFetcher as never,
    });
    expect(r1.scanned).toBe(1);
    expect(r1.inserted).toBe(1);
    const ev = db
      .prepare("SELECT address, channel FROM wallet_candidates")
      .all();
    expect(ev).toEqual([{ address: "0xedge", channel: "early_winner" }]);

    // Second run: the cursor row makes the market a no-op (closed markets are
    // immutable — one scan is forever).
    const r2 = await runEarlyWinnerScan(db, {
      nowSec: CLOSE + 7200,
      marketsFetcher: marketsFetcher as never,
      tradesFetcher: tradesFetcher as never,
    });
    expect(r2.scanned).toBe(0);
    expect(tradesFetcher).toHaveBeenCalledTimes(1);
  });

  it("skips pool wallets and leaves failed markets un-cursored for a retry", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO smart_wallets (address, is_whitelist) VALUES ('0xpool', 0)",
    ).run();
    const m2: ClosedMarket = { ...market, conditionId: "0xc2" };
    const marketsFetcher = vi.fn(async () => [market, m2]);
    const tradesFetcher = vi.fn(async (cid: string) => {
      if (cid === "0xc2") throw new Error("boom");
      return {
        trades: [
          trade({
            proxyWallet: "0xpool",
            size: 10_000,
            price: 0.3,
            timestamp: early,
          }),
        ],
        truncated: false,
      };
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await runEarlyWinnerScan(db, {
      nowSec: CLOSE + 3600,
      marketsFetcher: marketsFetcher as never,
      tradesFetcher: tradesFetcher as never,
    });
    warnSpy.mockRestore();
    expect(r.scanned).toBe(1); // only 0xc1 completed
    expect(r.inserted).toBe(0); // pool wallet is not a discovery
    const cursors = db
      .prepare("SELECT condition_id FROM early_winner_scans")
      .all() as { condition_id: string }[];
    expect(cursors).toEqual([{ condition_id: "0xc1" }]); // 0xc2 retries next run
  });
});
