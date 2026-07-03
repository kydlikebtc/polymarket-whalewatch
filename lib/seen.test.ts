import { it, expect } from "vitest";
import { openDb } from "./db";
import {
  hasSeen,
  markSeen,
  markSeenBatch,
  recordAlert,
  seenKeySet,
  unmarkSeen,
} from "./seen";
it("marks and detects seen keys", () => {
  const db = openDb(":memory:");
  expect(hasSeen(db, "k1")).toBe(false);
  markSeen(db, "k1", 1700000000);
  expect(hasSeen(db, "k1")).toBe(true);
});
it("markSeen doubles as a claim lock: changes=1 on first insert, 0 on repeat", () => {
  const db = openDb(":memory:");
  expect(markSeen(db, "k1", 1700000000).changes).toBe(1);
  expect(markSeen(db, "k1", 1700000000).changes).toBe(0);
});
it("unmarkSeen rolls a claim back so the key can be re-claimed", () => {
  const db = openDb(":memory:");
  markSeen(db, "k1", 1700000000);
  unmarkSeen(db, "k1");
  expect(hasSeen(db, "k1")).toBe(false);
  expect(markSeen(db, "k1", 1700000000).changes).toBe(1);
});
it("seenKeySet batch-checks membership across the IN(...) chunk boundary", () => {
  const db = openDb(":memory:");
  // 1500 keys spans two 900-key chunks; mark one key in each chunk.
  const keys = Array.from({ length: 1500 }, (_, i) => `k${i}`);
  markSeen(db, "k5", 1700000000);
  markSeen(db, "k1200", 1700000000);
  const seen = seenKeySet(db, keys);
  expect(seen).toEqual(new Set(["k5", "k1200"]));
  expect(seenKeySet(db, [])).toEqual(new Set());
});
it("markSeenBatch inserts all rows transactionally and is idempotent", () => {
  const db = openDb(":memory:");
  const rows = [
    { key: "a", ts: 100 },
    { key: "b", ts: 200 },
  ];
  markSeenBatch(db, rows);
  markSeenBatch(db, rows); // OR IGNORE: re-marking is a no-op
  markSeenBatch(db, []); // empty sweep is a no-op
  const got = db
    .prepare("SELECT dedup_key, ts FROM seen_trades ORDER BY dedup_key")
    .all();
  expect(got).toEqual([
    { dedup_key: "a", ts: 100 },
    { dedup_key: "b", ts: 200 },
  ]);
});
it("records an alert row", () => {
  const db = openDb(":memory:");
  recordAlert(db, "large", "k1", '{"foo":"bar"}', 1700000000);
  const row = db
    .prepare("SELECT type, dedup_key, payload FROM alerts WHERE dedup_key = ?")
    .get("k1") as { type: string; dedup_key: string; payload: string };
  expect(row.type).toBe("large");
  expect(row.dedup_key).toBe("k1");
  expect(row.payload).toBe('{"foo":"bar"}');
});
