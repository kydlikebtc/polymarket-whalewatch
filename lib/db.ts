import Database from "better-sqlite3";
export function openDb(path = "data.sqlite") {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_trades (dedup_key TEXT PRIMARY KEY, ts INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS smart_wallets (address TEXT PRIMARY KEY, score REAL, realized_pnl REAL, win_rate REAL, roi REAL, volume REAL, consistency REAL, is_whitelist INTEGER DEFAULT 0, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS token_map (token_id TEXT PRIMARY KEY, condition_id TEXT, question TEXT, outcome TEXT, slug TEXT, event_slug TEXT, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, dedup_key TEXT, payload TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS wallet_age (wallet TEXT PRIMARY KEY, first_ts INTEGER, fetched_at INTEGER);
    CREATE TABLE IF NOT EXISTS wallet_stats (wallet TEXT PRIMARY KEY, win_rate REAL, realized_pnl REAL, roi REAL, settled_count INTEGER, truncated INTEGER, fetched_at INTEGER);
    CREATE TABLE IF NOT EXISTS market_meta (condition_id TEXT PRIMARY KEY, meta_json TEXT, fetched_at INTEGER);
    CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at);
  `);
  return db;
}
export type DB = ReturnType<typeof openDb>;
