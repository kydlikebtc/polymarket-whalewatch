import Database from "better-sqlite3";
import { settleWon } from "./outcomeStats";
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
  // Version-gated like wallet_age_v below: the GROUP BY sweep scans the whole
  // alerts table, and several dashboard routes open a fresh connection per
  // request — ungated, it re-ran a table-sized WRITE on every request,
  // contending with the worker's WAL lock for zero benefit after the first
  // pass (the unique index prevents any new duplicates).
  const dedupVer = db
    .prepare("SELECT value FROM config WHERE key = 'alerts_dedup_v'")
    .get() as { value: string | null } | undefined;
  if (dedupVer?.value !== "1") {
    const swept = db
      .prepare(
        `DELETE FROM alerts WHERE dedup_key IS NOT NULL AND id NOT IN (
           SELECT MIN(id) FROM alerts GROUP BY type, dedup_key
         )`,
      )
      .run().changes;
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('alerts_dedup_v', '1')",
    ).run();
    if (swept > 0) {
      console.log(
        `[db] alerts dedup v1 sweep: removed ${swept} duplicate row(s)`,
      );
    }
  }
  db.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_type_dedup ON alerts(type, dedup_key)",
  ).run();
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
  // alert_outcomes v2: `won` used to be judged against a fixed 0.5 divider
  // regardless of the fill price — a BUY@0.9 settling at 0.6 (a real
  // 0.3/share loss) was cached as ✅. Settlements are immutable, so the wrong
  // verdicts never self-heal: rescore every cached settled row from
  // resolution_price + the payload's fill price (settleWon). The marker keeps
  // this one-time backfill from re-running; unreadable payloads are skipped.
  const wonVer = db
    .prepare("SELECT value FROM config WHERE key = 'outcome_won_v'")
    .get() as { value: string | null } | undefined;
  if (wonVer?.value !== "2") {
    const rows = db
      .prepare(
        `SELECT ao.alert_id AS id, ao.resolution_price AS rp, ao.won AS won,
                a.type AS type, a.payload AS payload
           FROM alert_outcomes ao JOIN alerts a ON a.id = ao.alert_id
          WHERE ao.resolved = 1 AND ao.resolution_price IS NOT NULL`,
      )
      .all() as {
      id: number;
      rp: number;
      won: number | null;
      type: string | null;
      payload: string | null;
    }[];
    const upd = db.prepare(
      "UPDATE alert_outcomes SET won = ? WHERE alert_id = ?",
    );
    let corrected = 0;
    db.transaction(() => {
      for (const r of rows) {
        try {
          const p = JSON.parse(r.payload ?? "") as Record<string, unknown>;
          // Consensus groups are tracked as a synthetic BUY at avgBuyPrice
          // (mirrors parseTrackable in lib/alertOutcomes).
          const side = r.type === "consensus" ? "BUY" : p.side;
          const entry = r.type === "consensus" ? p.avgBuyPrice : p.price;
          if ((side !== "BUY" && side !== "SELL") || typeof entry !== "number")
            continue;
          const won = settleWon(side, entry, r.rp);
          const wonInt = won == null ? null : won ? 1 : 0;
          if (wonInt !== r.won) {
            upd.run(wonInt, r.id);
            corrected++;
          }
        } catch {
          // Malformed payload — leave the cached verdict untouched.
        }
      }
      db.prepare(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('outcome_won_v', '2')",
      ).run();
    })();
    if (rows.length > 0) {
      console.log(
        `[db] outcome_won v2 backfill: rescored ${rows.length} settled rows vs fill price, corrected ${corrected}`,
      );
    }
  }
  // wallet_stats v2: earlier stats were survivorship-biased — positions held
  // to ZERO never enter /closed-positions (nothing to redeem), so pure-closed
  // win rates read 100% for wallets that ride losers into the ground. v2 also
  // counts resolved-but-unclosed positions from /positions. Purge the biased
  // cache and clear the seed-day marker so the smart-wallet whitelist re-scores
  // with honest win rates on the engine's next cycle.
  const statsVer = db
    .prepare("SELECT value FROM config WHERE key = 'wallet_stats_v'")
    .get() as { value: string | null } | undefined;
  if (statsVer?.value !== "2") {
    db.prepare("DELETE FROM wallet_stats").run();
    db.prepare("DELETE FROM config WHERE key = 'smart_seed_last_day'").run();
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('wallet_stats_v', '2')",
    ).run();
  }
  return db;
}
export type DB = ReturnType<typeof openDb>;
