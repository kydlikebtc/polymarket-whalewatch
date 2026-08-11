import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "./db";
import type { DisagreementMarket } from "./disagreement";
import {
  pruneMarketTiltHistory,
  readMarketTiltSnapshots,
  writeMarketTiltSnapshots,
} from "./follow";

// P1 信号触发改造新增的归因列:formation_ts/formation_price(形成时刻三价记录)
// + markout_30m/markout_2h(形成后 30min/2h 的市价回填)。只用于归因展示,
// 绝不参与 realized_pnl。
// exec_*(开仓瞬间盘口快照模拟吃单)与 fee_usd(协议 taker 费)同为后加的
// 归因列 —— 老库必须靠 ALTER 补齐。这份清单曾漏掉它们:把 db.ts 里对应的
// ALTER 行删掉,全量测试依然全绿(所有用例都走 :memory: 新库,命中的是
// CREATE TABLE 而非 ALTER 路径),迁移缺失只会在真实老库上炸。
const FORMATION_COLS = [
  "formation_ts",
  "formation_price",
  "markout_30m",
  "markout_2h",
  "exec_price",
  "exec_best_ask",
  "exec_filled_usd",
  "fee_usd",
];

const positionCols = (db: ReturnType<typeof openDb>): string[] =>
  (
    db.prepare("PRAGMA table_info(follow_positions)").all() as {
      name: string;
    }[]
  ).map((r) => r.name);

describe("follow tables migration", () => {
  it("creates follow_strategies + follow_positions, seeds two strategies, enforces the position UNIQUE key", () => {
    const db = openDb(":memory:");
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('follow_strategies','follow_positions')",
        )
        .all() as { name: string }[]
    )
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual(["follow_positions", "follow_strategies"]);

    const strats = (
      db.prepare("SELECT name FROM follow_strategies ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(strats).toEqual(["保守", "激进"]);

    db.prepare(
      "INSERT INTO follow_positions (strategy_id, condition_id, outcome, status) VALUES (1,'c','Yes','open')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO follow_positions (strategy_id, condition_id, outcome, status) VALUES (1,'c','Yes','open')",
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it("fresh db: follow_positions carries the formation/markout columns", () => {
    const db = openDb(":memory:");
    const cols = positionCols(db);
    for (const c of FORMATION_COLS) expect(cols).toContain(c);
    db.close();
  });

  it("pre-existing db without the columns gets them via ALTER TABLE on reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "whaledb-"));
    const path = join(dir, "old.sqlite");
    try {
      // 老库形状:P1 之前的 follow_positions(无 formation/markout 列)。
      // CREATE TABLE IF NOT EXISTS 会跳过既有表,只有 ALTER 路径能补列。
      const raw = new Database(path);
      raw
        .prepare(
          "CREATE TABLE follow_positions (id INTEGER PRIMARY KEY AUTOINCREMENT, strategy_id INTEGER, condition_id TEXT, outcome TEXT, asset TEXT, outcome_index INTEGER, title TEXT, event_slug TEXT, entry_ts INTEGER, entry_price REAL, smart_avg_price REAL, size_usd REAL, shares REAL, status TEXT, exit_ts INTEGER, exit_price REAL, realized_pnl REAL, UNIQUE(strategy_id, condition_id, outcome))",
        )
        .run();
      raw.close();

      const db = openDb(path);
      const cols = positionCols(db);
      for (const c of FORMATION_COLS) expect(cols).toContain(c);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("seeds the two strategies exactly once via the follow_seed_v marker (reopen must not re-seed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "whaledb-"));
    const path = join(dir, "t.sqlite");
    const names = (db: ReturnType<typeof openDb>) =>
      (
        db
          .prepare("SELECT name FROM follow_strategies ORDER BY name")
          .all() as {
          name: string;
        }[]
      ).map((r) => r.name);
    const marker = (db: ReturnType<typeof openDb>) =>
      (
        db
          .prepare("SELECT value FROM config WHERE key = 'follow_seed_v'")
          .get() as { value: string } | undefined
      )?.value;
    try {
      // First open: marker missing → seed runs and writes follow_seed_v = "1".
      const db1 = openDb(path);
      expect(names(db1)).toEqual(["保守", "激进"]);
      expect(marker(db1)).toBe("1");
      db1.close();

      // Plain reopen of the SAME file: marker present, so the count stays
      // exactly 2 — the in-memory case can never exercise a reopen.
      const db2 = openDb(path);
      expect(names(db2)).toEqual(["保守", "激进"]);
      expect(marker(db2)).toBe("1");
      // Delete one seeded strategy while the marker stays "1". A gated openDb
      // must SKIP the seed block on the next open, so the deleted row must NOT
      // come back. This is the real regression catcher: with the version gate
      // removed, the seed block would re-run and INSERT OR IGNORE would silently
      // resurrect "保守" (name UNIQUE hides duplicates but not a missing row),
      // so a count-only assertion would pass even without the gate.
      db2.prepare("DELETE FROM follow_strategies WHERE name = '保守'").run();
      db2.close();

      const db3 = openDb(path);
      expect(names(db3)).toEqual(["激进"]);
      expect(marker(db3)).toBe("1");
      db3.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Task 9:market_tilt_history 建表 + 读写 + 保留期清理。C2(sourceResolved)
// 判定"少数边转净卖"跨轮对比靠这张表 —— 见 lib/follow.ts 里 readMarketTiltSnapshots
// / writeMarketTiltSnapshots / pruneMarketTiltHistory 三个函数的字段注释。
const disagreementMarket = (
  over: Partial<DisagreementMarket> = {},
): DisagreementMarket => ({
  conditionId: "0xc",
  title: "Market",
  slug: "market-slug",
  eventSlug: "event-slug",
  sides: [
    {
      outcome: "Yes",
      outcomeIndex: 0,
      asset: "assetYes",
      walletCount: 1,
      netUsd: 10000,
      weightedUsd: 8400,
      avgBuyPrice: 0.5,
      wallets: [],
      formationTs: null,
    },
    {
      outcome: "No",
      outcomeIndex: 1,
      asset: "assetNo",
      walletCount: 1,
      netUsd: 10000,
      weightedUsd: 8400,
      avgBuyPrice: 0.5,
      wallets: [],
      formationTs: null,
    },
  ],
  totalNetUsd: 20000,
  totalWeightedUsd: 16800,
  tiltPct: 0.5,
  tilt: "balanced",
  excludedWallets: 0,
  firstTs: 100,
  lastTs: 200,
  ...over,
});

describe("market_tilt_history 建表 + 读写 + 保留期清理(Task 9)", () => {
  it("openDb 建出 market_tilt_history 表,PRIMARY KEY (condition_id, ts) 六列齐全", () => {
    const db = openDb(":memory:");
    const exists = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='market_tilt_history'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(exists).toEqual(["market_tilt_history"]);
    const cols = (
      db.prepare("PRAGMA table_info(market_tilt_history)").all() as {
        name: string;
        pk: number;
      }[]
    ).sort((a, b) => a.name.localeCompare(b.name));
    expect(cols.map((c) => c.name).sort()).toEqual(
      [
        "condition_id",
        "ts",
        "lead_outcome",
        "minor_outcome",
        "minor_net_usd",
        "tilt_pct",
      ].sort(),
    );
    // 复合主键:condition_id 与 ts 都应带 pk 标记(PRAGMA table_info 的 pk 列
    // 从 1 开始按声明顺序编号,>0 即属于主键)。
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pkCols.sort()).toEqual(["condition_id", "ts"]);
    db.close();
  });

  it("写读往返:writeMarketTiltSnapshots 落库,readMarketTiltSnapshots 读回全部六个字段", () => {
    const db = openDb(":memory:");
    const contested = [disagreementMarket()];
    const written = writeMarketTiltSnapshots(db, contested, 1000);
    expect(written).toBe(1);

    const prev = readMarketTiltSnapshots(db);
    expect(prev.size).toBe(1);
    const snap = prev.get("0xc");
    expect(snap).toEqual({
      conditionId: "0xc",
      leadOutcome: "Yes", // sides[0]
      minorOutcome: "No", // sides[1]
      minorNetUsd: 10000, // sides[1].netUsd
      tiltPct: 0.5,
      ts: 1000,
    });
    db.close();
  });

  it("空 contested 数组:写入 0 行,不报错", () => {
    const db = openDb(":memory:");
    expect(writeMarketTiltSnapshots(db, [], 1000)).toBe(0);
    expect(readMarketTiltSnapshots(db).size).toBe(0);
    db.close();
  });

  it("每个 condition_id 只读回 ts 最大的那一条(上一轮快照,不是历史全量)", () => {
    const db = openDb(":memory:");
    // 第一次快照(ts=1000):No 边净买 $10k。
    writeMarketTiltSnapshots(db, [disagreementMarket()], 1000);
    // 第二次快照(ts=2000,更晚):No 边已经涨到 $20k —— 用不同的数值而不是只
    // 改 ts,确保断言读到的确实是"第二次写入的内容",不是"凑巧因为只有一行"。
    writeMarketTiltSnapshots(
      db,
      [
        disagreementMarket({
          sides: [
            {
              outcome: "Yes",
              outcomeIndex: 0,
              asset: "assetYes",
              walletCount: 1,
              netUsd: 15000,
              weightedUsd: 12600,
              avgBuyPrice: 0.5,
              wallets: [],
              formationTs: null,
            },
            {
              outcome: "No",
              outcomeIndex: 1,
              asset: "assetNo",
              walletCount: 2,
              netUsd: 20000,
              weightedUsd: 16800,
              avgBuyPrice: 0.5,
              wallets: [],
              formationTs: null,
            },
          ],
          tiltPct: 0.4286,
        }),
      ],
      2000,
    );

    const prev = readMarketTiltSnapshots(db);
    expect(prev.size).toBe(1); // 同一个 condition_id,只应有一条
    const snap = prev.get("0xc");
    expect(snap?.ts).toBe(2000);
    expect(snap?.minorNetUsd).toBe(20000); // 第二次写入的值,不是第一次的 10000
    db.close();
  });

  it("INSERT OR REPLACE:同一 (condition_id, ts) 重复写入覆盖而不报错/不重复行", () => {
    const db = openDb(":memory:");
    writeMarketTiltSnapshots(db, [disagreementMarket()], 1000);
    expect(() =>
      writeMarketTiltSnapshots(
        db,
        [disagreementMarket({ tiltPct: 0.9 })],
        1000, // 同一个 ts
      ),
    ).not.toThrow();
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM market_tilt_history")
      .get() as { n: number };
    expect(row.n).toBe(1); // 覆盖,不是追加成两行
    expect(readMarketTiltSnapshots(db).get("0xc")?.tiltPct).toBe(0.9);
    db.close();
  });

  it("保留期清理:7 天前的快照被删,近期的保留,返回删除行数", () => {
    const db = openDb(":memory:");
    const nowSec = 1_000_000;
    const RETENTION = 7 * 86400;
    // 老快照(condition_id 不同,好在 read 结果里分辨):ts 早于 nowSec-7d。
    writeMarketTiltSnapshots(
      db,
      [disagreementMarket({ conditionId: "0xold" })],
      nowSec - RETENTION - 10,
    );
    // 近期快照:ts 在保留期内。
    writeMarketTiltSnapshots(
      db,
      [disagreementMarket({ conditionId: "0xnew" })],
      nowSec - 10,
    );

    const removed = pruneMarketTiltHistory(db, nowSec);
    expect(removed).toBe(1);
    const prev = readMarketTiltSnapshots(db);
    expect(prev.has("0xold")).toBe(false);
    expect(prev.has("0xnew")).toBe(true);
    db.close();
  });
});
