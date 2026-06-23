import type { DB } from "./db";
export const hasSeen = (db: DB, key: string) =>
  !!db.prepare("SELECT 1 FROM seen_trades WHERE dedup_key = ?").get(key);
export const markSeen = (db: DB, key: string, ts: number) =>
  db
    .prepare("INSERT OR IGNORE INTO seen_trades (dedup_key, ts) VALUES (?, ?)")
    .run(key, ts);
export const recordAlert = (
  db: DB,
  type: string,
  key: string,
  payload: string,
  createdAt: number,
) =>
  db
    .prepare(
      "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(type, key, payload, createdAt);
