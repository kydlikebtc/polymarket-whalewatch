import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import { runAlertCycle } from "./alertEngine";
import { DEFAULT_CONDITIONS, type AlertConditions } from "./alertConditions";
import { dedupKey } from "./trades";
import { markSeen } from "./seen";
import type { Trade } from "./types";

// Trade factory. size*price = notional; defaults clear the 10k default minUsd.
const mk = (over: Partial<Trade> = {}): Trade =>
  ({
    transactionHash: "0xtx",
    asset: "asset1",
    proxyWallet: "0xWALLET",
    side: "BUY",
    size: 100000,
    price: 0.5,
    timestamp: 1000,
    title: "Market",
    slug: "slug",
    eventSlug: "event",
    outcome: "Yes",
    outcomeIndex: 0,
    conditionId: "0xc",
    ...over,
  }) as Trade;

const cond = (over: Partial<AlertConditions> = {}): AlertConditions => ({
  ...DEFAULT_CONDITIONS,
  ...over,
});

const countAlerts = (db: ReturnType<typeof openDb>) =>
  (db.prepare("SELECT COUNT(*) AS c FROM alerts").get() as { c: number }).c;

const noAges = async () => ({});

describe("runAlertCycle", () => {
  it("(a) only trades passing ALL conditions are sent + recorded", async () => {
    const db = openDb(":memory:");
    const pass = mk({ transactionHash: "0xpass", size: 100000, price: 0.5 }); // $50k
    const tooSmall = mk({ transactionHash: "0xsmall", size: 100, price: 0.5 }); // $50
    const send = vi.fn().mockResolvedValue(undefined);

    const fired = await runAlertCycle({
      db,
      fetchTrades: async () => [pass, tooSmall],
      conditions: cond({ minUsd: 10000 }),
      getAges: noAges,
      send,
      minTimestamp: 0,
    });

    expect(fired).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(countAlerts(db)).toBe(1);
    // both fresh trades were marked seen (so neither re-fires next cycle)
    const seen = db.prepare("SELECT COUNT(*) AS c FROM seen_trades").get() as {
      c: number;
    };
    expect(seen.c).toBe(2);
  });

  it("(b) side filter keeps only the matching side", async () => {
    const db = openDb(":memory:");
    const buy = mk({ transactionHash: "0xbuy", side: "BUY" });
    const sell = mk({ transactionHash: "0xsell", side: "SELL" });
    const send = vi.fn().mockResolvedValue(undefined);

    const fired = await runAlertCycle({
      db,
      fetchTrades: async () => [buy, sell],
      conditions: cond({ side: "SELL", minUsd: 10000 }),
      getAges: noAges,
      send,
      minTimestamp: 0,
    });

    expect(fired).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("(c) price-band filter drops out-of-band trades", async () => {
    const db = openDb(":memory:");
    const inBand = mk({ transactionHash: "0xin", price: 0.5, size: 100000 });
    const tooLow = mk({ transactionHash: "0xlow", price: 0.1, size: 1000000 });
    const tooHigh = mk({
      transactionHash: "0xhigh",
      price: 0.95,
      size: 1000000,
    });
    const send = vi.fn().mockResolvedValue(undefined);

    const fired = await runAlertCycle({
      db,
      fetchTrades: async () => [inBand, tooLow, tooHigh],
      conditions: cond({ minPrice: 0.3, maxPrice: 0.8, minUsd: 10000 }),
      getAges: noAges,
      send,
      minTimestamp: 0,
    });

    expect(fired).toBe(1);
  });

  it("(d) age filter drops too-old and unknown-age wallets", async () => {
    const db = openDb(":memory:");
    const young = mk({ transactionHash: "0xy", proxyWallet: "0xYOUNG" });
    const old = mk({ transactionHash: "0xo", proxyWallet: "0xOLD" });
    const unknown = mk({ transactionHash: "0xu", proxyWallet: "0xUNKNOWN" });
    const send = vi.fn().mockResolvedValue(undefined);

    const getAges = vi.fn(
      async (_wallets: string[]): Promise<Record<string, number | null>> => ({
        "0xyoung": 3,
        "0xold": 99,
        "0xunknown": null,
      }),
    );

    const fired = await runAlertCycle({
      db,
      fetchTrades: async () => [young, old, unknown],
      conditions: cond({ maxAgeDays: 7, minUsd: 10000 }),
      getAges,
      send,
      minTimestamp: 0,
    });

    expect(fired).toBe(1); // only the young wallet
    expect(send).toHaveBeenCalledTimes(1);
    // getAges asked for the distinct lowercased survivor wallets
    expect(getAges).toHaveBeenCalledTimes(1);
    const asked = getAges.mock.calls[0][0];
    expect(new Set(asked)).toEqual(new Set(["0xyoung", "0xold", "0xunknown"]));
  });

  it("(e) timestamp gate: pre-window trades never fire but are seeded seen once", async () => {
    const db = openDb(":memory:");
    const fresh = mk({ transactionHash: "0xfresh", timestamp: 2000 });
    const stale = mk({ transactionHash: "0xstale", timestamp: 500 });
    const send = vi.fn().mockResolvedValue(undefined);
    const deps = {
      db,
      fetchTrades: async () => [fresh, stale],
      conditions: cond({ minUsd: 10000 }),
      getAges: noAges,
      send,
      minTimestamp: 1000,
    };

    expect(await runAlertCycle(deps)).toBe(1);
    expect(send).toHaveBeenCalledTimes(1); // only the fresh trade
    // The stale trade IS marked seen (backlog seed, with its own ts) so the
    // same historical row isn't re-fetched-and-re-checked every cycle…
    const staleSeen = db
      .prepare("SELECT ts FROM seen_trades WHERE dedup_key = ?")
      .get(dedupKey(stale)) as { ts: number } | undefined;
    expect(staleSeen?.ts).toBe(500);
    // …and it still never fires on a later cycle.
    expect(await runAlertCycle(deps)).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("(f) disabled conditions fire nothing", async () => {
    const db = openDb(":memory:");
    const send = vi.fn().mockResolvedValue(undefined);
    const fetchTrades = vi.fn(async () => [mk()]);

    const fired = await runAlertCycle({
      db,
      fetchTrades,
      conditions: cond({ enabled: false }),
      getAges: noAges,
      send,
      minTimestamp: 0,
    });

    expect(fired).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("(g) a second cycle with the same feed fires nothing (seen dedup)", async () => {
    const db = openDb(":memory:");
    const t = mk();
    const send = vi.fn().mockResolvedValue(undefined);
    const deps = {
      db,
      fetchTrades: async () => [t],
      conditions: cond({ minUsd: 10000 }),
      getAges: noAges,
      send,
      minTimestamp: 0,
    };

    expect(await runAlertCycle(deps)).toBe(1);
    expect(await runAlertCycle(deps)).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("(i) smart-wallet trades get the 🏆 tag and type='smart'", async () => {
    const db = openDb(":memory:");
    const smartTrade = mk({ transactionHash: "0xs", proxyWallet: "0xSMART" });
    const plainTrade = mk({ transactionHash: "0xp", proxyWallet: "0xPLAIN" });
    const send = vi.fn().mockResolvedValue(undefined);
    const getSmart = vi.fn((_wallets: string[]) => ({
      "0xsmart": { score: 82 },
    }));

    const fired = await runAlertCycle({
      db,
      fetchTrades: async () => [smartTrade, plainTrade],
      conditions: cond({ minUsd: 10000 }),
      getAges: noAges,
      getSmart,
      send,
      minTimestamp: 0,
    });

    expect(fired).toBe(2);
    const sent = send.mock.calls.map((c) => c[0] as string);
    expect(sent.some((m) => m.includes("🏆 聪明钱(82)"))).toBe(true);
    const types = db
      .prepare("SELECT type, dedup_key FROM alerts ORDER BY id")
      .all() as { type: string; dedup_key: string }[];
    expect(new Set(types.map((r) => r.type))).toEqual(
      new Set(["smart", "large"]),
    );
    expect(types.find((r) => r.dedup_key === dedupKey(smartTrade))?.type).toBe(
      "smart",
    );
  });

  it("(j) smartOnly keeps only smart-wallet trades (and matches nothing without getSmart)", async () => {
    const db = openDb(":memory:");
    const smartTrade = mk({ transactionHash: "0xs", proxyWallet: "0xSMART" });
    const plainTrade = mk({ transactionHash: "0xp", proxyWallet: "0xPLAIN" });
    const send = vi.fn().mockResolvedValue(undefined);

    const fired = await runAlertCycle({
      db,
      fetchTrades: async () => [smartTrade, plainTrade],
      conditions: cond({ minUsd: 10000, smartOnly: true }),
      getAges: noAges,
      getSmart: () => ({ "0xsmart": { score: null } }),
      send,
      minTimestamp: 0,
    });
    expect(fired).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0] as string).toContain("🏆 聪明钱");

    // Without a getSmart dep there is no whitelist — smartOnly matches nothing.
    const db2 = openDb(":memory:");
    const fired2 = await runAlertCycle({
      db: db2,
      fetchTrades: async () => [mk()],
      conditions: cond({ minUsd: 10000, smartOnly: true }),
      getAges: noAges,
      send,
      minTimestamp: 0,
    });
    expect(fired2).toBe(0);
  });

  it("(k) maxHoursToEnd keeps only pre-settlement trades and enriches the alert", async () => {
    const db = openDb(":memory:");
    const NOW = Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000);
    const soon = mk({ transactionHash: "0xsoon", conditionId: "0xsoon" });
    const far = mk({ transactionHash: "0xfar", conditionId: "0xfar" });
    const unknown = mk({ transactionHash: "0xunk", conditionId: "0xunk" });
    const send = vi.fn().mockResolvedValue(undefined);
    const metaFor = (cid: string, endDate: string) => ({
      conditionId: cid,
      volume24hr: 100_000,
      liquidity: 50_000,
      endDate,
      closed: false,
      category: null,
      outcomes: ["Yes", "No"],
      outcomePrices: [0.5, 0.5],
    });

    const fired = await runAlertCycle({
      db,
      fetchTrades: async () => [soon, far, unknown],
      conditions: cond({ minUsd: 10000, maxHoursToEnd: 6 }),
      getAges: noAges,
      getMarketMeta: async () => ({
        "0xsoon": metaFor("0xsoon", "2026-07-01T05:00:00Z"), // 5h out
        "0xfar": metaFor("0xfar", "2026-07-05T00:00:00Z"), // 96h out
        // 0xunk missing → dropped
      }),
      send,
      minTimestamp: 0,
      nowSec: NOW,
    });

    expect(fired).toBe(1);
    const msg = send.mock.calls[0][0] as string;
    expect(msg).toContain("距结算 5h");
    expect(msg).toContain("占24h量 50%"); // $50k trade / $100k 24h volume
    // The recorded payload carries the market context for later analysis.
    const row = db.prepare("SELECT payload FROM alerts").get() as {
      payload: string;
    };
    const payload = JSON.parse(row.payload);
    expect(payload.marketCtx.hoursToEnd).toBeCloseTo(5);
  });

  it("(l) missing meta under maxHoursToEnd defers the trade to the next cycle instead of swallowing it", async () => {
    const db = openDb(":memory:");
    const NOW = Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000);
    const t = mk({ transactionHash: "0xdefer", conditionId: "0xdefer" });
    const send = vi.fn().mockResolvedValue(undefined);
    const metaFor = {
      conditionId: "0xdefer",
      volume24hr: 100_000,
      liquidity: 50_000,
      endDate: "2026-07-01T05:00:00Z",
      closed: false,
      category: null,
      outcomes: ["Yes", "No"],
      outcomePrices: [0.5, 0.5],
    };
    const base = {
      db,
      fetchTrades: async () => [t],
      conditions: cond({ minUsd: 10000, maxHoursToEnd: 6 }),
      getAges: noAges,
      send,
      minTimestamp: 0,
      nowSec: NOW,
    };

    // Cycle 1: gamma is down → meta missing → no fire, and NOT marked seen.
    expect(
      await runAlertCycle({ ...base, getMarketMeta: async () => ({}) }),
    ).toBe(0);
    expect(
      db
        .prepare("SELECT 1 FROM seen_trades WHERE dedup_key = ?")
        .get(dedupKey(t)),
    ).toBeUndefined();

    // Cycle 2: gamma recovered → the same trade fires normally.
    expect(
      await runAlertCycle({
        ...base,
        getMarketMeta: async () => ({ "0xdefer": metaFor }),
      }),
    ).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("(h) Telegram-less (send undefined) still records to alerts", async () => {
    const db = openDb(":memory:");
    const t = mk();

    const fired = await runAlertCycle({
      db,
      fetchTrades: async () => [t],
      conditions: cond({ minUsd: 10000 }),
      getAges: noAges,
      // send omitted
      minTimestamp: 0,
    });

    expect(fired).toBe(1);
    expect(countAlerts(db)).toBe(1);
  });

  it("(m) claim lock: a trade claimed by another process mid-cycle is not double-pushed", async () => {
    const db = openDb(":memory:");
    const t = mk({ transactionHash: "0xrace", proxyWallet: "0xRACE" });
    const send = vi.fn().mockResolvedValue(undefined);
    // Simulate the second process winning the race INSIDE our cycle: the age
    // lookup runs after our batched seen check but before our markSeen claim,
    // so marking the trade seen here lands exactly in the contested window.
    const getAges = async (): Promise<Record<string, number | null>> => {
      markSeen(db, dedupKey(t), t.timestamp);
      return { "0xrace": 1 };
    };

    const fired = await runAlertCycle({
      db,
      fetchTrades: async () => [t],
      conditions: cond({ minUsd: 10000, maxAgeDays: 7 }),
      getAges,
      send,
      minTimestamp: 0,
    });

    expect(fired).toBe(0);
    expect(send).not.toHaveBeenCalled();
    // The claiming process records the alert row, not us.
    expect(countAlerts(db)).toBe(0);
  });

  it("(n) send failure rolls the claim back so the trade retries next cycle", async () => {
    const db = openDb(":memory:");
    const t = mk({ transactionHash: "0xretry" });
    const failingSend = vi.fn().mockRejectedValue(new Error("telegram 500"));
    const base = {
      db,
      fetchTrades: async () => [t],
      conditions: cond({ minUsd: 10000 }),
      getAges: noAges,
      minTimestamp: 0,
    };

    await expect(runAlertCycle({ ...base, send: failingSend })).rejects.toThrow(
      "telegram 500",
    );
    // Claim rolled back: not seen, no alert row.
    expect(
      db
        .prepare("SELECT 1 FROM seen_trades WHERE dedup_key = ?")
        .get(dedupKey(t)),
    ).toBeUndefined();
    expect(countAlerts(db)).toBe(0);

    // Next cycle with a healthy send delivers exactly once.
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await runAlertCycle({ ...base, send })).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(countAlerts(db)).toBe(1);
  });
});
