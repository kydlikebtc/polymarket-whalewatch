import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import { computeAlertOutcomes } from "./alertOutcomes";
import type { MarketMeta } from "./gamma";

const T0 = 1_700_000_000;

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
      "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES ('large', 'k', ?, ?)",
    )
    .run(JSON.stringify(payload), T0);
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

  it("skips untrackable payloads (consensus groups)", async () => {
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
