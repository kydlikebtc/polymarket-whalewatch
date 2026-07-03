import type { DB } from "./db";

// SEMANTICS: a seen_trades row means an engine process has CLAIMED/DISPOSITIONED
// the trade — pushed as an alert, evaluated-and-rejected, or skipped as
// pre-window backlog. Because markSeen is INSERT OR IGNORE, writing the row
// doubles as a cross-process preemption lock (embedded engine + standalone
// worker on one db is a documented deployment): `.changes === 1` means WE
// claimed the key, `0` means another process (or an earlier cycle) already did.
// unmarkSeen is the claim rollback for a failed Telegram send — the only path
// that ever deletes a row, keeping at-least-once delivery.

export const hasSeen = (db: DB, key: string) =>
  !!db.prepare("SELECT 1 FROM seen_trades WHERE dedup_key = ?").get(key);

// Stay under SQLite's historical 999 bind-variable limit.
const IN_CHUNK = 900;

// Batch membership check: one IN(...) query per chunk instead of a point query
// per key — a full 1000-row /trades page is mostly already-seen on a 4s cadence.
export function seenKeySet(db: DB, keys: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < keys.length; i += IN_CHUNK) {
    const chunk = keys.slice(i, i + IN_CHUNK);
    const rows = db
      .prepare(
        `SELECT dedup_key FROM seen_trades WHERE dedup_key IN (${chunk
          .map(() => "?")
          .join(",")})`,
      )
      .all(...chunk) as { dedup_key: string }[];
    for (const r of rows) out.add(r.dedup_key);
  }
  return out;
}

export const markSeen = (db: DB, key: string, ts: number) =>
  db
    .prepare("INSERT OR IGNORE INTO seen_trades (dedup_key, ts) VALUES (?, ?)")
    .run(key, ts);

// Claim rollback (send failed): drop the row so the trade retries next cycle.
export const unmarkSeen = (db: DB, key: string) =>
  db.prepare("DELETE FROM seen_trades WHERE dedup_key = ?").run(key);

// Transactional sweep for "mark everything evaluated" passes: one statement
// reused inside a single transaction instead of N autocommit writes.
export function markSeenBatch(db: DB, rows: { key: string; ts: number }[]) {
  if (rows.length === 0) return;
  const ins = db.prepare(
    "INSERT OR IGNORE INTO seen_trades (dedup_key, ts) VALUES (?, ?)",
  );
  db.transaction(() => {
    for (const r of rows) ins.run(r.key, r.ts);
  })();
}

// --- Daily retention prune ----------------------------------------------
// seen_trades is a dedup ledger, not product data (alerts is — never pruned):
// a row only matters while its trade can still reappear in some fetch window.
// 7 days dwarfs every window in the system — the poll resume window (startup
// backfill, capped at 30 min), the consensus/scan deep windows (≤24h), and
// the /trades 3000-offset depth cap — so pruning older rows can never
// resurrect a duplicate alert. It also can't disturb the startup backfill
// resume point: MAX(seen_trades.ts) is read at engine start, and pruning only
// removes the OLDEST rows (a >7d-idle db prunes to empty, which
// computeMinTimestamp already treats as a cold start at "now").
const PRUNE_DAY_KEY = "seen_prune_last_day";
const PRUNE_RETENTION_SEC = 7 * 86_400;

// Day-gated via a config marker (same pattern as maybeDailySeed's day key).
// Returns rows removed, or null when today's prune already ran. The marker is
// written AFTER the DELETE so a failed prune retries on the next cycle.
export function maybePruneSeen(
  db: DB,
  nowSec = Math.floor(Date.now() / 1000),
): number | null {
  const today = new Date(nowSec * 1000).toISOString().slice(0, 10);
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(PRUNE_DAY_KEY) as { value: string | null } | undefined;
  if (row?.value === today) return null;
  const cutoff = nowSec - PRUNE_RETENTION_SEC;
  const removed = db
    .prepare("DELETE FROM seen_trades WHERE ts < ?")
    .run(cutoff).changes;
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    PRUNE_DAY_KEY,
    today,
  );
  console.log(
    `[seen] daily prune: removed ${removed} row(s) older than 7d (cutoff=${cutoff})`,
  );
  return removed;
}

export const recordAlert = (
  db: DB,
  type: string,
  key: string,
  payload: string,
  createdAt: number,
) =>
  // OR IGNORE + the unique (type, dedup_key) index: if a second process raced
  // us past its hasSeen check, the alert row still lands exactly once.
  db
    .prepare(
      "INSERT OR IGNORE INTO alerts (type, dedup_key, payload, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(type, key, payload, createdAt);
