import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb, type DB } from "./db";
import {
  backfillSignalSettlement,
  countStraySettlements,
  reconcileSignalSettlements,
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

describe("reconcileSignalSettlements 结算对账(回填漏网兜底)", () => {
  // 复现的库形状:结算段 UPDATE follow_positions 成功,紧随其后的
  // backfillSignalSettlement 抛错(SQLITE_BUSY/磁盘)被 try/catch 吞掉 ——
  // 仓位已 settled、台账行仍 settled=0。下一轮结算集只取 open 仓,这个仓
  // 不会再被处理;没有对账,这行就永久卡死。
  const settledPosition = (
    db: DB,
    o: {
      cid: string;
      exitTs: number | null;
      exitPrice: number | null;
      pnl: number | null;
    },
  ): number =>
    Number(
      db
        .prepare(
          `INSERT INTO follow_positions
             (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,
              size_usd,shares,status,exit_ts,exit_price,realized_pnl)
           VALUES (1,?,'Yes','tok',0,0.63,500,793.65,'settled',?,?,?)`,
        )
        .run(o.cid, o.exitTs, o.exitPrice, o.pnl).lastInsertRowid,
    );
  type LedgerResult = {
    settled: number;
    settled_ts: number | null;
    exit_price: number | null;
    won: number | null;
    realized_pnl: number | null;
  };
  const ledger = (db: DB, pid: number): LedgerResult =>
    db
      .prepare(
        "SELECT settled, settled_ts, exit_price, won, realized_pnl FROM strategy_signals WHERE position_id = ?",
      )
      .get(pid) as LedgerResult;

  it("仓位 settled、台账 settled=0 → 补齐且与仓位一致;open 仓与已结算行不动;再跑一次 0 行(幂等)", () => {
    const db = openDb(":memory:");
    // 漏网行:仓位 exit_ts=9000 / exit=1 / pnl=+293.65,台账没回填。
    const stray = settledPosition(db, {
      cid: "c1",
      exitTs: 9000,
      exitPrice: 1,
      pnl: 293.65,
    });
    recordStrategySignal(db, input({ positionId: stray, conditionId: "c1" }));
    // 对照 1:仍 open 的仓 —— 台账理应保持 settled=0。
    const open = Number(
      db
        .prepare(
          "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status) VALUES (1,'c2','Yes','tok2',0,0.5,500,1000,'open')",
        )
        .run().lastInsertRowid,
    );
    recordStrategySignal(db, input({ positionId: open, conditionId: "c2" }));
    // 对照 2:正常路径已回填的行(settled_ts=5000 与仓位 exit_ts=5500 故意
    // 不同)—— 结算是一次性事实,对账不得用仓位值改写它。
    const done = settledPosition(db, {
      cid: "c3",
      exitTs: 5500,
      exitPrice: 0,
      pnl: -500,
    });
    recordStrategySignal(db, input({ positionId: done, conditionId: "c3" }));
    backfillSignalSettlement(db, done, {
      settledTs: 5000,
      exitPrice: 0,
      realizedPnl: -500,
    });

    expect(reconcileSignalSettlements(db)).toBe(1);

    // settled_ts 是仓位的 exit_ts(真实结算时刻),不是对账时刻:下游 7d 陈旧闸 /
    // 48h 窗口据此决定还发不发,迟到的兑现不能伪装成新鲜的。
    expect(ledger(db, stray)).toEqual({
      settled: 1,
      settled_ts: 9000,
      exit_price: 1,
      won: 1,
      realized_pnl: 293.65,
    });
    expect(ledger(db, open).settled).toBe(0);
    expect(ledger(db, done).settled_ts).toBe(5000);

    // 幂等:第二次无事可做,已补齐的行也不再被触碰。
    expect(reconcileSignalSettlements(db)).toBe(0);
    expect(ledger(db, stray).settled_ts).toBe(9000);
    db.close();
  });

  it("won 三态走 backfillSignalSettlement 同一条路:pnl<0→0、pnl=0→null", () => {
    const db = openDb(":memory:");
    const lost = settledPosition(db, {
      cid: "c1",
      exitTs: 9000,
      exitPrice: 0,
      pnl: -500,
    });
    const push = settledPosition(db, {
      cid: "c2",
      exitTs: 9000,
      exitPrice: 0.63,
      pnl: 0,
    });
    recordStrategySignal(db, input({ positionId: lost, conditionId: "c1" }));
    recordStrategySignal(db, input({ positionId: push, conditionId: "c2" }));

    expect(reconcileSignalSettlements(db)).toBe(2);

    expect(ledger(db, lost)).toEqual({
      settled: 1,
      settled_ts: 9000,
      exit_price: 0,
      won: 0,
      realized_pnl: -500,
    });
    expect(ledger(db, push)).toEqual({
      settled: 1,
      settled_ts: 9000,
      exit_price: 0.63,
      won: null,
      realized_pnl: 0,
    });
    db.close();
  });

  it("结果列任一为 NULL(exit_ts/exit_price/realized_pnl)的自相矛盾行:跳过不计数、台账保持 settled=0;N 行合并成一条 warn 且逐行带 signal/position id", () => {
    const db = openDb(":memory:");
    // 先垫一条无台账的仓位,让 position id 与 signal id 错开 —— 否则两个序列
    // 都从 1 起,「signal 1」「position 1」互换也能通过断言,守不住日志契约。
    settledPosition(db, { cid: "c0", exitTs: 1, exitPrice: 1, pnl: 1 });
    const noPrice = settledPosition(db, {
      cid: "c1",
      exitTs: 9000,
      exitPrice: null,
      pnl: null,
    });
    const noTs = settledPosition(db, {
      cid: "c2",
      exitTs: null,
      exitPrice: 1,
      pnl: 293.65,
    });
    const sidNoPrice = recordStrategySignal(
      db,
      input({ positionId: noPrice, conditionId: "c1" }),
    );
    const sidNoTs = recordStrategySignal(
      db,
      input({ positionId: noTs, conditionId: "c2" }),
    );
    expect(sidNoPrice).not.toBe(noPrice);
    expect(sidNoTs).not.toBe(noTs);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(reconcileSignalSettlements(db)).toBe(0);
      expect(ledger(db, noPrice).settled).toBe(0);
      // exit_ts 缺失也不编造时间戳:编出来的 settled_ts 会让一条来路不明的兑现
      // 同时穿过 7d 陈旧闸与 48h 窗口,以「刚刚认账」的姿态推给下游。
      expect(ledger(db, noTs).settled).toBe(0);
      // 排查线索:坏行不会自愈,逐行逐轮喊会淹掉日志 —— 每轮一条汇总 warn,
      // 逐行带 signal id 与 position id(成对出现,互换即不匹配)。
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0][0]);
      expect(msg).toContain("[follow]");
      expect(msg).toContain(`signal ${sidNoPrice} / position ${noPrice}`);
      expect(msg).toContain(`signal ${sidNoTs} / position ${noTs}`);
    } finally {
      warn.mockRestore();
      db.close();
    }
  });

  it("单行写入抛错只 warn(带两个 id)并继续同批其它行;故障消失后下一轮补齐", () => {
    const db = openDb(":memory:");
    settledPosition(db, { cid: "c0", exitTs: 1, exitPrice: 1, pnl: 1 }); // id 错开
    const cursed = settledPosition(db, {
      cid: "c1",
      exitTs: 9000,
      exitPrice: 1,
      pnl: 293.65,
    });
    const fine = settledPosition(db, {
      cid: "c2",
      exitTs: 9000,
      exitPrice: 0,
      pnl: -500,
    });
    const sidCursed = recordStrategySignal(
      db,
      input({ positionId: cursed, conditionId: "c1" }),
    );
    recordStrategySignal(db, input({ positionId: fine, conditionId: "c2" }));
    expect(sidCursed).not.toBe(cursed);
    // 真实故障注入(不 mock):触发器让「这一行」的 UPDATE 抛错,模拟单行 BUSY/IO。
    db.exec(
      `CREATE TRIGGER boom BEFORE UPDATE ON strategy_signals
         WHEN NEW.position_id = ${cursed}
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(reconcileSignalSettlements(db)).toBe(1);
      expect(ledger(db, fine).settled).toBe(1);
      expect(ledger(db, cursed).settled).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(
        `signal ${sidCursed} / position ${cursed}`,
      );
      // 故障消失 → 下一轮自愈。
      db.exec("DROP TRIGGER boom");
      expect(reconcileSignalSettlements(db)).toBe(1);
      expect(ledger(db, cursed).settled).toBe(1);
    } finally {
      warn.mockRestore();
      db.close();
    }
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
          clobTokenIds: ["t0", "t1"],
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

  it("回填漏网兜底:仓位已 settled 而台账 settled=0 → 下一轮对账补齐(不依赖 open 仓集合)", async () => {
    const db = openDb(":memory:");
    // 复现「结算 UPDATE 成功、backfillSignalSettlement 抛错被吞」之后的库形状:
    // 仓位 settled(exit_ts=3000),台账行还停在 settled=0。
    const pid = Number(
      db
        .prepare(
          `INSERT INTO follow_positions
             (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,
              size_usd,shares,status,exit_ts,exit_price,realized_pnl)
           VALUES (1,'c1','Yes','tok',0,0.63,500,793.65,'settled',3000,1,293.65)`,
        )
        .run().lastInsertRowid,
    );
    recordStrategySignal(db, input({ positionId: pid }));
    // 空窗口、无 meta:没有 open 仓,结算段本身零工作 —— 对账仍须跑。
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: [] }),
      getSmart: smart,
      fetchPrice: async () => null,
      getMeta: async () => ({}),
      nowSec: 3600,
    });
    expect(r.settled).toBe(0);
    const sig = db
      .prepare(
        "SELECT settled, settled_ts, exit_price, won, realized_pnl FROM strategy_signals WHERE position_id = ?",
      )
      .get(pid);
    expect(sig).toEqual({
      settled: 1,
      settled_ts: 3000,
      exit_price: 1,
      won: 1,
      realized_pnl: 293.65,
    });
    db.close();
  });

  it("台账整表故障:同一轮里结算回填与对账双双抛错,都只 warn,纸面结算照常完成", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status) VALUES (1,'c1','Yes','tok',0,0.5,500,1000,'open')",
    ).run();
    // 删表 = 结算段的 backfillSignalSettlement 与末尾的对账在同一轮里都会抛。
    db.exec("DROP TABLE strategy_signals");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await runFollowCycle({
        db,
        fetchWindow: async () => ({ trades: [] }),
        getSmart: smart,
        fetchPrice: async () => null,
        getMeta: async () => ({
          c1: {
            conditionId: "c1",
            closed: true,
            outcomePrices: [1, 0],
            outcomes: ["Yes", "No"],
            clobTokenIds: ["tok", "tok-no"],
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
      // 纸面结算是主流程:两处台账故障都杀不死它。对账本身抛错 → 补齐计数
      // 保持 0(不编造数字),故障由 warn 日志承担。
      expect(r).toEqual({ opened: 0, settled: 1, sigReconciled: 0 });
      const pos = db
        .prepare(
          "SELECT status, realized_pnl FROM follow_positions WHERE condition_id='c1'",
        )
        .get() as { status: string; realized_pnl: number };
      expect(pos.status).toBe("settled");
      expect(pos.realized_pnl).toBeCloseTo(500);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[follow] strategy_signals 结算回填失败"),
        expect.anything(),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[follow] strategy_signals 结算对账失败"),
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
      db.close();
    }
  });
});

describe("wallets_json 向前落库(2026-08-28,walk-forward v2 前置)", () => {
  it("新库自带 wallets_json 列;老库经幂等 ALTER 补列", () => {
    const db = openDb(":memory:");
    const cols = (
      db.prepare("PRAGMA table_info(strategy_signals)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols).toContain("wallets_json");
  });

  it("带 wallets → 序列化落库,读回逐字段还原(含 score:null 的诚实态)", () => {
    const db = openDb(":memory:");
    const wallets = [
      { wallet: "0xaaa", netUsd: 8_000, score: 71.5 },
      { wallet: "0xbbb", netUsd: 4_000, score: null },
    ];
    const id = recordStrategySignal(db, input({ wallets }));
    expect(id).not.toBeNull();
    const row = db
      .prepare("SELECT wallets_json FROM strategy_signals WHERE id = ?")
      .get(id) as { wallets_json: string | null };
    expect(JSON.parse(row.wallets_json ?? "")).toEqual(wallets);
  });

  it("不带 wallets → NULL(老行/未接 detector 的自描述覆盖窗)", () => {
    const db = openDb(":memory:");
    const id = recordStrategySignal(db, input());
    const row = db
      .prepare("SELECT wallets_json FROM strategy_signals WHERE id = ?")
      .get(id) as { wallets_json: string | null };
    expect(row.wallets_json).toBeNull();
  });
});

describe("runFollowCycle × wallets_json 接线(向前落库)", () => {
  it("开仓落台账时带 wallets 快照:两钱包各 $6k、score 透传", async () => {
    const db = openDb(":memory:");
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({
        trades: [
          trade({ proxyWallet: "w1", transactionHash: "h1", size: 10_000, price: 0.6 }),
          trade({ proxyWallet: "w2", transactionHash: "h2", size: 10_000, price: 0.6 }),
        ],
      }),
      getSmart: smart,
      fetchPrice: async () => 0.63,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(r.opened).toBeGreaterThanOrEqual(1);
    const rows = db
      .prepare("SELECT wallets_json FROM strategy_signals")
      .all() as { wallets_json: string | null }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      const wallets = JSON.parse(row.wallets_json ?? "") as {
        wallet: string;
        netUsd: number;
        score: number | null;
      }[];
      expect(wallets.map((w) => w.wallet).sort()).toEqual(["w1", "w2"]);
      const byWallet = new Map(wallets.map((w) => [w.wallet, w]));
      expect(byWallet.get("w1")).toEqual({ wallet: "w1", netUsd: 6_000, score: 80 });
      expect(byWallet.get("w2")).toEqual({ wallet: "w2", netUsd: 6_000, score: 75 });
    }
  });
});

describe("countStraySettlements —— 运营页对账读数(与 reconcileSignalSettlements 同一 JOIN 谓词)", () => {
  // 对账补齐次数只活在 worker stdout 里;运营页要的是「当前仍漏网多少行」这个
  // 能直接查库得到的读数 —— 对账每轮兜底,正常恒为 0,持续 >0 = 回填路径在坏。
  const position = (db: DB, cid: string, status: "open" | "settled"): number =>
    Number(
      db
        .prepare(
          `INSERT INTO follow_positions
             (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,
              size_usd,shares,status,exit_ts,exit_price,realized_pnl)
           VALUES (1,?,'Yes','tok',0,0.63,500,793.65,?,?,?,?)`,
        )
        .run(
          cid,
          status,
          status === "settled" ? 9000 : null,
          status === "settled" ? 1 : null,
          status === "settled" ? 293.65 : null,
        ).lastInsertRowid,
    );

  it("空库 0;仓位 settled 而台账 settled=0 计 1;open 仓/已回填行/无因果链老行不计;对账补齐后归 0", () => {
    const db = openDb(":memory:");
    expect(countStraySettlements(db)).toBe(0);
    const stray = position(db, "c1", "settled");
    recordStrategySignal(db, input({ positionId: stray, conditionId: "c1" }));
    const open = position(db, "c2", "open");
    recordStrategySignal(db, input({ positionId: open, conditionId: "c2" }));
    const done = position(db, "c3", "settled");
    recordStrategySignal(db, input({ positionId: done, conditionId: "c3" }));
    backfillSignalSettlement(db, done, {
      settledTs: 9000,
      exitPrice: 1,
      realizedPnl: 293.65,
    });
    // 台账上线前的老行没有 position_id,无从判定 —— 不计。
    recordStrategySignal(db, input({ positionId: null, conditionId: "c4" }));
    expect(countStraySettlements(db)).toBe(1);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(reconcileSignalSettlements(db)).toBe(1);
    } finally {
      log.mockRestore();
    }
    expect(countStraySettlements(db)).toBe(0);
    db.close();
  });

  it("结果列含 NULL 的自相矛盾行:对账跳过不补,但读数照样计入 —— 它正是要人工核查的那种漏网", () => {
    const db = openDb(":memory:");
    const bad = Number(
      db
        .prepare(
          `INSERT INTO follow_positions
             (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,
              size_usd,shares,status,exit_ts,exit_price,realized_pnl)
           VALUES (1,'c1','Yes','tok',0,0.63,500,793.65,'settled',NULL,NULL,NULL)`,
        )
        .run().lastInsertRowid,
    );
    recordStrategySignal(db, input({ positionId: bad, conditionId: "c1" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(reconcileSignalSettlements(db)).toBe(0);
      expect(countStraySettlements(db)).toBe(1);
    } finally {
      warn.mockRestore();
      db.close();
    }
  });
});
