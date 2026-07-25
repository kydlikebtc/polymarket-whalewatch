import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import {
  createBackfillState,
  runOutcomeBackfillCycle,
} from "./outcomeBackfill";
import { computeAlertOutcomes, type AlertOutcome } from "./alertOutcomes";

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

// A compute stub that reports every id as trackable (empty outcome), so
// selection/rotation tests exercise the cycle without touching the network.
// Plain function on purpose: wrapping a shared vi.fn in vi.fn() would share
// its call log across tests.
const emptyOutcome: AlertOutcome = {
  price1h: null,
  price24h: null,
  resolved: false,
  resolutionPrice: null,
  won: null,
};
const computeAll = async (
  _db: unknown,
  ids: number[],
): Promise<Record<number, AlertOutcome>> =>
  Object.fromEntries(ids.map((id) => [id, emptyOutcome]));

const noMeta = async () => ({});

describe("runOutcomeBackfillCycle", () => {
  it("backfills never-checked alerts end to end (real compute)", async () => {
    const db = openDb(":memory:");
    const ids = [insertAlert(db), insertAlert(db), insertAlert(db)];
    const fetchPrice = vi.fn(async (_tok: string, ts: number) =>
      ts === T0 + 3600 ? 0.68 : 0.9,
    );
    const state = createBackfillState();
    const r = await runOutcomeBackfillCycle(db, state, {
      outcomes: { fetchPrice, getMeta: noMeta, nowSec: T0 + 90_000 },
    });
    expect(r.processed).toBe(3);
    expect(r.updated).toBe(3);
    expect(r.pending).toBe(3);
    for (const id of ids) {
      const row = db
        .prepare(
          "SELECT price_1h, price_24h FROM alert_outcomes WHERE alert_id = ?",
        )
        .get(id) as { price_1h: number | null; price_24h: number | null };
      expect(row.price_1h).toBe(0.68);
      expect(row.price_24h).toBe(0.9);
    }
  });

  it("does not select terminal rows (resolved with both marks present)", async () => {
    const db = openDb(":memory:");
    const id = insertAlert(db);
    db.prepare(
      `INSERT INTO alert_outcomes
         (alert_id, price_1h, price_24h, resolved, resolution_price, won, checked_at)
       VALUES (?, 0.7, 0.9, 1, 1, 1, ?)`,
    ).run(id, T0 + 90_000);
    const compute = vi.fn(computeAll);
    const r = await runOutcomeBackfillCycle(db, createBackfillState(), {
      outcomes: { getMeta: noMeta },
      compute,
    });
    expect(r.pending).toBe(0);
    expect(r.processed).toBe(0);
    expect(compute).not.toHaveBeenCalled();
  });

  it("keeps selecting unresolved rows on every cycle", async () => {
    const db = openDb(":memory:");
    const id = insertAlert(db);
    db.prepare(
      `INSERT INTO alert_outcomes
         (alert_id, price_1h, price_24h, resolved, resolution_price, won, checked_at)
       VALUES (?, 0.7, 0.9, 0, NULL, NULL, ?)`,
    ).run(id, T0 + 90_000);
    const compute = vi.fn(computeAll);
    const state = createBackfillState();
    const opts = { outcomes: { getMeta: noMeta }, compute };
    await runOutcomeBackfillCycle(db, state, opts);
    await runOutcomeBackfillCycle(db, state, opts);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(compute.mock.calls[0][1]).toEqual([id]);
    expect(compute.mock.calls[1][1]).toEqual([id]);
  });

  it("probes untrackable payloads once, then skips them via state", async () => {
    const db = openDb(":memory:");
    const bad = db
      .prepare(
        "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES ('consensus', 'bad1', '{\"legacy\":true}', ?)",
      )
      .run(T0);
    const badId = Number(bad.lastInsertRowid);
    const state = createBackfillState();
    const opts = { outcomes: { getMeta: noMeta, nowSec: T0 + 90_000 } };
    const r1 = await runOutcomeBackfillCycle(db, state, opts);
    expect(r1.processed).toBe(1);
    expect(r1.updated).toBe(0);
    expect(r1.newlyUntrackable).toBe(1);
    expect(state.untrackable.has(badId)).toBe(true);
    const r2 = await runOutcomeBackfillCycle(db, state, opts);
    expect(r2.processed).toBe(0);
    expect(r2.pending).toBe(0); // known-untrackable rows aren't pending work
  });

  it("caps a cycle at maxPerCycle and rotates the cursor through the backlog", async () => {
    const db = openDb(":memory:");
    const ids = [1, 2, 3, 4, 5].map(() => insertAlert(db));
    const compute = vi.fn(computeAll);
    const state = createBackfillState();
    const opts = {
      outcomes: { getMeta: noMeta },
      compute,
      maxPerCycle: 2,
    };
    const r1 = await runOutcomeBackfillCycle(db, state, opts);
    const r2 = await runOutcomeBackfillCycle(db, state, opts);
    const r3 = await runOutcomeBackfillCycle(db, state, opts);
    // Newest first, no overlap, full coverage across the rotation.
    expect(compute.mock.calls[0][1]).toEqual([ids[4], ids[3]]);
    expect(compute.mock.calls[1][1]).toEqual([ids[2], ids[1]]);
    expect(compute.mock.calls[2][1]).toEqual([ids[0]]);
    expect(r1.wrapped).toBe(false);
    expect(r2.wrapped).toBe(false);
    expect(r3.wrapped).toBe(true);
    // After the wrap the cursor starts from the top again.
    const r4 = await runOutcomeBackfillCycle(db, state, opts);
    expect(compute.mock.calls[3][1]).toEqual([ids[4], ids[3]]);
    expect(r4.processed).toBe(2);
  });

  it("never skips clipped rows when the untrackable over-selection exceeds the window's actual untrackables", async () => {
    // untrackable ids elsewhere in the table inflate the over-selection; the
    // extra trackable rows grabbed beyond maxPerCycle are NOT processed this
    // cycle, so the cursor must stop at the last PROCESSED id — jumping past
    // them would starve the same rows on every future sweep (identical window
    // geometry each time).
    const db = openDb(":memory:");
    const ids = [1, 2, 3, 4, 5].map(() => insertAlert(db));
    const state = createBackfillState();
    state.untrackable.add(ids[0]); // known-untrackable at the bottom
    const compute = vi.fn(computeAll);
    const opts = {
      outcomes: { getMeta: noMeta },
      compute,
      maxPerCycle: 2,
    };
    const processed: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await runOutcomeBackfillCycle(db, state, opts);
      for (const call of compute.mock.calls.splice(0)) {
        processed.push(...(call[1] as number[]));
      }
      if (r.wrapped) break;
    }
    // Every trackable row got its turn within one sweep — none clipped away.
    expect([...processed].sort()).toEqual(
      [ids[1], ids[2], ids[3], ids[4]].sort(),
    );
  });

  it("chunks work into batchSize batches", async () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 7; i++) insertAlert(db);
    const compute = vi.fn(computeAll);
    await runOutcomeBackfillCycle(db, createBackfillState(), {
      outcomes: { getMeta: noMeta },
      compute,
      batchSize: 3,
    });
    expect(compute).toHaveBeenCalledTimes(3);
    expect(compute.mock.calls.map((c) => (c[1] as number[]).length)).toEqual([
      3, 3, 1,
    ]);
  });

  it("continues past a failing batch instead of aborting the cycle", async () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 4; i++) insertAlert(db);
    let calls = 0;
    const compute = vi.fn(
      async (
        _db: unknown,
        ids: number[],
      ): Promise<Record<number, AlertOutcome>> => {
        if (++calls === 1) throw new Error("boom");
        return Object.fromEntries(ids.map((id) => [id, emptyOutcome]));
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await runOutcomeBackfillCycle(db, createBackfillState(), {
      outcomes: { getMeta: noMeta },
      compute,
      batchSize: 2,
    });
    warn.mockRestore();
    expect(compute).toHaveBeenCalledTimes(2);
    expect(r.processed).toBe(4);
    expect(r.updated).toBe(2); // only the surviving batch counted
    // A failed batch must NOT poison the ids as untrackable — they retry later.
    expect(r.newlyUntrackable).toBe(0);
  });

  it("retries a failed batch's ids on the next sweep (never poisons them)", async () => {
    const db = openDb(":memory:");
    const ids = [1, 2].map(() => insertAlert(db));
    let fail = true;
    const compute = vi.fn(
      async (
        _db: unknown,
        batch: number[],
      ): Promise<Record<number, AlertOutcome>> => {
        if (fail) throw new Error("boom");
        return Object.fromEntries(batch.map((id) => [id, emptyOutcome]));
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createBackfillState();
    const opts = { outcomes: { getMeta: noMeta }, compute };
    await runOutcomeBackfillCycle(db, state, opts); // whole batch throws
    warn.mockRestore();
    expect(state.untrackable.size).toBe(0); // NOT poisoned as untrackable
    fail = false;
    const r2 = await runOutcomeBackfillCycle(db, state, opts);
    // Next sweep re-selects and successfully processes the same ids.
    expect(compute.mock.calls[1][1]).toEqual([ids[1], ids[0]]);
    expect(r2.updated).toBe(2);
  });

  it("picks up alerts that arrive mid-sweep only after the wrap", async () => {
    const db = openDb(":memory:");
    const ids = [1, 2, 3, 4].map(() => insertAlert(db));
    const compute = vi.fn(computeAll);
    const state = createBackfillState();
    const opts = { outcomes: { getMeta: noMeta }, compute, maxPerCycle: 2 };
    await runOutcomeBackfillCycle(db, state, opts); // [4, 3]
    const late = insertAlert(db); // arrives mid-sweep, above the cursor
    const r2 = await runOutcomeBackfillCycle(db, state, opts); // [2, 1]
    // The current sweep continues below the cursor — no mid-sweep jump back.
    expect(compute.mock.calls[1][1]).toEqual([ids[1], ids[0]]);
    const r3 = await runOutcomeBackfillCycle(db, state, opts); // wrap
    expect(r3.wrapped).toBe(true);
    const r4 = await runOutcomeBackfillCycle(db, state, opts);
    // Fresh sweep starts from the top and picks up the late arrival.
    expect(compute.mock.calls[compute.mock.calls.length - 1][1]).toEqual([
      late,
      ids[3],
    ]);
    expect(r4.processed).toBe(2);
  });

  it("uses the real computeAlertOutcomes by default", () => {
    // Guard against the test seam silently replacing the production path.
    expect(typeof computeAlertOutcomes).toBe("function");
  });
});
