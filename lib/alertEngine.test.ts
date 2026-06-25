import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import { runAlertCycle } from "./alertEngine";
import { DEFAULT_CONDITIONS, type AlertConditions } from "./alertConditions";
import { dedupKey } from "./trades";
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

  it("(e) timestamp gate drops trades older than minTimestamp", async () => {
    const db = openDb(":memory:");
    const fresh = mk({ transactionHash: "0xfresh", timestamp: 2000 });
    const stale = mk({ transactionHash: "0xstale", timestamp: 500 });
    const send = vi.fn().mockResolvedValue(undefined);

    const fired = await runAlertCycle({
      db,
      fetchTrades: async () => [fresh, stale],
      conditions: cond({ minUsd: 10000 }),
      getAges: noAges,
      send,
      minTimestamp: 1000,
    });

    expect(fired).toBe(1);
    // the stale trade was NOT marked seen (it never passed the timestamp gate)
    const staleSeen = db
      .prepare("SELECT 1 FROM seen_trades WHERE dedup_key = ?")
      .get(dedupKey(stale));
    expect(staleSeen).toBeUndefined();
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
});
