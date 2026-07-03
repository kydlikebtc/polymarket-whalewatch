import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
describe("openDb", () => {
  it("creates the seen_trades table", () => {
    const db = openDb(":memory:");
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='seen_trades'",
      )
      .get();
    expect(row).toBeTruthy();
  });

  it("purges wallet_age exactly once via the version marker (poisoned-cache repair)", () => {
    const dir = mkdtempSync(join(tmpdir(), "whaledb-"));
    const path = join(dir, "t.sqlite");
    try {
      // Simulate a pre-v2 database: a cached row but no version marker.
      const db1 = openDb(path);
      db1
        .prepare(
          "INSERT INTO wallet_age (wallet, first_ts, fetched_at) VALUES ('0xa', 1, 1)",
        )
        .run();
      db1.prepare("DELETE FROM config WHERE key = 'wallet_age_v'").run();
      db1.close();

      // Reopen: marker missing → purge runs.
      const db2 = openDb(path);
      const afterPurge = db2
        .prepare("SELECT COUNT(*) AS c FROM wallet_age")
        .get() as { c: number };
      expect(afterPurge.c).toBe(0);
      db2
        .prepare(
          "INSERT INTO wallet_age (wallet, first_ts, fetched_at) VALUES ('0xb', 2, 2)",
        )
        .run();
      db2.close();

      // Reopen again: marker present → cache preserved.
      const db3 = openDb(path);
      const preserved = db3
        .prepare("SELECT COUNT(*) AS c FROM wallet_age")
        .get() as { c: number };
      expect(preserved.c).toBe(1);
      db3.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rescores cached settled outcomes vs the fill price exactly once (outcome_won_v marker)", () => {
    const dir = mkdtempSync(join(tmpdir(), "whaledb-"));
    const path = join(dir, "t.sqlite");
    try {
      // Simulate a pre-v2 database: cached verdicts but no version marker.
      const db1 = openDb(path);
      const insAlert = db1.prepare(
        "INSERT INTO alerts (id, type, dedup_key, payload, created_at) VALUES (?, ?, ?, ?, 1)",
      );
      const insOut = db1.prepare(
        "INSERT INTO alert_outcomes (alert_id, resolved, resolution_price, won, checked_at) VALUES (?, 1, ?, ?, 1)",
      );
      // BUY@0.9 settling 0.6 — a 0.3/share loss the old 0.5-divider cached as won.
      insAlert.run(
        1,
        "large",
        "k1",
        JSON.stringify({ side: "BUY", price: 0.9 }),
      );
      insOut.run(1, 0.6, 1);
      // Standard 0/1 settlement — already correct, must stay untouched.
      insAlert.run(
        2,
        "large",
        "k2",
        JSON.stringify({ side: "BUY", price: 0.6 }),
      );
      insOut.run(2, 1, 1);
      // Payload the rescorer can't read (pre-upgrade consensus) — left as-is.
      insAlert.run(3, "consensus", "k3", JSON.stringify({ title: "M" }));
      insOut.run(3, 1, 0);
      db1.prepare("DELETE FROM config WHERE key = 'outcome_won_v'").run();
      db1.close();

      // Reopen: marker missing → backfill rescores from resolution_price + fill.
      const db2 = openDb(path);
      const won = (db: ReturnType<typeof openDb>, id: number) =>
        (
          db
            .prepare("SELECT won FROM alert_outcomes WHERE alert_id = ?")
            .get(id) as { won: number | null }
        ).won;
      expect(won(db2, 1)).toBe(0); // corrected: real loss
      expect(won(db2, 2)).toBe(1); // untouched: was already right
      expect(won(db2, 3)).toBe(0); // unreadable payload skipped
      // Marker present → flip a verdict by hand and reopen: must NOT re-run.
      db2.prepare("UPDATE alert_outcomes SET won = 1 WHERE alert_id = 1").run();
      db2.close();
      const db3 = openDb(path);
      expect(won(db3, 1)).toBe(1);
      db3.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
