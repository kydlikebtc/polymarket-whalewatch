// Bare specifiers on purpose: the worktree/webpack dev fallback can't resolve
// the "node:" scheme in server bundles (UnhandledSchemeError), while bare
// builtin names work in webpack AND turbopack.
import fs from "fs";
import path from "path";
import type { DB } from "./db";

// Daily SQLite snapshot. The 30-day public record lives in exactly one file
// on one volume — a disk fault or an accidental `docker volume rm` would zero
// the whole evidence chain. better-sqlite3's `db.backup()` uses SQLite's
// online-backup API (WAL-safe, incremental, never blocks the engine's own
// writes), so the engine can snapshot itself with no cron and no sidecar:
// deploying the image IS enabling backups.
//
// Semantics mirror maybeDailySelfCheck's day gate, with one difference: the
// day is marked only AFTER a successful snapshot (a failed backup must retry,
// not silently cost the whole day), and retries are spaced by an in-memory
// cooldown so a persistent failure (disk full) logs hourly instead of every
// 10-minute carrier cycle.

const BACKUP_DAY_KEY = "db_backup_last_day";
const KEEP_SNAPSHOTS = 7;
const FAILURE_COOLDOWN_MS = 60 * 60_000;
const SNAPSHOT_RE = /^data-\d{4}-\d{2}-\d{2}\.sqlite$/;

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface BackupState {
  lastFailureMs: number;
}

export function createBackupState(): BackupState {
  return { lastFailureMs: 0 };
}

export interface BackupResult {
  file: string;
  pruned: string[];
}

/** Snapshots newest-first by filename (date-stamped names sort lexically). */
export function listSnapshots(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => SNAPSHOT_RE.test(f))
    .sort((a, b) => b.localeCompare(a));
}

/**
 * Once per UTC day, snapshot the live db into `<db dir>/backups/data-<day>.sqlite`
 * and prune to the newest KEEP_SNAPSHOTS files. Returns null when gated (already
 * ran today / within the failure cooldown / in-memory db); throws on a failed
 * snapshot after recording the failure time.
 */
export async function maybeDailyBackup(
  db: DB,
  state: BackupState,
  opts: { dir?: string; nowMs?: number } = {},
): Promise<BackupResult | null> {
  const nowMs = opts.nowMs ?? Date.now();
  const day = utcDay(nowMs);
  const last = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(BACKUP_DAY_KEY) as { value: string | null } | undefined;
  if (last?.value === day) return null;
  if (nowMs - state.lastFailureMs < FAILURE_COOLDOWN_MS) return null;

  const dir = opts.dir ?? deriveBackupDir(db.name);
  if (!dir) {
    // :memory: / unnamed db — nothing durable to snapshot from.
    console.warn("[backup] skipped: db has no file path (in-memory?)");
    return null;
  }

  const dest = path.join(dir, `data-${day}.sqlite`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(dest)) {
      // Write to a temp name then rename: a crash mid-copy must never leave a
      // truncated file wearing a valid snapshot name.
      const tmp = `${dest}.tmp`;
      try {
        await db.backup(tmp);
        fs.renameSync(tmp, dest);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
    }
    // Mark the day only after the snapshot exists.
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
      BACKUP_DAY_KEY,
      day,
    );
  } catch (e) {
    state.lastFailureMs = nowMs;
    throw e;
  }

  const pruned: string[] = [];
  for (const f of listSnapshots(dir).slice(KEEP_SNAPSHOTS)) {
    try {
      fs.rmSync(path.join(dir, f));
      pruned.push(f);
    } catch (e) {
      // Prune failure is not a backup failure — today's snapshot is safe.
      console.warn(`[backup] prune failed for ${f}:`, e);
    }
  }
  return { file: dest, pruned };
}

function deriveBackupDir(dbPath: string): string | null {
  if (!dbPath || dbPath === ":memory:") return null;
  return path.join(path.dirname(path.resolve(dbPath)), "backups");
}
