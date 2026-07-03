import { it, expect } from "vitest";
import { openDb } from "./db";
import { ALERT_HITS_WINDOW_DAYS, queryAlertHitRows } from "./alertHits";

const ADDR = "0x00000000000000000000000000000000000000ab";
const NOW = 1_700_000_000;

const insert = (db: ReturnType<typeof openDb>) =>
  db.prepare(
    "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES (?, ?, ?, ?)",
  );

it("returns recent payload matches newest-first and excludes rows past the window", () => {
  const db = openDb(":memory:");
  const ins = insert(db);
  const payload = JSON.stringify({ proxyWallet: ADDR });
  ins.run("large", "k1", payload, NOW - 100);
  ins.run("smart", "k2", payload, NOW - 50);
  // Same wallet but older than the window — the created_at lower bound (the
  // thing that keeps the LIKE probe off a full-table scan) must exclude it.
  ins.run("large", "k3", payload, NOW - (ALERT_HITS_WINDOW_DAYS + 1) * 86_400);
  // In-window row for a DIFFERENT wallet — must not match the LIKE probe.
  ins.run("large", "k4", JSON.stringify({ proxyWallet: "0xother" }), NOW - 10);
  const rows = queryAlertHitRows(db, ADDR, { nowSec: NOW });
  expect(rows.map((r) => ({ type: r.type, created_at: r.created_at }))).toEqual(
    [
      { type: "smart", created_at: NOW - 50 },
      { type: "large", created_at: NOW - 100 },
    ],
  );
});

it("applies the row limit newest-first", () => {
  const db = openDb(":memory:");
  const ins = insert(db);
  for (let i = 0; i < 5; i++) {
    ins.run("large", `k${i}`, JSON.stringify({ proxyWallet: ADDR }), NOW - i);
  }
  const rows = queryAlertHitRows(db, ADDR, { nowSec: NOW, limit: 3 });
  expect(rows.map((r) => r.created_at)).toEqual([NOW, NOW - 1, NOW - 2]);
});
