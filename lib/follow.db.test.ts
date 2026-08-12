import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "./db";
import { DEFAULT_DISAGREEMENT, type DisagreementMarket } from "./disagreement";
import {
  pruneMarketTiltHistory,
  parseStrategyForTest,
  readMarketTiltSnapshots,
  writeMarketTiltSnapshots,
} from "./follow";
import { FOLLOW_SOURCE_KINDS, isFollowSourceKind } from "./followCandidate";

// Task 12(策略种子 v2)新增的 10 档 + 既有「保守」「激进」= 12 条策略的完整
// 名字集合。多个测试都要断言"全部种进去了"或"名字集合不多不少",抽成常量
// 避免 12 个字符串字面量在文件里重复漂移。
const ALL_STRATEGY_NAMES = [
  "保守",
  "激进",
  "精英共识",
  "重仓共识",
  "首发共识",
  "巨鲸",
  "超级巨鲸",
  "巨鲸精英",
  "一边倒分歧",
  "分歧解除",
  "高分独狼",
  "早期赢家跟投",
];

// 新增 10 档各自的 source —— Task 12 测试要求「每条新种子的 source 都在
// FOLLOW_SOURCE_KINDS 里」要用到,与 db.ts 里的种子定义一一对应。
const NEW_STRATEGY_SOURCES: [string, string][] = [
  ["精英共识", "consensus"],
  ["重仓共识", "consensus"],
  ["首发共识", "consensus"],
  ["巨鲸", "heavy"],
  ["超级巨鲸", "heavy"],
  ["巨鲸精英", "heavy"],
  ["一边倒分歧", "lopsided"],
  ["分歧解除", "resolved"],
  ["高分独狼", "lone_wolf"],
  ["早期赢家跟投", "early_winner"],
];

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
  it("creates follow_strategies + follow_positions, seeds twelve strategies (v2), enforces the position UNIQUE key", () => {
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

    // Task 12(v2):全新库一次性种进全部 12 条(既有「保守」「激进」+ 新增
    // 10 档),不是曾经的 2 条。两侧各自 sort() 后比较,不依赖 SQLite 对
    // 中文字符串的排序规则与 JS 一致。
    const strats = (
      db.prepare("SELECT name FROM follow_strategies").all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .sort();
    expect(strats).toEqual([...ALL_STRATEGY_NAMES].sort());

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

  it("seeds all twelve strategies exactly once via the follow_seed_v marker (reopen must not re-seed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "whaledb-"));
    const path = join(dir, "t.sqlite");
    const names = (db: ReturnType<typeof openDb>) =>
      (
        db.prepare("SELECT name FROM follow_strategies").all() as {
          name: string;
        }[]
      )
        .map((r) => r.name)
        .sort();
    const marker = (db: ReturnType<typeof openDb>) =>
      (
        db
          .prepare("SELECT value FROM config WHERE key = 'follow_seed_v'")
          .get() as { value: string } | undefined
      )?.value;
    try {
      // First open: marker missing → seed runs and writes follow_seed_v = "2"
      // (Task 12 起,全新库一次种进全部 12 条,不再是 v1 时代的 2 条)。
      const db1 = openDb(path);
      expect(names(db1)).toEqual([...ALL_STRATEGY_NAMES].sort());
      expect(marker(db1)).toBe("2");
      db1.close();

      // Plain reopen of the SAME file: marker present, so the count stays
      // exactly 12 — the in-memory case can never exercise a reopen.
      const db2 = openDb(path);
      expect(names(db2)).toEqual([...ALL_STRATEGY_NAMES].sort());
      expect(marker(db2)).toBe("2");
      // Delete one seeded strategy while the marker stays "2". A gated openDb
      // must SKIP the seed block on the next open, so the deleted row must NOT
      // come back. This is the real regression catcher: with the version gate
      // removed, the seed block would re-run and INSERT OR IGNORE would silently
      // resurrect "保守" (name UNIQUE hides duplicates but not a missing row),
      // so a count-only assertion would pass even without the gate.
      db2.prepare("DELETE FROM follow_strategies WHERE name = '保守'").run();
      db2.close();

      const db3 = openDb(path);
      expect(names(db3)).toEqual(
        [...ALL_STRATEGY_NAMES].filter((n) => n !== "保守").sort(),
      );
      expect(marker(db3)).toBe("2");
      db3.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Task 12: follow_strategies seed v2 —— 新增 10 档(A3-A5/B1-B3/C1-C2/D1-D2)。
// 五点必测(设计文档 §Task 12「测试必须断言」+ 实施时补的三点防死档校验):
//   1. 全新库一次性种进全部 12 条,名字集合完全匹配预期
//   2. 既有 v1 库升级 → 12 条,且「保守」「激进」的 params_json 逐字节未变
//   3. 幂等:连续两次 openDb 同一文件,策略数仍是 12
//   4. 每条新种子都能被 parseStrategy 成功解析(不返回 null)—— 防死档
//   5. 每条新种子的 source 都在 FOLLOW_SOURCE_KINDS 里
// ---------------------------------------------------------------------------
describe("follow_strategies seed v2(Task 12:新增 10 档)", () => {
  it("全新库:一次性种进全部 12 条,名字集合完全匹配预期", () => {
    const db = openDb(":memory:");
    const names = (
      db.prepare("SELECT name FROM follow_strategies").all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .sort();
    expect(names).toEqual([...ALL_STRATEGY_NAMES].sort());
    const marker = (
      db
        .prepare("SELECT value FROM config WHERE key = 'follow_seed_v'")
        .get() as { value: string } | undefined
    )?.value;
    expect(marker).toBe("2");
    db.close();
  });

  it("既有 v1 库升级:结果 12 条,且「保守」「激进」的 params_json 逐字节未变", () => {
    const dir = mkdtempSync(join(tmpdir(), "whaledb-"));
    const path = join(dir, "v1.sqlite");
    try {
      // 手工搭一个"已经跑过 v1 迁移、还没跑过 v2 迁移"的库形状 —— 与 v1
      // 时代 db.ts 种子逻辑产出的内容逐字节一致(两条策略 + marker='1')。
      // 不复用当前的 openDb(它现在直接种 v2/12 条,已经没有"只种 2 条就
      // 停在 v1"这条路径了),改为自己起一个裸连接手工建表 + 插入,精确
      // 复刻红线场景:生产库里已经跑了几周、积累了历史仓位与战绩的那两条
      // 策略。两条 CREATE TABLE 分开 prepare().run()(而非一次 exec 多语句)
      // 是 better-sqlite3 的 API 限制:prepare() 只接受单条语句。
      const raw = new Database(path);
      raw
        .prepare("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)")
        .run();
      raw
        .prepare(
          "CREATE TABLE follow_strategies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, enabled INTEGER DEFAULT 1, params_json TEXT, created_at INTEGER)",
        )
        .run();
      // 与 lib/db.ts 里 v2 块顶部「保守/激进」两条 ins.run(...) 的
      // JSON.stringify 输出逐字节相同(字段顺序、值都一致)—— 这是"既有
      // 生产库"的真实形状。
      const conservativeParams = JSON.stringify({
        minWallets: 3,
        minPerWalletUsd: 10000,
        sizeUsd: 500,
        exitRule: "settlement",
        maxEntryDeviationCents: 10,
      });
      const aggressiveParams = JSON.stringify({
        minWallets: 2,
        minPerWalletUsd: 5000,
        sizeUsd: 500,
        exitRule: "settlement",
        maxEntryDeviationCents: 10,
      });
      const rawIns = raw.prepare(
        "INSERT INTO follow_strategies (name, enabled, params_json, created_at) VALUES (?,1,?,?)",
      );
      rawIns.run("保守", conservativeParams, 1000);
      rawIns.run("激进", aggressiveParams, 1000);
      raw
        .prepare(
          "INSERT INTO config (key, value) VALUES ('follow_seed_v', '1')",
        )
        .run();
      raw.close();

      // 真实升级路径:用生产代码的 openDb 打开这个"v1 库",触发 v2 迁移。
      const db = openDb(path);

      const rows = db
        .prepare("SELECT name, params_json FROM follow_strategies")
        .all() as { name: string; params_json: string }[];
      expect(rows.length).toBe(12);
      expect(rows.map((r) => r.name).sort()).toEqual(
        [...ALL_STRATEGY_NAMES].sort(),
      );

      // 逐字节字符串比较,不是 JSON.parse 后比对象 —— 后者会把字段顺序/
      // 格式被意外改写的回归判等,前者才能抓出来。这是红线的直接断言:
      // v2 迁移绝不 UPDATE 既有两条的任何字段。
      const byName = new Map(rows.map((r) => [r.name, r.params_json]));
      expect(byName.get("保守")).toBe(conservativeParams);
      expect(byName.get("激进")).toBe(aggressiveParams);

      const marker = (
        db
          .prepare("SELECT value FROM config WHERE key = 'follow_seed_v'")
          .get() as { value: string } | undefined
      )?.value;
      expect(marker).toBe("2");

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("幂等:连续两次 openDb 打开同一文件,策略数仍是 12(不重复插入)", () => {
    const dir = mkdtempSync(join(tmpdir(), "whaledb-"));
    const path = join(dir, "idempotent.sqlite");
    const count = (db: ReturnType<typeof openDb>) =>
      (
        db.prepare("SELECT COUNT(*) AS n FROM follow_strategies").get() as {
          n: number;
        }
      ).n;
    try {
      const db1 = openDb(path);
      expect(count(db1)).toBe(12);
      db1.close();

      const db2 = openDb(path);
      expect(count(db2)).toBe(12);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 防死档的关键校验:parseStrategy 是整个 12 档扩充的守门员(见 lib/follow.ts
  // parseStrategy 函数头注释)。种子的 params_json 若配错必需字段,轻则
  // parseStrategy 直接返回 null(策略被整条跳过),重则解析"成功"但对应
  // detector 因为读不到自己的必需参数而恒产出空候选 —— 两种情况上线后都是
  // 永远开不出仓的死档,区别只是日志里报错的位置。这里用真实建库(:memory:)
  // 里的 params_json,而不是重新手写一份字面量 —— 断言的是"db.ts 里实际种
  // 下去的那一行",不是"我以为它长什么样"。
  it.each(NEW_STRATEGY_SOURCES)(
    "新种子「%s」的 params_json 能被 parseStrategy 成功解析,source=%s 且在 FOLLOW_SOURCE_KINDS 里",
    (name, expectedSource) => {
      const db = openDb(":memory:");
      const row = db
        .prepare("SELECT id, params_json FROM follow_strategies WHERE name = ?")
        .get(name) as { id: number; params_json: string } | undefined;
      expect(row, `种子「${name}」未被种入 follow_strategies`).toBeDefined();

      const parsed = parseStrategyForTest(row!.id, row!.params_json);
      expect(parsed).not.toBeNull();
      expect(parsed!.source).toBe(expectedSource);
      expect(isFollowSourceKind(parsed!.source)).toBe(true);
      expect(FOLLOW_SOURCE_KINDS).toContain(parsed!.source);
      db.close();
    },
  );

  // Task 13 复审 Minor:「一边倒分歧」(C1)种子里的 minPerSideUsd/minTiltPct、
  // 「分歧解除」(C2)种子里的 minPerSideUsd,数值上都抄自 DEFAULT_DISAGREEMENT
  // (lib/disagreement.ts),此前全靠人工保持同步——DEFAULT_DISAGREEMENT 改了
  // 而种子没跟着改,不会有任何测试失败,只会在两档的实际行为里悄悄跑偏。这条
  // 测试把"人工保持同步"变成"测试保持同步"。
  //
  // ⚠️ 但两个字段与 DEFAULT_DISAGREEMENT 同步的"重要性"完全不同,断言之前必须
  // 讲清楚(详见 lib/db.ts 种子定义处 C1/C2 两条注释、lib/sourceLopsided.ts /
  // lib/sourceResolved.ts 的函数头注释):
  //   - minPerSideUsd 对 C1、C2 都是纯文档字段——detectLopsidedCandidates 与
  //     detectResolvedCandidates 都不读 params.minPerSideUsd,它们消费的是
  //     runFollowCycle 每轮用固定 DEFAULT_DISAGREEMENT 算好、经 ctx.contested/
  //     ctx.prevTilt 传入的现成结果。就算这里的字面量与 DEFAULT_DISAGREEMENT
  //     分叉,C1/C2 的实际开仓行为也不会有任何变化——它纯粹是给人看的口径
  //     说明,写错了只是"文档说谎",不是"行为出错"。
  //   - minTiltPct 对 C1 是真会被读的实际开关:detectLopsidedCandidates 用
  //     `params.minTiltPct ?? DEFAULT_DISAGREEMENT.lopsidedTiltPct`——种子里
  //     配的 0.7 恰好与默认值相等,所以此刻不触发任何行为差异,但两者一旦
  //     分叉,C1 会真的换一个不同的"一边倒"判定阈值去跑(且低于 0.7 时会
  //     静默失效,见设计文档「已知设计边界」一节)。
  // 换言之:C2 的这条断言纯粹是防止文档注释与实际种子值失配;C1 的
  // minTiltPct 断言则是在保护一个真实生效的行为参数。
  it("C1/C2 种子里的 minPerSideUsd/minTiltPct 字面量与 DEFAULT_DISAGREEMENT 同步", () => {
    const db = openDb(":memory:");
    const paramsOf = (name: string): Record<string, unknown> => {
      const row = db
        .prepare("SELECT params_json FROM follow_strategies WHERE name = ?")
        .get(name) as { params_json: string } | undefined;
      expect(row, `种子「${name}」未被种入 follow_strategies`).toBeDefined();
      return JSON.parse(row!.params_json) as Record<string, unknown>;
    };

    const c1 = paramsOf("一边倒分歧");
    expect(c1.minPerSideUsd).toBe(DEFAULT_DISAGREEMENT.minPerSideUsd);
    expect(c1.minTiltPct).toBe(DEFAULT_DISAGREEMENT.lopsidedTiltPct);

    const c2 = paramsOf("分歧解除");
    expect(c2.minPerSideUsd).toBe(DEFAULT_DISAGREEMENT.minPerSideUsd);

    db.close();
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
