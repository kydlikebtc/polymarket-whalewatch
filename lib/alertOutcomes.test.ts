import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import { computeAlertOutcomes } from "./alertOutcomes";
import type { MarketMeta } from "./gamma";

const T0 = 1_700_000_000;

// Unique per insert — alerts carries a unique (type, dedup_key) index.
let keySeq = 0;

function insertAlert(
  db: ReturnType<typeof openDb>,
  over: Record<string, unknown> = {},
): number {
  const payload = {
    asset: "tok1",
    conditionId: "0xc1",
    price: 0.6,
    timestamp: T0,
    side: "BUY",
    outcomeIndex: 0,
    title: "M",
    ...over,
  };
  const r = db
    .prepare(
      "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES ('large', ?, ?, ?)",
    )
    .run(`k${keySeq++}`, JSON.stringify(payload), T0);
  return Number(r.lastInsertRowid);
}

const meta = (over: Partial<MarketMeta> = {}): MarketMeta => ({
  conditionId: "0xc1",
  volume24hr: 100_000,
  liquidity: 50_000,
  endDate: null,
  closed: false,
  category: null,
  outcomes: ["Yes", "No"],
  outcomePrices: [1, 0],
  ...over,
});

describe("computeAlertOutcomes", () => {
  it("fetches 1h/24h follow-through prices once both marks have passed", async () => {
    const db = openDb(":memory:");
    const id = insertAlert(db);
    const fetchPrice = vi.fn(async (_tok: string, ts: number) =>
      ts === T0 + 3600 ? 0.68 : 0.9,
    );
    const out = await computeAlertOutcomes(db, [id], {
      fetchPrice,
      getMeta: async () => ({}),
      nowSec: T0 + 90_000, // past both marks
    });
    expect(out[id]).toEqual({
      price1h: 0.68,
      price24h: 0.9,
      resolved: false,
      resolutionPrice: null,
      won: null,
    });
    // Immutable → a second call serves from cache, no refetch.
    await computeAlertOutcomes(db, [id], {
      fetchPrice,
      getMeta: async () => ({}),
      nowSec: T0 + 95_000,
    });
    expect(fetchPrice).toHaveBeenCalledTimes(2); // 1h + 24h, once each
  });

  it("does not fetch a mark that has not elapsed yet", async () => {
    const db = openDb(":memory:");
    const id = insertAlert(db);
    const fetchPrice = vi.fn(async () => 0.7);
    const out = await computeAlertOutcomes(db, [id], {
      fetchPrice,
      getMeta: async () => ({}),
      nowSec: T0 + 4000, // 1h passed (with margin), 24h not
    });
    expect(out[id].price1h).toBe(0.7);
    expect(out[id].price24h).toBeNull();
    expect(fetchPrice).toHaveBeenCalledTimes(1);
  });

  it("marks BUY as won when the outcome settles at 1 (and SELL as lost)", async () => {
    const db = openDb(":memory:");
    const buyId = insertAlert(db, { side: "BUY" });
    const sellId = insertAlert(db, { side: "SELL" });
    const getMeta = vi.fn(async () => ({ "0xc1": meta({ closed: true }) }));
    const out = await computeAlertOutcomes(db, [buyId, sellId], {
      fetchPrice: async () => null,
      getMeta,
      nowSec: T0 + 100,
    });
    expect(out[buyId].resolved).toBe(true);
    expect(out[buyId].won).toBe(true);
    expect(out[buyId].resolutionPrice).toBe(1);
    expect(out[sellId].won).toBe(false);
    // Once resolved, later calls skip the meta lookup entirely.
    await computeAlertOutcomes(db, [buyId, sellId], {
      fetchPrice: async () => null,
      getMeta,
      nowSec: T0 + 200,
    });
    expect(getMeta).toHaveBeenCalledTimes(1);
  });

  it("backs off null prices instead of retrying every request", async () => {
    const db = openDb(":memory:");
    const id = insertAlert(db);
    const fetchPrice = vi.fn(async () => null); // dead market
    const deps = { fetchPrice, getMeta: async () => ({}), nowSec: T0 + 90_000 };
    await computeAlertOutcomes(db, [id], deps);
    expect(fetchPrice).toHaveBeenCalledTimes(2);
    // Shortly after: cached null, no retry.
    await computeAlertOutcomes(db, [id], { ...deps, nowSec: T0 + 91_000 });
    expect(fetchPrice).toHaveBeenCalledTimes(2);
    // Past the retry backoff: tries again.
    await computeAlertOutcomes(db, [id], {
      ...deps,
      nowSec: T0 + 90_000 + 7 * 3600,
    });
    expect(fetchPrice).toHaveBeenCalledTimes(4);
  });

  it("fetches the 1h price at the mark even when the alert was viewed earlier (regression)", async () => {
    const db = openDb(":memory:");
    const id = insertAlert(db);
    const fetchPrice = vi.fn(async () => 0.7);
    // Dashboard views the fresh alert 10s after it fires — writes a
    // placeholder row whose checked_at predates the 1h mark.
    const early = await computeAlertOutcomes(db, [id], {
      fetchPrice,
      getMeta: async () => ({}),
      nowSec: T0 + 10,
    });
    expect(early[id].price1h).toBeNull();
    expect(fetchPrice).not.toHaveBeenCalled();
    // Just past the mark: the never-attempted 1h fetch must NOT be gated by
    // the null backoff (it previously waited a full NULL_RETRY_SEC).
    const atMark = await computeAlertOutcomes(db, [id], {
      fetchPrice,
      getMeta: async () => ({}),
      nowSec: T0 + 3600 + 400,
    });
    expect(atMark[id].price1h).toBe(0.7);
    expect(fetchPrice).toHaveBeenCalledTimes(1);
  });

  it("scores fractional settlements by P&L direction vs the fill price", async () => {
    const db = openDb(":memory:");
    // BUY@0.9 settling 0.6: a 0.3/share loss (the old 0.5-divider said ✅).
    const highBuy = insertAlert(db, { side: "BUY", price: 0.9 });
    // BUY@0.3 settling 0.45: a real profit (the old logic said ❌).
    const lowBuy = insertAlert(db, {
      side: "BUY",
      price: 0.3,
      outcomeIndex: 1,
    });
    const out = await computeAlertOutcomes(db, [highBuy, lowBuy], {
      fetchPrice: async () => null,
      getMeta: async () => ({
        "0xc1": meta({ closed: true, outcomePrices: [0.6, 0.45] }),
      }),
      nowSec: T0 + 100,
    });
    expect(out[highBuy].resolved).toBe(true);
    expect(out[highBuy].won).toBe(false);
    expect(out[lowBuy].won).toBe(true);
  });

  it("treats a settle within ε of the fill price as a push (won=null)", async () => {
    const db = openDb(":memory:");
    const id = insertAlert(db, { side: "BUY", price: 0.598 });
    const out = await computeAlertOutcomes(db, [id], {
      fetchPrice: async () => null,
      getMeta: async () => ({
        "0xc1": meta({ closed: true, outcomePrices: [0.6, 0.4] }),
      }),
      nowSec: T0 + 100,
    });
    expect(out[id].resolved).toBe(true);
    expect(out[id].resolutionPrice).toBe(0.6);
    expect(out[id].won).toBeNull();
  });

  it("treats a 50/50 resolution as a push: resolved but won=null for both sides", async () => {
    const db = openDb(":memory:");
    const buyId = insertAlert(db, { side: "BUY" });
    const sellId = insertAlert(db, { side: "SELL" });
    const out = await computeAlertOutcomes(db, [buyId, sellId], {
      fetchPrice: async () => null,
      getMeta: async () => ({
        "0xc1": meta({ closed: true, outcomePrices: [0.5, 0.5] }),
      }),
      nowSec: T0 + 100,
    });
    for (const id of [buyId, sellId]) {
      expect(out[id].resolved).toBe(true);
      expect(out[id].resolutionPrice).toBe(0.5);
      expect(out[id].won).toBeNull();
    }
  });

  it("tracks consensus alerts as a synthetic BUY at avgBuyPrice, timed at lastTs", async () => {
    const db = openDb(":memory:");
    const payload = {
      conditionId: "0xc1",
      outcome: "Yes",
      title: "M",
      eventSlug: "e",
      asset: "tok1",
      outcomeIndex: 0,
      avgBuyPrice: 0.42,
      lastTs: T0,
      totalNetUsd: 12000,
      walletCount: 2,
    };
    const r = db
      .prepare(
        "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES ('consensus', 'ck', ?, ?)",
      )
      .run(JSON.stringify(payload), T0);
    const id = Number(r.lastInsertRowid);
    const fetchPrice = vi.fn(async (_tok: string, ts: number) =>
      ts === T0 + 3600 ? 0.5 : 0.6,
    );
    const out = await computeAlertOutcomes(db, [id], {
      fetchPrice,
      getMeta: async () => ({
        "0xc1": meta({ closed: true, outcomePrices: [1, 0] }),
      }),
      nowSec: T0 + 90_000,
    });
    expect(out[id].price1h).toBe(0.5);
    expect(out[id].price24h).toBe(0.6);
    expect(out[id].resolved).toBe(true);
    expect(out[id].won).toBe(true); // BUY@0.42 settled at 1
    expect(fetchPrice).toHaveBeenCalledWith("tok1", T0 + 3600);
  });

  it("skips pre-upgrade consensus payloads missing token fields (graceful downgrade)", async () => {
    const db = openDb(":memory:");
    const r = db
      .prepare(
        "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES ('consensus', 'k', ?, ?)",
      )
      .run(JSON.stringify({ title: "M", totalNetUsd: 5000 }), T0);
    const id = Number(r.lastInsertRowid);
    const out = await computeAlertOutcomes(db, [id], {
      fetchPrice: async () => 0.5,
      getMeta: async () => ({}),
      nowSec: T0 + 90_000,
    });
    expect(out[id]).toBeUndefined();
  });
});
