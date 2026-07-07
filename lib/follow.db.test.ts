import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";

describe("follow tables migration", () => {
  it("creates follow_strategies + follow_positions, seeds two strategies, enforces the position UNIQUE key", () => {
    const db = openDb(":memory:");
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('follow_strategies','follow_positions')",
        )
        .all() as { name: string }[]
    )
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual(["follow_positions", "follow_strategies"]);

    const strats = (
      db.prepare("SELECT name FROM follow_strategies ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(strats).toEqual(["保守", "激进"]);

    db.prepare(
      "INSERT INTO follow_positions (strategy_id, condition_id, outcome, status) VALUES (1,'c','Yes','open')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO follow_positions (strategy_id, condition_id, outcome, status) VALUES (1,'c','Yes','open')",
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it("seeds the two strategies exactly once via the follow_seed_v marker (reopen must not re-seed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "whaledb-"));
    const path = join(dir, "t.sqlite");
    const names = (db: ReturnType<typeof openDb>) =>
      (
        db
          .prepare("SELECT name FROM follow_strategies ORDER BY name")
          .all() as {
          name: string;
        }[]
      ).map((r) => r.name);
    const marker = (db: ReturnType<typeof openDb>) =>
      (
        db
          .prepare("SELECT value FROM config WHERE key = 'follow_seed_v'")
          .get() as { value: string } | undefined
      )?.value;
    try {
      // First open: marker missing → seed runs and writes follow_seed_v = "1".
      const db1 = openDb(path);
      expect(names(db1)).toEqual(["保守", "激进"]);
      expect(marker(db1)).toBe("1");
      db1.close();

      // Plain reopen of the SAME file: marker present, so the count stays
      // exactly 2 — the in-memory case can never exercise a reopen.
      const db2 = openDb(path);
      expect(names(db2)).toEqual(["保守", "激进"]);
      expect(marker(db2)).toBe("1");
      // Delete one seeded strategy while the marker stays "1". A gated openDb
      // must SKIP the seed block on the next open, so the deleted row must NOT
      // come back. This is the real regression catcher: with the version gate
      // removed, the seed block would re-run and INSERT OR IGNORE would silently
      // resurrect "保守" (name UNIQUE hides duplicates but not a missing row),
      // so a count-only assertion would pass even without the gate.
      db2.prepare("DELETE FROM follow_strategies WHERE name = '保守'").run();
      db2.close();

      const db3 = openDb(path);
      expect(names(db3)).toEqual(["激进"]);
      expect(marker(db3)).toBe("1");
      db3.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
