import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "./db";
import {
  backfillSignalSettlement,
  recordStrategySignal,
  strategyRecord30d,
  type StrategySignalInput,
} from "./strategySignals";
import { runFollowCycle } from "./follow";
import type { SmartTag } from "./smartWallets";
import type { Trade } from "./types";

// 对外信号批次 0:strategy_signals 事实台账。
// 台账语义:「某档策略在某市场某方向触发过买入」是一条不可变事件 ——
// UNIQUE(strategy_id, condition_id, outcome) 与 follow_positions 同粒度,
// INSERT OR IGNORE 幂等;结算回填只补列,绝不改写身份字段。

const input = (o: Partial<StrategySignalInput> = {}): StrategySignalInput => ({
  strategyId: 1,
  positionId: 42,
  conditionId: "c1",
  outcome: "Yes",
  outcomeIndex: 0,
  asset: "tok1",
  title: "T",
  slug: "s",
  eventSlug: "e",
  formationTs: 1000,
  referencePrice: 0.6,
  walletCount: 2,
  totalNetUsd: 12000,
  entryPrice: 0.63,
  sizeUsd: 500,
  emittedAt: 1800,
  ...o,
});

describe("strategy_signals 表与 push_enabled 列", () => {
  it("新库自带 strategy_signals 全列与 follow_strategies.push_enabled(默认 0)", () => {
    const db = openDb(":memory:");
    const cols = (
      db.prepare("PRAGMA table_info(strategy_signals)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    for (const c of [
      "id",
      "strategy_id",
      "position_id",
      "condition_id",
      "outcome",
      "outcome_index",
      "asset",
      "title",
      "slug",
      "event_slug",
      "formation_ts",
      "reference_price",
      "wallet_count",
      "total_net_usd",
      "entry_price",
      "size_usd",
      "emitted_at",
      "settled",
      "settled_ts",
      "exit_price",
      "won",
      "realized_pnl",
    ]) {
      expect(cols, `缺列 ${c}`).toContain(c);
    }
    const pushEnabled = (
      db.prepare("PRAGMA table_info(follow_strategies)").all() as {
        name: string;
        dflt_value: string | null;
      }[]
    ).find((c) => c.name === "push_enabled");
    expect(pushEnabled).toBeTruthy();
    // 种子策略默认不推送 —— 放开哪几档是运营决策,不是部署副作用。
    const seeded = db
      .prepare(
        "SELECT COUNT(*) AS n FROM follow_strategies WHERE push_enabled = 0",
      )
      .get() as { n: number };
    const total = db
      .prepare("SELECT COUNT(*) AS n FROM follow_strategies")
      .get() as { n: number };
    expect(seeded.n).toBe(total.n);
    db.close();
  });

  it("老库(建表时无 push_enabled)经 openDb 后由 ALTER 补齐", () => {
    // :memory: 新库永远走 CREATE TABLE,测不到 ALTER 路径(follow.db.test.ts
    // 记录过同一陷阱)—— 用文件库先造旧形状再 openDb。
    const dir = mkdtempSync(join(tmpdir(), "sigdb-"));
    const path = join(dir, "legacy.sqlite");
    const legacy = new Database(path);
    legacy.exec(
      "CREATE TABLE follow_strategies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, enabled INTEGER DEFAULT 1, params_json TEXT, created_at INTEGER)",
    );
    legacy.close();
    const db = openDb(path);
    const cols = (
      db.prepare("PRAGMA table_info(follow_strategies)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols).toContain("push_enabled");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("recordStrategySignal 写入与幂等", () => {
  it("全字段落库并返回 id;同 (策略,市场,方向) 第二次返回 null 且不覆盖", () => {
    const db = openDb(":memory:");
    const id = recordStrategySignal(db, input());
    expect(id).toBeTypeOf("number");
    // 第二次:UNIQUE 命中,不覆盖已有行(entry_price 保持第一次的值)。
    const dup = recordStrategySignal(db, input({ entryPrice: 0.99 }));
    expect(dup).toBeNull();
    const row = db
      .prepare("SELECT * FROM strategy_signals WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row.strategy_id).toBe(1);
    expect(row.position_id).toBe(42);
    expect(row.condition_id).toBe("c1");
    expect(row.outcome).toBe("Yes");
    expect(row.asset).toBe("tok1");
    expect(row.slug).toBe("s");
    expect(row.event_slug).toBe("e");
    expect(row.formation_ts).toBe(1000);
    expect(row.reference_price).toBe(0.6);
    expect(row.wallet_count).toBe(2);
    expect(row.total_net_usd).toBe(12000);
    expect(row.entry_price).toBe(0.63);
    expect(row.size_usd).toBe(500);
    expect(row.emitted_at).toBe(1800);
    expect(row.settled).toBe(0);
    expect(row.won).toBeNull();
    db.close();
  });

  it("不同策略跟同一市场方向各落一行(跨档重叠是期望行为)", () => {
    const db = openDb(":memory:");
    expect(recordStrategySignal(db, input({ strategyId: 1 }))).not.toBeNull();
    expect(recordStrategySignal(db, input({ strategyId: 2 }))).not.toBeNull();
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM strategy_signals").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(2);
    db.close();
  });
});

describe("backfillSignalSettlement 结算回填", () => {
  it("按 position_id 定位;pnl>0→won=1、<0→0、=0→null(push 纪律)", () => {
    const db = openDb(":memory:");
    recordStrategySignal(db, input({ positionId: 7, strategyId: 1 }));
    recordStrategySignal(
      db,
      input({ positionId: 8, strategyId: 2, conditionId: "c2" }),
    );
    recordStrategySignal(
      db,
      input({ positionId: 9, strategyId: 3, conditionId: "c3" }),
    );
    expect(
      backfillSignalSettlement(db, 7, {
        settledTs: 2000,
        exitPrice: 1,
        realizedPnl: 293.7,
      }),
    ).toBe(true);
    expect(
      backfillSignalSettlement(db, 8, {
        settledTs: 2000,
        exitPrice: 0,
        realizedPnl: -500,
      }),
    ).toBe(true);
    expect(
      backfillSignalSettlement(db, 9, {
        settledTs: 2000,
        exitPrice: 0.63,
        realizedPnl: 0,
      }),
    ).toBe(true);
    const won = (pid: number) =>
      (
        db
          .prepare(
            "SELECT settled, won, exit_price FROM strategy_signals WHERE position_id = ?",
          )
          .get(pid) as { settled: number; won: number | null }
      ).won;
    expect(won(7)).toBe(1);
    expect(won(8)).toBe(0);
    expect(won(9)).toBeNull();
    db.close();
  });

  it("未知 position_id 是 no-op(老仓无台账行,结算主流程不受影响)", () => {
    const db = openDb(":memory:");
    expect(
      backfillSignalSettlement(db, 999, {
        settledTs: 2000,
        exitPrice: 1,
        realizedPnl: 1,
      }),
    ).toBe(false);
    db.close();
  });

  it("已结算行不被二次回填覆盖(settled=0 守卫)", () => {
    const db = openDb(":memory:");
    recordStrategySignal(db, input({ positionId: 7 }));
    backfillSignalSettlement(db, 7, {
      settledTs: 2000,
      exitPrice: 1,
      realizedPnl: 100,
    });
    expect(
      backfillSignalSettlement(db, 7, {
        settledTs: 3000,
        exitPrice: 0,
        realizedPnl: -1,
      }),
    ).toBe(false);
    const row = db
      .prepare(
        "SELECT settled_ts, won FROM strategy_signals WHERE position_id=7",
      )
      .get() as { settled_ts: number; won: number };
    expect(row.settled_ts).toBe(2000);
    expect(row.won).toBe(1);
    db.close();
  });
});

describe("strategyRecord30d — 档位 30d 价格调整战绩(gradeRows 同源)", () => {
  const insertPos = (
    db: ReturnType<typeof openDb>,
    o: {
      strategyId: number;
      cid: string;
      entryTs: number;
      entryPrice: number;
      pnl: number | null;
      status?: string;
    },
  ) => {
    db.prepare(
      `INSERT INTO follow_positions (strategy_id, condition_id, outcome, asset, outcome_index, title, event_slug, entry_ts, entry_price, smart_avg_price, size_usd, shares, status, realized_pnl)
       VALUES (?, ?, 'Yes', 'tok', 0, 'T', 'e', ?, ?, 0.6, 500, 100, ?, ?)`,
    ).run(
      o.strategyId,
      o.cid,
      o.entryTs,
      o.entryPrice,
      o.status ?? "settled",
      o.pnl,
    );
  };

  it("赢/输计入、push(pnl=0) 与持有中排除、窗口按 entry_ts、implied=入场价(BUY)", () => {
    const db = openDb(":memory:");
    const now = 100 * 86400;
    insertPos(db, {
      strategyId: 1,
      cid: "a",
      entryTs: now - 86400,
      entryPrice: 0.6,
      pnl: 100,
    });
    insertPos(db, {
      strategyId: 1,
      cid: "b",
      entryTs: now - 86400,
      entryPrice: 0.8,
      pnl: -500,
    });
    // push:平局不进分母。
    insertPos(db, {
      strategyId: 1,
      cid: "c",
      entryTs: now - 86400,
      entryPrice: 0.5,
      pnl: 0,
    });
    // 持有中:无判定。
    insertPos(db, {
      strategyId: 1,
      cid: "d",
      entryTs: now - 86400,
      entryPrice: 0.5,
      pnl: null,
      status: "open",
    });
    // 窗口外(31 天前触发)。
    insertPos(db, {
      strategyId: 1,
      cid: "e",
      entryTs: now - 31 * 86400,
      entryPrice: 0.5,
      pnl: 100,
    });
    // 别的策略。
    insertPos(db, {
      strategyId: 2,
      cid: "f",
      entryTs: now - 86400,
      entryPrice: 0.5,
      pnl: 100,
    });
    const r = strategyRecord30d(db, 1, now);
    expect(r.settled).toBe(2);
    expect(r.wins).toBe(1);
    // implied = 0.6 + 0.8(BUY 直接取入场价)。
    expect(r.implied).toBeCloseTo(1.4, 6);
    expect(r.excess).toBeCloseTo(1 - 1.4, 6);
    db.close();
  });

  it("零样本 → 全零记录(调用方据此省略战绩行)", () => {
    const db = openDb(":memory:");
    const r = strategyRecord30d(db, 1, 1000);
    expect(r.settled).toBe(0);
    expect(r.sd).toBe(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// runFollowCycle 接线:开仓成功 → 台账落行;结算 → 回填。台账是下游功能,
// 任何台账故障不得影响开仓/结算主流程(接线处 try/catch,此处不模拟故障,
// 由「未知 position no-op」用例覆盖容错半径)。
// ---------------------------------------------------------------------------

const smart = (): Map<string, SmartTag> =>
  new Map([
    ["w1", { score: 80, winRate: 0.7, netPnl: 1, isWhitelist: true }],
    ["w2", { score: 75, winRate: 0.65, netPnl: 1, isWhitelist: true }],
  ]);

const trade = (o: Partial<Trade>): Trade => ({
  proxyWallet: "w1",
  side: "BUY",
  asset: "tok",
  conditionId: "c1",
  size: 100,
  price: 0.6,
  timestamp: 1000,
  title: "T",
  slug: "s",
  eventSlug: "e",
  outcome: "Yes",
  outcomeIndex: 0,
  transactionHash: "h1",
  ...o,
});

describe("runFollowCycle × strategy_signals 接线", () => {
  const openTrades = [
    trade({
      proxyWallet: "w1",
      transactionHash: "h1",
      size: 10000,
      price: 0.6,
    }),
    trade({
      proxyWallet: "w2",
      transactionHash: "h2",
      size: 10000,
      price: 0.6,
    }),
  ];

  it("开仓成功即落台账行:position_id 因果链 + emitted_at=本轮 nowSec + entry 为现价", async () => {
    const db = openDb(":memory:");
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: openTrades }),
      getSmart: smart,
      fetchPrice: async () => 0.63,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(r.opened).toBeGreaterThanOrEqual(1);
    const rows = db
      .prepare(
        `SELECT s.strategy_id, s.position_id, s.entry_price, s.emitted_at, s.size_usd,
                p.id AS pid, p.strategy_id AS p_sid
         FROM strategy_signals s JOIN follow_positions p ON p.id = s.position_id`,
      )
      .all() as {
      strategy_id: number;
      position_id: number;
      entry_price: number;
      emitted_at: number;
      size_usd: number;
      pid: number;
      p_sid: number;
    }[];
    // 每个开出的仓恰好一条台账行,且 join 得回同一策略。
    expect(rows.length).toBe(r.opened);
    for (const row of rows) {
      expect(row.strategy_id).toBe(row.p_sid);
      expect(row.entry_price).toBe(0.63);
      expect(row.emitted_at).toBe(1800);
      expect(row.size_usd).toBe(500);
    }
    db.close();
  });

  it("重复轮次不产生重复台账行(与仓位查重同粒度)", async () => {
    const db = openDb(":memory:");
    const deps = {
      db,
      fetchWindow: async () => ({ trades: openTrades }),
      getSmart: smart,
      fetchPrice: async () => 0.63,
      getMeta: async () => ({}),
      nowSec: 1800,
    };
    await runFollowCycle(deps);
    const n1 = (
      db.prepare("SELECT COUNT(*) AS n FROM strategy_signals").get() as {
        n: number;
      }
    ).n;
    expect(n1).toBeGreaterThanOrEqual(1);
    await runFollowCycle(deps);
    const n2 = (
      db.prepare("SELECT COUNT(*) AS n FROM strategy_signals").get() as {
        n: number;
      }
    ).n;
    expect(n2).toBe(n1);
    db.close();
  });

  it("结算联动:市场 closed 后台账行回填 settled/exit/won/realized_pnl", async () => {
    const db = openDb(":memory:");
    await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: openTrades }),
      getSmart: smart,
      fetchPrice: async () => 0.63,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    // 第二轮:空窗口,市场已结算 Yes=1。
    await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: [] }),
      getSmart: smart,
      fetchPrice: async () => 0.63,
      getMeta: async () => ({
        c1: {
          conditionId: "c1",
          closed: true,
          outcomePrices: [1, 0],
          outcomes: ["Yes", "No"],
          volume24hr: null,
          liquidity: null,
          endDate: null,
          category: null,
          feesEnabled: false,
          feeType: null,
          feeSchedule: null,
          umaDisputed: false,
        },
      }),
      nowSec: 3600,
    });
    const sig = db
      .prepare(
        "SELECT settled, settled_ts, exit_price, won, realized_pnl FROM strategy_signals LIMIT 1",
      )
      .get() as {
      settled: number;
      settled_ts: number;
      exit_price: number;
      won: number;
      realized_pnl: number;
    };
    expect(sig.settled).toBe(1);
    expect(sig.settled_ts).toBe(3600);
    expect(sig.exit_price).toBe(1);
    expect(sig.won).toBe(1);
    expect(sig.realized_pnl).toBeGreaterThan(0);
    db.close();
  });
});
