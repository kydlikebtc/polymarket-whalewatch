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
