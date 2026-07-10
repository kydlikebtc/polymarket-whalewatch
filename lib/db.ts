import Database from "better-sqlite3";
import { settleWon } from "./outcomeStats";
export function openDb(path = "data.sqlite") {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_trades (dedup_key TEXT PRIMARY KEY, ts INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS smart_wallets (address TEXT PRIMARY KEY, score REAL, realized_pnl REAL, win_rate REAL, roi REAL, volume REAL, consistency REAL, is_whitelist INTEGER DEFAULT 0, updated_at INTEGER, source TEXT);
    CREATE TABLE IF NOT EXISTS token_map (token_id TEXT PRIMARY KEY, condition_id TEXT, question TEXT, outcome TEXT, slug TEXT, event_slug TEXT, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, dedup_key TEXT, payload TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS wallet_age (wallet TEXT PRIMARY KEY, first_ts INTEGER, fetched_at INTEGER);
    CREATE TABLE IF NOT EXISTS wallet_stats (wallet TEXT PRIMARY KEY, win_rate REAL, realized_pnl REAL, roi REAL, settled_count INTEGER, truncated INTEGER, markets_traded INTEGER, fetched_at INTEGER);
    CREATE TABLE IF NOT EXISTS market_meta (condition_id TEXT PRIMARY KEY, meta_json TEXT, fetched_at INTEGER);
    CREATE TABLE IF NOT EXISTS event_category (event_slug TEXT PRIMARY KEY, category TEXT, fetched_at INTEGER);
    CREATE TABLE IF NOT EXISTS consensus_state (condition_id TEXT, outcome TEXT, wallet_count INTEGER, total_usd REAL, last_alert_ts INTEGER, PRIMARY KEY (condition_id, outcome));
    CREATE TABLE IF NOT EXISTS alert_outcomes (alert_id INTEGER PRIMARY KEY, price_1h REAL, price_24h REAL, resolved INTEGER DEFAULT 0, resolution_price REAL, won INTEGER, checked_at INTEGER);
    CREATE TABLE IF NOT EXISTS wallet_candidates (address TEXT NOT NULL, channel TEXT NOT NULL, condition_id TEXT NOT NULL, evidence_ts INTEGER, usd REAL, price REAL, note TEXT, title TEXT, slug TEXT, event_slug TEXT, outcome TEXT, created_at INTEGER, PRIMARY KEY (address, channel, condition_id));
    CREATE TABLE IF NOT EXISTS early_winner_scans (condition_id TEXT PRIMARY KEY, scanned_at INTEGER, trades_scanned INTEGER, truncated INTEGER);
    CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at);
    CREATE INDEX IF NOT EXISTS idx_candidates_evidence_ts ON wallet_candidates(evidence_ts);
  `);
  // wallet_stats gained markets_traded (the high-frequency market-maker
  // classifier) after the table already shipped; add it to pre-existing DBs.
  // Harmless "duplicate column" on fresh DBs where CREATE TABLE already has it.
  try {
    db.prepare(
      "ALTER TABLE wallet_stats ADD COLUMN markets_traded INTEGER",
    ).run();
  } catch {
    // column already present
  }
  // smart_wallets gained source (first-discoverer channel attribution: which
  // pipeline put the wallet in the pool — 'leaderboard', 'category:<cat>',
  // 'discovered:<channel>') after the table shipped; add it to pre-existing
  // DBs (idempotent duplicate-column swallow, same as markets_traded above).
  try {
    db.prepare("ALTER TABLE smart_wallets ADD COLUMN source TEXT").run();
  } catch {
    // column already present
  }
  // wallet_candidates gained full market context (title / market slug / event
  // slug / outcome) after the table shipped — the evidence detail on /discovery
  // used to show only a 40-char truncated title inside the note. Legacy rows
  // start NULL (the UI falls back to the note) and heal by two paths: a
  // re-observation of the behavior refreshes them through recordEvidence, and
  // the engine's backfillEvidenceMarketContext pass fills the rest straight
  // from gamma (early_winner markets are scanned exactly once, so upsert-time
  // healing alone could never reach that channel's legacy rows).
  for (const col of ["title", "slug", "event_slug", "outcome"]) {
    try {
      db.prepare(`ALTER TABLE wallet_candidates ADD COLUMN ${col} TEXT`).run();
    } catch {
      // column already present
    }
  }
  // discovery_gate v1 (version-gated like wallet_age_v — several routes open
  // a connection per request, so unconditional writes here would contend for
  // the WAL lock on every request):
  //  1. Backfill source for legacy rows. Auto rows (is_whitelist=0) can ONLY
  //     have come from leaderboard seeding — the sole write path before the
  //     discovery channels existed — so this is attribution, not guesswork.
  //     Manually-flagged rows keep an honest NULL (origin unknowable).
  //  2. Purge category rows written by the first channel-③ build, which
  //     seeded them WITHOUT the admission quality gate (a category board's
  //     tail is not a quality bar). Rebuildable cache: clearing the seed-day
  //     marker forces the next cycle to re-seed, and the gated path re-admits
  //     only the specialists whose track record passes.
  const gateVer = db
    .prepare("SELECT value FROM config WHERE key = 'discovery_gate_v'")
    .get() as { value: string | null } | undefined;
  if (gateVer?.value !== "1") {
    db.prepare(
      "UPDATE smart_wallets SET source = 'leaderboard' WHERE source IS NULL AND is_whitelist = 0",
    ).run();
    const purged = db
      .prepare(
        "DELETE FROM smart_wallets WHERE source LIKE 'category:%' AND is_whitelist = 0",
      )
      .run().changes;
    db.prepare("DELETE FROM config WHERE key = 'smart_seed_last_day'").run();
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('discovery_gate_v', '1')",
    ).run();
    if (purged > 0) {
      console.log(
        `[db] discovery_gate v1: purged ${purged} ungated category row(s) — next seed re-admits through the quality gate`,
      );
    }
  }
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
  // wallet_stats versioning — bump to purge the cached stats and re-seed the
  // whitelist whenever the stat SEMANTICS change:
  //  v2: added the survivorship patch (held-to-zero losers from /positions) so
  //      pure-closed win rates stop reading a fake 100%.
  //  v3: the displayed pnl is now the AUTHORITATIVE net P/L from user-pnl-api
  //      (the realized_pnl column stores it), not the /closed-positions sum —
  //      which was sorted by realizedPnl DESC and truncated at 400 rows, feeding
  //      a winners-only slice that inflated pnl AND win rate. The page cap was
  //      also raised. Purge so every wallet re-fetches under the new pipeline.
  //  v4: winRate/roi are now NULL for a TRUNCATED record (the fetched top slice
  //      is winner-biased, so a high-frequency wallet read a fake ~100% win rate
  //      and inflated roi that are unrecoverable). Purge so cached truncated rows
  //      recompute to null instead of serving the old fake numbers for 24h.
  //  v5: high-frequency market makers (>=1000 distinct markets traded) are now
  //      classified up front and skip win-rate entirely (markets_traded column).
  //      Purge so cached rows re-fetch and populate markets_traded / the label.
  const statsVer = db
    .prepare("SELECT value FROM config WHERE key = 'wallet_stats_v'")
    .get() as { value: string | null } | undefined;
  if (statsVer?.value !== "5") {
    db.prepare("DELETE FROM wallet_stats").run();
    // smart_wallets.realized_pnl now means netPnl, but existing rows hold the old
    // biased closed-sum. NULL it (can't DELETE the rows — that would drop manual
    // is_whitelist flags): board-present wallets get a correct netPnl on the next
    // re-seed, off-board rows (incl. manual whitelist that may never re-appear on
    // a board) show "—" instead of a wrong value mislabeled "净盈亏".
    db.prepare("UPDATE smart_wallets SET realized_pnl = NULL").run();
    db.prepare("DELETE FROM config WHERE key = 'smart_seed_last_day'").run();
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('wallet_stats_v', '5')",
    ).run();
  }
  return db;
}
export type DB = ReturnType<typeof openDb>;
