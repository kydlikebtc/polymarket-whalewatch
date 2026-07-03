import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import {
  MAX_AGE_LOOKUP_CYCLES,
  SEND_MIN_GAP_MS,
  runAlertCycle,
} from "./alertEngine";
import { DEFAULT_CONDITIONS, type AlertConditions } from "./alertConditions";
import { dedupKey } from "./trades";
import { markSeen } from "./seen";
import { TelegramPermanentError } from "./telegram";
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

  it("(d) age filter drops too-old and verified-empty (null) wallets deterministically", async () => {
    const db = openDb(":memory:");
    const young = mk({ transactionHash: "0xy", proxyWallet: "0xYOUNG" });
    const old = mk({ transactionHash: "0xo", proxyWallet: "0xOLD" });
    // null = the /activity probe VERIFIED there is no history — a settled
    // verdict, dropped for good (unlike a FAILED lookup, see test (s)).
    const empty = mk({ transactionHash: "0xu", proxyWallet: "0xEMPTY" });
    const send = vi.fn().mockResolvedValue(undefined);

    const getAges = vi.fn(
      async (_wallets: string[]): Promise<Record<string, number | null>> => ({
        "0xyoung": 3,
        "0xold": 99,
        "0xempty": null,
      }),
    );

    const fired = await runAlertCycle({
      db,
      fetchTrades: async () => [young, old, empty],
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
    expect(new Set(asked)).toEqual(new Set(["0xyoung", "0xold", "0xempty"]));
    // Deterministic drops ARE swept as seen — they never re-evaluate.
    const seen = db.prepare("SELECT COUNT(*) AS c FROM seen_trades").get() as {
      c: number;
    };
    expect(seen.c).toBe(3);
  });

  it("(s) a FAILED age lookup (wallet absent) defers the trade to the next cycle instead of swallowing it", async () => {
    const db = openDb(":memory:");
    const t = mk({ transactionHash: "0xagedefer", proxyWallet: "0xNEW" });
    const send = vi.fn().mockResolvedValue(undefined);
    const ageRetries = new Map<string, number>();
    const base = {
      db,
      fetchTrades: async () => [t],
      conditions: cond({ minUsd: 10000, maxAgeDays: 7 }),
      send,
      minTimestamp: 0,
      ageRetries,
    };

    // Cycle 1: /activity down → wallet ABSENT from ages → no fire, NOT seen.
    expect(await runAlertCycle({ ...base, getAges: async () => ({}) })).toBe(0);
    expect(
      db
        .prepare("SELECT 1 FROM seen_trades WHERE dedup_key = ?")
        .get(dedupKey(t)),
    ).toBeUndefined();
    expect(ageRetries.get(dedupKey(t))).toBe(1);

    // Cycle 2: lookup recovered → the same trade fires normally, ledger clear.
    expect(
      await runAlertCycle({ ...base, getAges: async () => ({ "0xnew": 3 }) }),
    ).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ageRetries.size).toBe(0);
  });

  it("(t) gives up (marks seen + warns) after MAX_AGE_LOOKUP_CYCLES consecutive failed age lookups", async () => {
    const db = openDb(":memory:");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = mk({ transactionHash: "0xageforever", proxyWallet: "0xNEW" });
    const send = vi.fn().mockResolvedValue(undefined);
    const ageRetries = new Map<string, number>();
    const base = {
      db,
      fetchTrades: async () => [t],
      conditions: cond({ minUsd: 10000, maxAgeDays: 7 }),
      getAges: async () => ({}), // permanently failing lookup
      send,
      minTimestamp: 0,
      ageRetries,
    };

    // Cycles 1..N-1: deferred (never marked seen, never fired).
    for (let i = 1; i < MAX_AGE_LOOKUP_CYCLES; i++) {
      expect(await runAlertCycle(base)).toBe(0);
      expect(
        db
          .prepare("SELECT 1 FROM seen_trades WHERE dedup_key = ?")
          .get(dedupKey(t)),
      ).toBeUndefined();
      expect(ageRetries.get(dedupKey(t))).toBe(i);
    }
    // Cycle N: give up — swept as seen with a warn, ledger entry removed.
    expect(await runAlertCycle(base)).toBe(0);
    expect(
      db
        .prepare("SELECT 1 FROM seen_trades WHERE dedup_key = ?")
        .get(dedupKey(t)),
    ).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("giving up"));
    expect(ageRetries.size).toBe(0);
    // Even a later lookup recovery cannot resurrect it (already seen).
    expect(
      await runAlertCycle({ ...base, getAges: async () => ({ "0xnew": 3 }) }),
    ).toBe(0);
    expect(send).not.toHaveBeenCalled();
    warnSpy.mockRestore();
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
      sendMinGapMs: 0, // multi-push test: skip the real 3.2s throttle gap
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

  it("(j2) smartOnly logs its hit ratio whenever candidates were evaluated", async () => {
    const db = openDb(":memory:");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const smartTrade = mk({ transactionHash: "0xs", proxyWallet: "0xSMART" });
    const plainTrade = mk({ transactionHash: "0xp", proxyWallet: "0xPLAIN" });
    const send = vi.fn().mockResolvedValue(undefined);

    await runAlertCycle({
      db,
      fetchTrades: async () => [smartTrade, plainTrade],
      conditions: cond({ minUsd: 10000, smartOnly: true }),
      getAges: noAges,
      getSmart: () => ({ "0xsmart": { score: 82 } }),
      send,
      minTimestamp: 0,
    });
    // 1 of the 2 candidates hit the whitelist — SILENCE must be tellable
    // apart from "filter eats everything" straight from the engine logs.
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("smartOnly: 1/2 candidate trade(s)"),
    );

    // A cycle with zero candidates (nothing cleared the cheap filters) stays
    // quiet — no per-cycle log spam at the 4s cadence.
    logSpy.mockClear();
    await runAlertCycle({
      db,
      fetchTrades: async () => [
        mk({ transactionHash: "0xtiny", size: 10, price: 0.5 }), // $5
      ],
      conditions: cond({ minUsd: 10000, smartOnly: true }),
      getAges: noAges,
      getSmart: () => ({}),
      send,
      minTimestamp: 0,
    });
    const smartLogs = logSpy.mock.calls.filter((c) =>
      String(c[0]).includes("smartOnly:"),
    );
    expect(smartLogs).toHaveLength(0);
    logSpy.mockRestore();
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

  it("(o) cooldown: a same-cycle (wallet,market) burst pushes ONE message with the ×N summary, all recorded", async () => {
    const db = openDb(":memory:");
    const t1 = mk({ transactionHash: "0xb1", timestamp: 1000 });
    const t2 = mk({ transactionHash: "0xb2", timestamp: 1001 });
    const send = vi.fn().mockResolvedValue(undefined);

    const fired = await runAlertCycle({
      db,
      fetchTrades: async () => [t1, t2],
      conditions: cond({ minUsd: 10000, cooldownMinutes: 30 }),
      getAges: noAges,
      send,
      minTimestamp: 0,
      nowSec: 1001,
    });

    // Both matches are real alerts (recorded), only the first one pushes.
    expect(fired).toBe(2);
    expect(countAlerts(db)).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0] as string).toContain("共 2 笔");
  });

  it("(p) cooldown: a later cycle inside the window records without pushing; past the window it pushes again", async () => {
    const db = openDb(":memory:");
    const send = vi.fn().mockResolvedValue(undefined);
    const base = {
      db,
      conditions: cond({ minUsd: 10000, cooldownMinutes: 30 }),
      getAges: noAges,
      send,
      minTimestamp: 0,
    };

    // Cycle 1: pushes (no burst → no summary suffix).
    await runAlertCycle({
      ...base,
      fetchTrades: async () => [
        mk({ transactionHash: "0xc1", timestamp: 1000 }),
      ],
      nowSec: 1000,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0] as string).not.toContain("共 1 笔");

    // Cycle 2, 10 min later: same wallet+market → record-only.
    const fired2 = await runAlertCycle({
      ...base,
      fetchTrades: async () => [
        mk({ transactionHash: "0xc2", timestamp: 1600 }),
      ],
      nowSec: 1600,
    });
    expect(fired2).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(countAlerts(db)).toBe(2);

    // Cycle 3, past the 30-min window (measured from the LAST recorded alert):
    // pushes again.
    await runAlertCycle({
      ...base,
      fetchTrades: async () => [
        mk({ transactionHash: "0xc3", timestamp: 1600 + 1801 }),
      ],
      nowSec: 1600 + 1801,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(countAlerts(db)).toBe(3);
  });

  it("(q) cooldown scopes by (wallet,market): other wallets / markets still push", async () => {
    const db = openDb(":memory:");
    const send = vi.fn().mockResolvedValue(undefined);
    const t1 = mk({ transactionHash: "0xq1", timestamp: 1000 });
    const otherWallet = mk({
      transactionHash: "0xq2",
      proxyWallet: "0xOTHER",
      timestamp: 1001,
    });
    const otherMarket = mk({
      transactionHash: "0xq3",
      conditionId: "0xc2",
      timestamp: 1002,
    });

    await runAlertCycle({
      db,
      fetchTrades: async () => [t1, otherWallet, otherMarket],
      conditions: cond({ minUsd: 10000, cooldownMinutes: 30 }),
      getAges: noAges,
      send,
      minTimestamp: 0,
      nowSec: 1002,
      sendMinGapMs: 0, // multi-push test: skip the real 3.2s throttle gap
    });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("(r) cooldownMinutes=0 disables suppression entirely", async () => {
    const db = openDb(":memory:");
    const send = vi.fn().mockResolvedValue(undefined);
    const t1 = mk({ transactionHash: "0xz1", timestamp: 1000 });
    const t2 = mk({ transactionHash: "0xz2", timestamp: 1001 });

    await runAlertCycle({
      db,
      fetchTrades: async () => [t1, t2],
      conditions: cond({ minUsd: 10000, cooldownMinutes: 0 }),
      getAges: noAges,
      send,
      minTimestamp: 0,
      nowSec: 1001,
      sendMinGapMs: 0, // multi-push test: skip the real 3.2s throttle gap
    });
    expect(send).toHaveBeenCalledTimes(2);
    const sent = send.mock.calls.map((c) => c[0] as string);
    expect(sent.some((m) => m.includes("共"))).toBe(false);
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

  it("(u) a PERMANENT send failure keeps the claim (marked seen + recorded) and does not throw", async () => {
    const db = openDb(":memory:");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const poison = mk({ transactionHash: "0xpoison", timestamp: 1000 });
    const healthy = mk({
      transactionHash: "0xok",
      proxyWallet: "0xOTHER",
      conditionId: "0xc2",
      timestamp: 1001,
    });
    // Poison message: first send perma-fails (post-downgrade 4xx), the next
    // one succeeds — the pipeline must keep moving past the poison head.
    const send = vi
      .fn()
      .mockRejectedValueOnce(new TelegramPermanentError("tg 400"))
      .mockResolvedValue(undefined);
    const base = {
      db,
      fetchTrades: async () => [poison, healthy],
      conditions: cond({ minUsd: 10000 }),
      getAges: noAges,
      send,
      minTimestamp: 0,
      sendMinGapMs: 0,
    };

    // No throw; BOTH matches recorded; the healthy one still pushed.
    expect(await runAlertCycle(base)).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(countAlerts(db)).toBe(2);
    // The poison trade stays claimed — it can never re-fire.
    expect(
      db
        .prepare("SELECT 1 FROM seen_trades WHERE dedup_key = ?")
        .get(dedupKey(poison)),
    ).toBeDefined();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("permanent send failure"),
      expect.anything(),
    );
    // Next cycle: nothing re-fires (unlike the transient rollback path).
    expect(await runAlertCycle(base)).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });

  it("(v) throttle: consecutive pushes in one cycle are spaced by ~SEND_MIN_GAP_MS", async () => {
    const db = openDb(":memory:");
    const t1 = mk({ transactionHash: "0xv1", timestamp: 1000 });
    const t2 = mk({
      transactionHash: "0xv2",
      proxyWallet: "0xOTHER",
      timestamp: 1001,
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn(async (_ms: number) => {});

    await runAlertCycle({
      db,
      fetchTrades: async () => [t1, t2],
      conditions: cond({ minUsd: 10000 }),
      getAges: noAges,
      send,
      minTimestamp: 0,
      sleep,
    });

    expect(send).toHaveBeenCalledTimes(2);
    // First push goes immediately; the second waits out the remaining gap.
    expect(sleep).toHaveBeenCalledTimes(1);
    const waited = sleep.mock.calls[0][0];
    expect(waited).toBeGreaterThan(SEND_MIN_GAP_MS - 200);
    expect(waited).toBeLessThanOrEqual(SEND_MIN_GAP_MS);
  });

  it("(w) push cap: over-cap matches fold into ONE summary message, all recorded", async () => {
    const db = openDb(":memory:");
    // 4 pushable matches (distinct wallet+market so cooldown never bites),
    // cap of 2 → 2 individual pushes + 1 summary.
    const trades = [10_500, 11_000, 52_000, 12_000].map((notional, i) =>
      mk({
        transactionHash: `0xw${i}`,
        proxyWallet: `0xW${i}`,
        conditionId: `0xc${i}`,
        title: `Market ${i}`,
        size: notional * 2, // price 0.5 → notionalUsd = notional
        timestamp: 1000 + i,
      }),
    );
    const send = vi.fn().mockResolvedValue(undefined);

    const fired = await runAlertCycle({
      db,
      fetchTrades: async () => trades,
      conditions: cond({ minUsd: 10000 }),
      getAges: noAges,
      send,
      minTimestamp: 0,
      sendMinGapMs: 0,
      maxPushesPerCycle: 2,
    });

    // Every match is a real alert (recorded + seen), only pushes are capped.
    expect(fired).toBe(4);
    expect(countAlerts(db)).toBe(4);
    expect(send).toHaveBeenCalledTimes(3);
    const summary = send.mock.calls[2][0] as string;
    expect(summary).toContain("本轮另有 2 笔");
    expect(summary).toContain("≥$10,000");
    // Max of the two folded trades ($52k, "Market 2") — not of the pushed ones.
    expect(summary).toContain("$52,000");
    expect(summary).toContain("Market 2");
  });

  it("(x) a failed summary send is best-effort: logged, nothing rolled back, no throw", async () => {
    const db = openDb(":memory:");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const trades = [0, 1, 2].map((i) =>
      mk({
        transactionHash: `0xx${i}`,
        proxyWallet: `0xX${i}`,
        conditionId: `0xc${i}`,
        timestamp: 1000 + i,
      }),
    );
    // Individual push succeeds, the summary (2nd call) blows up transiently.
    const send = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("telegram 500"));

    const fired = await runAlertCycle({
      db,
      fetchTrades: async () => trades,
      conditions: cond({ minUsd: 10000 }),
      getAges: noAges,
      send,
      minTimestamp: 0,
      sendMinGapMs: 0,
      maxPushesPerCycle: 1,
    });

    expect(fired).toBe(3);
    expect(countAlerts(db)).toBe(3); // details all recorded — nothing lost
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("overflow summary send failed"),
      expect.anything(),
    );
    // All three stay seen: the failed summary must not resurrect anything.
    for (const t of trades) {
      expect(
        db
          .prepare("SELECT 1 FROM seen_trades WHERE dedup_key = ?")
          .get(dedupKey(t)),
      ).toBeDefined();
    }
    errSpy.mockRestore();
  });
});
