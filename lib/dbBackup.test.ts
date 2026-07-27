import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDb, type DB } from "./db";
import {
  createBackupState,
  listSnapshots,
  maybeDailyBackup,
  type BackupState,
} from "./dbBackup";

// 2026-07-27T12:00:00Z
const NOW = Date.UTC(2026, 6, 27, 12) as number;
const TODAY = "2026-07-27";

let tmp: string;
let db: DB;
let state: BackupState;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "whalewatch-backup-"));
  db = openDb(path.join(tmp, "data.sqlite"));
  db.prepare(
    "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES ('large', 'k1', '{}', 1)",
  ).run();
  state = createBackupState();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const backupDir = () => path.join(tmp, "backups");

describe("maybeDailyBackup", () => {
  it("snapshots into <db dir>/backups/data-<day>.sqlite and the copy is a valid db", async () => {
    const r = await maybeDailyBackup(db, state, { nowMs: NOW });
    expect(r).not.toBeNull();
    expect(r!.file).toBe(path.join(backupDir(), `data-${TODAY}.sqlite`));
    expect(fs.existsSync(r!.file)).toBe(true);
    // The snapshot must be an openable database containing the data.
    const copy = new Database(r!.file, { readonly: true });
    const n = (
      copy.prepare("SELECT COUNT(*) AS n FROM alerts").get() as { n: number }
    ).n;
    copy.close();
    expect(n).toBe(1);
    // No leftover temp file.
    expect(fs.existsSync(`${r!.file}.tmp`)).toBe(false);
  });

  it("runs once per UTC day (second call gated), and runs again next day", async () => {
    expect(await maybeDailyBackup(db, state, { nowMs: NOW })).not.toBeNull();
    expect(await maybeDailyBackup(db, state, { nowMs: NOW + 3600_000 })).toBe(
      null,
    );
    const nextDay = NOW + 24 * 3600_000;
    const r2 = await maybeDailyBackup(db, state, { nowMs: nextDay });
    expect(r2).not.toBeNull();
    expect(listSnapshots(backupDir())).toHaveLength(2);
  });

  it("prunes to the newest 7 snapshots and reports what it removed", async () => {
    fs.mkdirSync(backupDir(), { recursive: true });
    // 9 older date-stamped snapshots + one non-matching file that must survive.
    for (let i = 1; i <= 9; i++) {
      const d = `2026-07-${String(i).padStart(2, "0")}`;
      fs.writeFileSync(path.join(backupDir(), `data-${d}.sqlite`), "x");
    }
    fs.writeFileSync(path.join(backupDir(), "notes.txt"), "keep me");
    const r = await maybeDailyBackup(db, state, { nowMs: NOW });
    expect(r).not.toBeNull();
    const left = listSnapshots(backupDir());
    expect(left).toHaveLength(7);
    expect(left[0]).toBe(`data-${TODAY}.sqlite`); // newest kept
    expect(left.at(-1)).toBe("data-2026-07-04.sqlite"); // 03, 02, 01 pruned
    expect(r!.pruned.sort()).toEqual([
      "data-2026-07-01.sqlite",
      "data-2026-07-02.sqlite",
      "data-2026-07-03.sqlite",
    ]);
    expect(fs.existsSync(path.join(backupDir(), "notes.txt"))).toBe(true);
  });

  it("a failed snapshot throws, does NOT consume the day, and cools down before retrying", async () => {
    // Occupy the backups path with a FILE so mkdir fails deterministically.
    fs.writeFileSync(backupDir(), "not a dir");
    await expect(maybeDailyBackup(db, state, { nowMs: NOW })).rejects.toThrow();
    // Within the cooldown: gated silently (no second attempt, no throw).
    await expect(
      maybeDailyBackup(db, state, { nowMs: NOW + 10 * 60_000 }),
    ).resolves.toBeNull();
    // After the cooldown, with the obstruction removed, the SAME day succeeds
    // — a failure never marks the day as done.
    fs.rmSync(backupDir());
    const r = await maybeDailyBackup(db, state, { nowMs: NOW + 61 * 60_000 });
    expect(r).not.toBeNull();
    expect(fs.existsSync(r!.file)).toBe(true);
  });

  it("an existing snapshot for today is adopted (marks the day) without rewriting it", async () => {
    fs.mkdirSync(backupDir(), { recursive: true });
    const dest = path.join(backupDir(), `data-${TODAY}.sqlite`);
    fs.writeFileSync(dest, "pre-existing");
    const r = await maybeDailyBackup(db, state, { nowMs: NOW });
    expect(r).not.toBeNull();
    // Content untouched — the crashed-after-write case must not re-copy over
    // a snapshot that already exists.
    expect(fs.readFileSync(dest, "utf8")).toBe("pre-existing");
    // Day consumed.
    expect(await maybeDailyBackup(db, state, { nowMs: NOW + 1 })).toBeNull();
  });

  it("skips in-memory databases with a warning instead of throwing", async () => {
    const mem = new Database(":memory:");
    mem.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)");
    const r = await maybeDailyBackup(mem as DB, state, { nowMs: NOW });
    mem.close();
    expect(r).toBeNull();
  });
});
