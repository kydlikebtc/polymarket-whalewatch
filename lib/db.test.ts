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
});
