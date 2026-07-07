import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { runFollowCycle } from "./follow";
import type { SmartTag } from "./smartWallets";
import type { MarketMeta } from "./gamma";
import type { Trade } from "./types";

// 真实 SmartTag 桩(补全全字段,不用 any):两个白名单钱包。
const smart = (): Map<string, SmartTag> =>
  new Map([
    ["w1", { score: 80, winRate: 0.7, netPnl: 1, isWhitelist: true }],
    ["w2", { score: 75, winRate: 0.65, netPnl: 1, isWhitelist: true }],
  ]);

// 真实 Trade 桩工厂。
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

describe("runFollowCycle 开仓/结算/幂等", () => {
  it("2 钱包各净买 $6k 同向 → 现价开仓(激进策略,entry=现价非聪明钱均价)", async () => {
    const db = openDb(":memory:");
    const trades = [
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
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades }),
      getSmart: smart,
      fetchPrice: async () => 0.63,
      getMeta: async () => ({}),
      nowSec: 2000,
    });
    expect(r.opened).toBeGreaterThanOrEqual(1);
    const pos = db
      .prepare(
        "SELECT entry_price, smart_avg_price FROM follow_positions WHERE condition_id='c1'",
      )
      .get() as { entry_price: number; smart_avg_price: number };
    // entry=现价 0.63,而聪明钱均价=notionalUsd/size=6000/10000=0.6 —— 两者相区分,
    // 坐实"跟进成本按现价、非聪明钱均价"命题。
    expect(pos.entry_price).toBe(0.63);
    expect(pos.smart_avg_price).toBeCloseTo(0.6);
    db.close();
  });

  it("幂等:同组第二轮不重复开仓", async () => {
    const db = openDb(":memory:");
    const trades = [
      trade({ proxyWallet: "w1", transactionHash: "h1", size: 10000 }),
      trade({ proxyWallet: "w2", transactionHash: "h2", size: 10000 }),
    ];
    const deps = {
      db,
      fetchWindow: async () => ({ trades }),
      getSmart: smart,
      fetchPrice: async () => 0.63,
      getMeta: async () => ({}),
      nowSec: 2000,
    };
    const a = await runFollowCycle(deps);
    const b = await runFollowCycle(deps);
    expect(a.opened).toBeGreaterThanOrEqual(1);
    expect(b.opened).toBe(0);
    db.close();
  });

  it("结算:市场 closed → 回填 realized_pnl 并标 settled", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status) VALUES (1,'c1','Yes','tok',0,0.5,500,1000,'open')",
    ).run();
    const meta: MarketMeta = {
      conditionId: "c1",
      closed: true,
      outcomePrices: [1, 0],
      outcomes: ["Yes", "No"],
      volume24hr: null,
      liquidity: null,
      endDate: null,
      category: null,
    };
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: [] }),
      getSmart: smart,
      fetchPrice: async () => null,
      getMeta: async () => ({ c1: meta }),
      nowSec: 3000,
    });
    expect(r.settled).toBe(1);
    const pos = db
      .prepare(
        "SELECT status, realized_pnl FROM follow_positions WHERE condition_id='c1'",
      )
      .get() as { status: string; realized_pnl: number };
    expect(pos.status).toBe("settled");
    expect(pos.realized_pnl).toBeCloseTo(500);
    db.close();
  });

  it("结算降级:市场未 closed → 不结算、不写脏数据(status 仍 open、realized_pnl 仍 null)", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status) VALUES (1,'c1','Yes','tok',0,0.5,500,1000,'open')",
    ).run();
    const meta: MarketMeta = {
      conditionId: "c1",
      closed: false, // 未结算 → 本轮不应平仓
      outcomePrices: [0.7, 0.3],
      outcomes: ["Yes", "No"],
      volume24hr: null,
      liquidity: null,
      endDate: null,
      category: null,
    };
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: [] }),
      getSmart: smart,
      fetchPrice: async () => null,
      getMeta: async () => ({ c1: meta }),
      nowSec: 3000,
    });
    expect(r.settled).toBe(0);
    const pos = db
      .prepare(
        "SELECT status, exit_price, realized_pnl FROM follow_positions WHERE condition_id='c1'",
      )
      .get() as {
      status: string;
      exit_price: number | null;
      realized_pnl: number | null;
    };
    expect(pos.status).toBe("open");
    expect(pos.exit_price).toBeNull();
    expect(pos.realized_pnl).toBeNull();
    db.close();
  });

  it("韧性:fetchPrice 抛错不 reject 整轮 —— 回退窗口价开仓,结算照常进行", async () => {
    const db = openDb(":memory:");
    // 一个独立的已 closed 待结算仓(c2),验证 fetchPrice 抛错后结算阶段仍执行。
    db.prepare(
      "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status) VALUES (1,'c2','Yes','tok2',0,0.5,500,1000,'open')",
    ).run();
    const trades = [
      trade({ proxyWallet: "w1", transactionHash: "h1", size: 10000 }),
      trade({ proxyWallet: "w2", transactionHash: "h2", size: 10000 }),
    ];
    const closed: MarketMeta = {
      conditionId: "c2",
      closed: true,
      outcomePrices: [1, 0],
      outcomes: ["Yes", "No"],
      volume24hr: null,
      liquidity: null,
      endDate: null,
      category: null,
    };
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades }),
      getSmart: smart,
      fetchPrice: async () => {
        throw new Error("CLOB 5xx");
      },
      getMeta: async () => ({ c2: closed }),
      nowSec: 3000,
    });
    // fetchPrice 抛错被兜住 → 回退窗口最近价 0.6 开出 c1 仓;整轮不 reject。
    expect(r.opened).toBe(1);
    const c1 = db
      .prepare(
        "SELECT entry_price FROM follow_positions WHERE condition_id='c1'",
      )
      .get() as { entry_price: number };
    expect(c1.entry_price).toBeCloseTo(0.6);
    // 关键:开仓阶段的价格异常没有掀翻独立的结算阶段 —— c2 照常平仓。
    expect(r.settled).toBe(1);
    const c2 = db
      .prepare("SELECT status FROM follow_positions WHERE condition_id='c2'")
      .get() as { status: string };
    expect(c2.status).toBe("settled");
    db.close();
  });

  it("韧性:getMeta 抛错不 reject 整轮 —— 本轮不结算,仓位保持 open", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status) VALUES (1,'c1','Yes','tok',0,0.5,500,1000,'open')",
    ).run();
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: [] }),
      getSmart: smart,
      fetchPrice: async () => null,
      getMeta: async () => {
        throw new Error("gamma down");
      },
      nowSec: 3000,
    });
    expect(r.settled).toBe(0);
    const pos = db
      .prepare("SELECT status FROM follow_positions WHERE condition_id='c1'")
      .get() as { status: string };
    expect(pos.status).toBe("open");
    db.close();
  });
});
