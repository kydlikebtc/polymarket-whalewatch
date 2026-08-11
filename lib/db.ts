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
    CREATE TABLE IF NOT EXISTS config_history (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, value TEXT, changed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pool_purges (address TEXT PRIMARY KEY, reason TEXT NOT NULL, purged_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS heartbeats (loop TEXT PRIMARY KEY, last_ts INTEGER NOT NULL, day TEXT NOT NULL, cycles INTEGER NOT NULL, max_gap_sec INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cycle_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, loop TEXT NOT NULL, ts INTEGER NOT NULL, window_trades INTEGER, window_usd REAL, raw_groups INTEGER, contested_dropped INTEGER, fired INTEGER);
    CREATE INDEX IF NOT EXISTS idx_cycle_metrics_ts ON cycle_metrics(loop, ts);
    CREATE TABLE IF NOT EXISTS follow_strategies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, enabled INTEGER DEFAULT 1, params_json TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS follow_positions (id INTEGER PRIMARY KEY AUTOINCREMENT, strategy_id INTEGER, condition_id TEXT, outcome TEXT, asset TEXT, outcome_index INTEGER, title TEXT, event_slug TEXT, entry_ts INTEGER, entry_price REAL, smart_avg_price REAL, size_usd REAL, shares REAL, status TEXT, exit_ts INTEGER, exit_price REAL, realized_pnl REAL, formation_ts INTEGER, formation_price REAL, markout_30m REAL, markout_2h REAL, exec_price REAL, exec_best_ask REAL, exec_filled_usd REAL, fee_usd REAL, UNIQUE(strategy_id, condition_id, outcome));
    CREATE TABLE IF NOT EXISTS market_tilt_history (condition_id TEXT NOT NULL, ts INTEGER NOT NULL, lead_outcome TEXT, minor_outcome TEXT, minor_net_usd REAL, tilt_pct REAL, PRIMARY KEY (condition_id, ts));
    CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at);
    CREATE INDEX IF NOT EXISTS idx_candidates_evidence_ts ON wallet_candidates(evidence_ts);
    CREATE INDEX IF NOT EXISTS idx_market_tilt_history_ts ON market_tilt_history(ts);
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
  // follow_positions gained the formation/markout attribution columns after the
  // table already shipped (P1 信号触发改造):formation_ts/formation_price 记录
  // 共识「形成时刻」与彼时价格,markout_30m/markout_2h 惰性回填形成后 30min/2h
  // 的市价 —— 量化「延迟成本」用。红线:这些列只用于归因展示,绝不参与
  // realized_pnl。同 markets_traded 的写法:老库 ALTER 补列,新库 CREATE TABLE
  // 已含 → "duplicate column" 静默。
  // exec_*:执行层归因(开仓瞬间盘口快照模拟吃单)。exec_price=模拟成交均价、
  // exec_best_ask=彼时最优卖价、exec_filled_usd=盘口实际能吃下的金额(<size_usd
  // = 薄盘部分成交)。红线同上:只归因展示,绝不参与 realized_pnl。
  for (const col of [
    "formation_ts INTEGER",
    "formation_price REAL",
    "markout_30m REAL",
    "markout_2h REAL",
    "exec_price REAL",
    "exec_best_ask REAL",
    "exec_filled_usd REAL",
    // 协议 taker 费(开仓时按成交价与 gamma feeSchedule 算)。null = 未知
    // (费率表缺失/市场 meta 拿不到),0 = 该市场确实免费。红线同 exec_*:
    // 只做归因展示,不改写 realized_pnl 的定义 —— 历史数字不被静默重写。
    // 老仓恒为 null:费率表是当前值而非成交时刻值,回填会造出一个看不出
    // 是估算的估算值。
    "fee_usd REAL",
  ]) {
    try {
      db.prepare(`ALTER TABLE follow_positions ADD COLUMN ${col}`).run();
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
  // pool_pnl_reaudit v1 (P0.4, version-gated): the admission gate's win-rate
  // channel used to skip netPnl, letting a 58%-win-rate / −$87k wallet into
  // the pool (small wins, big losses). The gate now requires netPnl > 0; this
  // one-time sweep re-audits the EXISTING pool for exactly that loophole:
  // gate-admitted members (discovered:% / category:% — leaderboard members
  // never passed this gate) whose cached stats show the win-rate bar met but
  // a non-positive net P/L. Narrow on purpose: rows with missing stats are
  // NOT purged (evidence of losing required, absence of stats is not).
  // wallet_stats.realized_pnl physically stores netPnl (see lib/walletStats).
  // Purged wallets land in pool_purges ('purged:pnl') for traceability; the
  // tightened gate blocks their re-admission going forward.
  const pnlReauditVer = db
    .prepare("SELECT value FROM config WHERE key = 'pool_pnl_reaudit_v'")
    .get() as { value: string | null } | undefined;
  if (pnlReauditVer?.value !== "1") {
    db.prepare(
      `INSERT OR REPLACE INTO pool_purges (address, reason, purged_at)
       SELECT sw.address, 'purged:pnl', strftime('%s','now')
       FROM smart_wallets sw
       JOIN wallet_stats ws ON ws.wallet = sw.address
       WHERE sw.is_whitelist = 0
         AND (sw.source LIKE 'discovered:%' OR sw.source LIKE 'category:%')
         AND ws.win_rate >= 0.55 AND ws.settled_count >= 10
         AND ws.realized_pnl IS NOT NULL AND ws.realized_pnl <= 0`,
    ).run();
    const purgedPnl = db
      .prepare(
        `DELETE FROM smart_wallets WHERE address IN
           (SELECT address FROM pool_purges WHERE reason = 'purged:pnl')`,
      )
      .run().changes;
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('pool_pnl_reaudit_v', '1')",
    ).run();
    if (purgedPnl > 0) {
      console.log(
        `[db] pool_pnl_reaudit v1: purged ${purgedPnl} high-win-rate/negative-pnl member(s) — see pool_purges`,
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
  // follow_strategies seed v1→v2: paper follow-the-consensus simulation ships
  // with two built-in strategies (保守/激进). Version-gated like wallet_stats_v
  // above so the seed INSERT runs once per DB — dashboard routes open a fresh
  // connection per request, and INSERT OR IGNORE alone would keep probing the
  // unique index on every open for zero benefit after the first pass.
  //
  // v2(Task 12,12 档扩充):新增 10 档(A3-A5 共识族质量/总额/新鲜度门槛 /
  // B1-B3 单笔巨额族 / C1 一边倒分歧 / C2 分歧解除 / D1 高分独狼 / D2 早期
  // 赢家跟投)。红线:「保守」「激进」这两条生产策略已经积累了几周的仓位与
  // 战绩,历史仓是按旧参数开的 —— 改它们的任何字段都会让这条策略的战绩失去
  // 意义(不再对应任何一套一致的规则),故 v2 只 INSERT 新增的 10 条,绝不
  // UPDATE 既有两条。
  //
  // 门控条件直接从 !== "1" 改成 !== "2"(单个 if 块整体加宽),而不是在这个
  // if 块后面另开一个并列的 `if (!== "2")`:
  //   1. 并列写法会有两个问题 —— 语法上 `ins` 是块作用域 const,第二个 if 块
  //      看不见第一个块里声明的 `ins`,会需要重复 db.prepare 或直接报错;
  //      语义上更隐蔽的坑是,若把原 `!== "1"` 条件原样留在第一个 if 里,
  //      marker 一旦推进到 "2","2" !== "1" 依然成立 —— 第一个 if 会在
  //      **每次** openDb 时重新触发,把 marker 写回 "1",下次打开又触发第二
  //      个 if 写回 "2",两个 if 在其后每次开库时来回震荡,完全违背版本门控
  //      "只跑一次"的设计初衷(见上面这段注释开头的理由)。
  //   2. 单个加宽的 if 块没有这个问题:marker 一旦是 "2",整个块直接跳过。
  //   3. 块内重跑「保守」「激进」的 ins.run(...) 是安全的 no-op ——
  //      INSERT OR IGNORE + name 的 UNIQUE 约束保证:名字已存在时,SQLite
  //      连新值都不看就跳过整条 INSERT,既有行(含 params_json)不会被触碰,
  //      更不会被覆盖。这也是下面两条路径都成立的原因:
  //        - 全新库(marker 不存在):表是空的,两条 no-op 检查全部落空,
  //          12 条全部真实插入。
  //        - 既有 v1 库(marker="1",已有保守/激进):这两条 INSERT 命中
  //          UNIQUE 静默跳过,不写入也不覆盖;下面新增的 10 条全部真实插入。
  //   同样的 OR IGNORE 语义也覆盖了另一种情况:如果运维手工改过某条策略的
  //   名字、或手工加过同名策略,这里会静默跳过 —— 这是期望行为(不覆盖用户
  //   的手工修改),不是 bug。
  const followVer = db
    .prepare("SELECT value FROM config WHERE key = 'follow_seed_v'")
    .get() as { value: string | null } | undefined;
  if (followVer?.value !== "2") {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO follow_strategies (name, enabled, params_json, created_at) VALUES (?,1,?,?)",
    );
    const now = Math.floor(Date.now() / 1000);
    // maxEntryDeviationCents: 进场价偏离护栏(¢),现价偏离聪明钱均价超阈不开仓。
    // 仅影响全新安装;既有库的 params_json 缺该字段时由 lib/follow parseStrategy
    // 按同值默认兜底,故无需 bump follow_seed_v 做迁移。
    // ⚠️ 这两条 ins.run(...)(保守/激进)必须逐字节保持原样 —— 见上方红线说明。
    ins.run(
      "保守",
      JSON.stringify({
        minWallets: 3,
        minPerWalletUsd: 10000,
        sizeUsd: 500,
        exitRule: "settlement",
        maxEntryDeviationCents: 10,
      }),
      now,
    );
    ins.run(
      "激进",
      JSON.stringify({
        minWallets: 2,
        minPerWalletUsd: 5000,
        sizeUsd: 500,
        exitRule: "settlement",
        maxEntryDeviationCents: 10,
      }),
      now,
    );
    // v2 新增的 10 档。全部继承 exitRule/maxEntryDeviationCents/maxPrice/
    // freshSec 的默认值(parseStrategy 兜底,不必逐条写死 —— 将来调默认值时
    // 不用改 12 处)。source 均已在 FOLLOW_SOURCE_KINDS(lib/followCandidate.ts)
    // 注册,逐条核实过对应 detector 的必需参数都在场,不会成为开不出仓的死档:
    //   consensus 三档(A3-A5)靠 minWallets/minPerWalletUsd 通过 parseStrategy
    //     的强制校验;heavy 两档(B1-B2)与 lone_wolf/early_winner 各自的必需
    //     字段(minSingleFillUsd / minWalletScore+minNetUsd / minNetUsd)都在
    //     对应 detector(sourceHeavy.ts/sourceWallet.ts)读取的字段里。
    const seeds: [string, Record<string, unknown>][] = [
      // A3 精英共识:consensus + 质量门槛(仅 score>=80 的钱包计入 minWallets)。
      [
        "精英共识",
        {
          source: "consensus",
          minWallets: 2,
          minPerWalletUsd: 5000,
          minWalletScore: 80,
          sizeUsd: 500,
        },
      ],
      // A4 重仓共识:consensus + 总额门槛(不看人数,看总净买 >= $100k)。
      [
        "重仓共识",
        {
          source: "consensus",
          minWallets: 2,
          minPerWalletUsd: 5000,
          minTotalNetUsd: 100000,
          sizeUsd: 500,
        },
      ],
      // A5 首发共识:consensus + 更紧的新鲜度闸门(300s,抢在共识刚形成时跟)。
      [
        "首发共识",
        {
          source: "consensus",
          minWallets: 3,
          minPerWalletUsd: 10000,
          freshSec: 300,
          sizeUsd: 500,
        },
      ],
      // B1 巨鲸:heavy,单笔 BUY notional >= $50k。
      ["巨鲸", { source: "heavy", minSingleFillUsd: 50000, sizeUsd: 500 }],
      // B2 超级巨鲸:heavy,单笔 >= $150k(金额门槛的边际收益)。
      ["超级巨鲸", { source: "heavy", minSingleFillUsd: 150000, sizeUsd: 500 }],
      // B3 巨鲸精英:heavy + 质量门槛(score>=80,金额 × 质量交叉)。
      [
        "巨鲸精英",
        {
          source: "heavy",
          minSingleFillUsd: 50000,
          minWalletScore: 80,
          sizeUsd: 500,
        },
      ],
      // C1 一边倒分歧:lopsided。minTiltPct/minPerSideUsd 在这里是给人看的
      // 口径说明,不是 detectLopsidedCandidates 实际读取的开关字段 —— 该
      // detector 只消费 runFollowCycle 用 DEFAULT_DISAGREEMENT(lib/
      // disagreement.ts,同为 tiltPct>=0.7 / minPerSideUsd=$5000)预先算好的
      // ctx.contested,不会为每条策略单独重跑一遍分歧检测(理由见
      // lib/sourceLopsided.ts 文件头注释:避免出现"detectDisagreement 标了
      // balanced 但 C1 却跟了"的自相矛盾)。minPerSideUsd 数值上与
      // DEFAULT_DISAGREEMENT 一致,但改这个数字不会改变本档任何实际行为
      // (无害冗余,不是死档风险 —— detectLopsidedCandidates 没有任何"必需
      // 字段缺失即返回 []"的校验,永远会跑,只是产出多少取决于 ctx.contested)。
      [
        "一边倒分歧",
        {
          source: "lopsided",
          minTiltPct: 0.7,
          minPerSideUsd: 5000,
          sizeUsd: 500,
        },
      ],
      // C2 分歧解除:resolved。minPerSideUsd 同上是文档值而非开关 ——
      // detectResolvedCandidates 完全不读 params.minPerSideUsd,判定只看
      // ctx.prevTilt(上一轮由 DEFAULT_DISAGREEMENT 写入的快照)与本轮现金流
      // 口径(isCapitulating),见 lib/sourceResolved.ts。同 C1,不是死档风险。
      ["分歧解除", { source: "resolved", minPerSideUsd: 5000, sizeUsd: 500 }],
      // D1 高分独狼:lone_wolf,score>=90 且净买(净股数口径)>= $10k ——
      // 两个字段都是 detectLoneWolfCandidates/detectWalletCandidates 的必需
      // 参数,缺一即恒空候选。
      [
        "高分独狼",
        {
          source: "lone_wolf",
          minWalletScore: 90,
          minNetUsd: 10000,
          sizeUsd: 500,
        },
      ],
      // D2 早期赢家跟投:early_winner,净买 >= $5k —— 比 D1 的 $10k 松,是
      // 有意为之:D2 的钱包筛选轴(early_winner 渠道成员资格)已经比 D1 的
      // score 更严格地把关过身份,金额门槛可以松一些。detectEarlyWinnerCandidates
      // 与 D1 共用 detectWalletCandidates,同样读 params.minNetUsd 作为 floor。
      [
        "早期赢家跟投",
        { source: "early_winner", minNetUsd: 5000, sizeUsd: 500 },
      ],
    ];
    for (const [name, params] of seeds) {
      ins.run(name, JSON.stringify(params), now);
    }
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('follow_seed_v', '2')",
    ).run();
  }
  return db;
}
export type DB = ReturnType<typeof openDb>;
