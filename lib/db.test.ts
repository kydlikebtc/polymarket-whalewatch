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

  it("purges wallet_stats + the seed marker on the v2→v3 migration, exactly once", () => {
    const dir = mkdtempSync(join(tmpdir(), "whaledb-"));
    const path = join(dir, "t.sqlite");
    try {
      // Simulate a pre-v3 database: a cached (survivorship/truncation-biased)
      // wallet_stats row, a claimed seed-day marker, and the v2 version marker.
      const db1 = openDb(path);
      db1
        .prepare(
          "INSERT INTO wallet_stats (wallet, win_rate, realized_pnl, roi, settled_count, truncated, fetched_at) VALUES ('0xa', 1, 22960000, 2, 400, 1, 1)",
        )
        .run();
      // A manually-whitelisted smart_wallets row carrying the old biased
      // closed-sum in realized_pnl (now mislabeled as netPnl).
      db1
        .prepare(
          "INSERT INTO smart_wallets (address, score, realized_pnl, win_rate, is_whitelist, updated_at) VALUES ('0xw', 80, 22960000, 1, 1, 1)",
        )
        .run();
      db1
        .prepare(
          "INSERT OR REPLACE INTO config (key, value) VALUES ('smart_seed_last_day', '2026-07-01')",
        )
        .run();
      db1
        .prepare(
          "INSERT OR REPLACE INTO config (key, value) VALUES ('wallet_stats_v', '2')",
        )
        .run();
      db1.close();

      // Reopen: v2 marker → purge the biased cache and clear the seed marker so
      // the whitelist re-scores on the next engine cycle.
      const db2 = openDb(path);
      expect(
        (
          db2.prepare("SELECT COUNT(*) AS c FROM wallet_stats").get() as {
            c: number;
          }
        ).c,
      ).toBe(0);
      // smart_wallets: stale net value nulled, but the manual whitelist flag kept.
      const w = db2
        .prepare(
          "SELECT realized_pnl, is_whitelist FROM smart_wallets WHERE address = '0xw'",
        )
        .get() as { realized_pnl: number | null; is_whitelist: number };
      expect(w.realized_pnl).toBeNull();
      expect(w.is_whitelist).toBe(1);
      expect(
        db2
          .prepare("SELECT value FROM config WHERE key = 'smart_seed_last_day'")
          .get(),
      ).toBeUndefined();
      expect(
        (
          db2
            .prepare("SELECT value FROM config WHERE key = 'wallet_stats_v'")
            .get() as { value: string }
        ).value,
      ).toBe("3");
      // Re-cache a row, reopen: marker present → cache preserved (runs once).
      db2
        .prepare(
          "INSERT INTO wallet_stats (wallet, win_rate, realized_pnl, roi, settled_count, truncated, fetched_at) VALUES ('0xb', 1, 5, 1, 3, 0, 1)",
        )
        .run();
      db2.close();
      const db3 = openDb(path);
      expect(
        (
          db3.prepare("SELECT COUNT(*) AS c FROM wallet_stats").get() as {
            c: number;
          }
        ).c,
      ).toBe(1);
      db3.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the alerts dedup sweep exactly once via the version marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "whaledb-"));
    const path = join(dir, "t.sqlite");
    try {
      // Simulate a pre-index database: index dropped (duplicates possible
      // again), no marker.
      const db1 = openDb(path);
      db1.prepare("DROP INDEX idx_alerts_type_dedup").run();
      db1.prepare("DELETE FROM config WHERE key = 'alerts_dedup_v'").run();
      const ins1 = db1.prepare(
        "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES (?, ?, '{}', ?)",
      );
      ins1.run("large", "dup", 1);
      ins1.run("large", "dup", 2);
      ins1.run("large", "solo", 3);
      db1.close();

      // Reopen: marker missing → sweep collapses the duplicate group to its
      // oldest row and writes the marker.
      const db2 = openDb(path);
      const rows = db2
        .prepare("SELECT dedup_key, created_at FROM alerts ORDER BY created_at")
        .all();
      expect(rows).toEqual([
        { dedup_key: "dup", created_at: 1 },
        { dedup_key: "solo", created_at: 3 },
      ]);
      const marker = db2
        .prepare("SELECT value FROM config WHERE key = 'alerts_dedup_v'")
        .get() as { value: string };
      expect(marker.value).toBe("1");
      db2.close();

      // Marker present → the sweep must be SKIPPED (that's the whole point:
      // per-request openDb callers no longer pay a table-scan write). Plant
      // duplicates again with the index dropped: an ungated sweep would
      // silently heal them, so the gated openDb instead trips on recreating
      // the unique index — proof no DELETE ran.
      const db3 = openDb(path);
      db3.prepare("DROP INDEX idx_alerts_type_dedup").run();
      const ins3 = db3.prepare(
        "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES (?, ?, '{}', ?)",
      );
      ins3.run("large", "dup2", 10);
      ins3.run("large", "dup2", 11);
      db3.close();
      expect(() => openDb(path)).toThrow(/UNIQUE/i);
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
