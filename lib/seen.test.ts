import { it, expect } from "vitest";
import { openDb } from "./db";
import { hasSeen, markSeen, recordAlert } from "./seen";
it("marks and detects seen keys", () => {
  const db = openDb(":memory:");
  expect(hasSeen(db, "k1")).toBe(false);
  markSeen(db, "k1", 1700000000);
  expect(hasSeen(db, "k1")).toBe(true);
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
