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
    CREATE TABLE IF NOT EXISTS event_category (event_slug TEXT PRIMARY KEY, category TEXT, fetched_at INTEGER);
    CREATE TABLE IF NOT EXISTS consensus_state (condition_id TEXT, outcome TEXT, wallet_count INTEGER, total_usd REAL, last_alert_ts INTEGER, PRIMARY KEY (condition_id, outcome));
    CREATE TABLE IF NOT EXISTS alert_outcomes (alert_id INTEGER PRIMARY KEY, price_1h REAL, price_24h REAL, resolved INTEGER DEFAULT 0, resolution_price REAL, won INTEGER, checked_at INTEGER);
    CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at);
  `);
  // One alert row per (type, dedup_key): running the embedded engine and the
  // standalone worker against the same db is a documented deployment, and their
  // check-then-act race could double-insert. The one-time cleanup removes any
  // duplicates created before the unique index existed (keeps the oldest row).
  db.exec(`
    DELETE FROM alerts WHERE dedup_key IS NOT NULL AND id NOT IN (
      SELECT MIN(id) FROM alerts GROUP BY type, dedup_key
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_type_dedup ON alerts(type, dedup_key);
  `);
  // wallet_age v2: earlier builds could PERMANENTLY cache a wrong first_ts —
  // the upstream sort occasionally misbehaves and the CDN then serves the
  // mis-sorted payload, so "first row of the ASC query" was sometimes a much
  // later activity. The cache rebuilds lazily from verified probes, so the
  // one-time purge below is cheap; the marker keeps it from re-running.
  const ageVer = db
    .prepare("SELECT value FROM config WHERE key = 'wallet_age_v'")
    .get() as { value: string | null } | undefined;
  if (ageVer?.value !== "2") {
    db.prepare("DELETE FROM wallet_age").run();
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('wallet_age_v', '2')",
    ).run();
  }
  return db;
}
export type DB = ReturnType<typeof openDb>;
