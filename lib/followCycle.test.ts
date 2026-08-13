import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import { readMarketTiltSnapshots, runFollowCycle } from "./follow";
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
      // ts=1000、nowSec=1800 → 距 formationTs 800s < freshSec 默认 900,保持新鲜。
      nowSec: 1800,
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

  it("开仓落 fee_usd —— 协议费按成交价算，是执行成本里最大的一项", async () => {
    // 「Polymarket 零手续费」在 2026-08-04 被实测推翻:头部 100 市场 72 个
    // feesEnabled,占 24h 量 57.8%。同一笔 $500 单实测盘口滑点 $0.00 而
    // taker 费约名义额 2.5% —— 不计费的纸面收益率偏乐观,且偏的正是最大项。
    const db = openDb(":memory:");
    const trades = [
      trade({ proxyWallet: "w1", transactionHash: "h1", size: 10000 }),
      trade({ proxyWallet: "w2", transactionHash: "h2", size: 10000 }),
    ];
    const feeMeta: MarketMeta = {
      conditionId: "c1",
      closed: false,
      outcomePrices: [0.6, 0.4],
      outcomes: ["Yes", "No"],
      clobTokenIds: ["tok", "tok-no"],
      volume24hr: null,
      liquidity: null,
      endDate: null,
      category: null,
      feesEnabled: true,
      feeType: "politics_fees",
      feeSchedule: {
        exponent: 1,
        rate: 0.05,
        takerOnly: true,
        rebateRate: 0.2,
      },
      umaDisputed: false,
    };
    await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades }),
      getSmart: smart,
      fetchPrice: async () => 0.5,
      getMeta: async () => ({ c1: feeMeta }),
      nowSec: 1800,
    });
    const rows = db
      .prepare("SELECT size_usd, entry_price, fee_usd FROM follow_positions")
      .all() as { size_usd: number; entry_price: number; fee_usd: number }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const p of rows) {
      // fee = sizeUsd × rate × (1−p) = size × 0.05 × 0.5
      expect(p.fee_usd).toBeCloseTo(p.size_usd * 0.05 * 0.5, 6);
    }
  });

  it("免费市场 fee_usd=0，费率未知则为 null（绝不把未知当 0）", async () => {
    const mk = async (over: Partial<MarketMeta>) => {
      const db = openDb(":memory:");
      const trades = [
        trade({ proxyWallet: "w1", transactionHash: "h1", size: 10000 }),
        trade({ proxyWallet: "w2", transactionHash: "h2", size: 10000 }),
      ];
      await runFollowCycle({
        db,
        fetchWindow: async () => ({ trades }),
        getSmart: smart,
        fetchPrice: async () => 0.5,
        getMeta: async () => ({
          c1: {
            conditionId: "c1",
            closed: false,
            outcomePrices: [0.6, 0.4],
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
            ...over,
          } as MarketMeta,
        }),
        nowSec: 1800,
      });
      const r = db
        .prepare("SELECT fee_usd FROM follow_positions LIMIT 1")
        .get() as { fee_usd: number | null };
      db.close();
      return r.fee_usd;
    };
    expect(await mk({ feesEnabled: false })).toBe(0);
    // 收费但费率表缺失 = 未知,落 null 让 UI 诚实留白。
    expect(await mk({ feesEnabled: true, feeSchedule: null })).toBeNull();
  });

  it("市场 meta 缺失时 fee_usd 为 null，开仓照常（费用是归因，不阻塞主链路）", async () => {
    const db = openDb(":memory:");
    const trades = [
      trade({ proxyWallet: "w1", transactionHash: "h1", size: 10000 }),
      trade({ proxyWallet: "w2", transactionHash: "h2", size: 10000 }),
    ];
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades }),
      getSmart: smart,
      fetchPrice: async () => 0.5,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(r.opened).toBeGreaterThanOrEqual(1);
    const p = db
      .prepare("SELECT fee_usd FROM follow_positions LIMIT 1")
      .get() as { fee_usd: number | null };
    expect(p.fee_usd).toBeNull();
    db.close();
  });

  it("UMA 争议中的市场不结算 —— outcomePrices 还可能被推翻", async () => {
    // 争议中的 closed 市场,outcomePrices 是「提案结果」而非终局。按它结算会
    // 把一个可能被推翻的价格永久写进 realized_pnl(结算是一次性的,写完就不
    // 再重算)。保持 open、下轮再试,是唯一可回退的选择。
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status) VALUES (1,'cD','Yes','tokD',0,0.5,500,1000,'open')",
    ).run();
    const disputed: MarketMeta = {
      conditionId: "cD",
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
      umaDisputed: true,
    };
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: [] }),
      getSmart: smart,
      fetchPrice: async () => 0.5,
      getMeta: async () => ({ cD: disputed }),
      nowSec: 1800,
    });
    expect(r.settled).toBe(0);
    const p = db
      .prepare("SELECT status, realized_pnl FROM follow_positions")
      .get() as { status: string; realized_pnl: number | null };
    expect(p.status).toBe("open");
    expect(p.realized_pnl).toBeNull();
    db.close();
  });

  it("争议解除后正常结算（争议门是暂缓，不是永久拉黑）", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status) VALUES (1,'cD','Yes','tokD',0,0.5,500,1000,'open')",
    ).run();
    const settledMeta: MarketMeta = {
      conditionId: "cD",
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
    };
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: [] }),
      getSmart: smart,
      fetchPrice: async () => 0.5,
      getMeta: async () => ({ cD: settledMeta }),
      nowSec: 1800,
    });
    expect(r.settled).toBe(1);
    db.close();
  });

  it("umaDisputed=null(未知)照常结算 —— fail-open,不因新字段拿不到就冻结全局", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status) VALUES (1,'cU','Yes','tokU',0,0.5,500,1000,'open')",
    ).run();
    const unknown: MarketMeta = {
      conditionId: "cU",
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
      umaDisputed: null,
    };
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: [] }),
      getSmart: smart,
      fetchPrice: async () => 0.5,
      getMeta: async () => ({ cU: unknown }),
      nowSec: 1800,
    });
    expect(r.settled).toBe(1);
    db.close();
  });

  it("截断窗口跳过开仓(formationTs 不可信),结算照常", async () => {
    // 窗口被截断时,截断边缘前的成交不可见,可见跨线会把 formationTs 系统性
    // 后移 —— 新鲜度闸门与形成价护栏同时失真,此轮禁止开仓;结算与 markout
    // 只依赖已有仓位,不受窗口影响,照常执行。
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status) VALUES (1,'c9','Yes','tok9',0,0.5,500,1000,'open')",
    ).run();
    const trades = [
      trade({ proxyWallet: "w1", transactionHash: "h1", size: 10000 }),
      trade({ proxyWallet: "w2", transactionHash: "h2", size: 10000 }),
    ];
    const c9: MarketMeta = {
      conditionId: "c9",
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
    };
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades, truncated: true }),
      getSmart: smart,
      fetchPrice: async () => 0.63,
      getMeta: async () => ({ c9 }),
      nowSec: 1800, // 未截断本该开仓(新鲜度内)
    });
    expect(r.opened).toBe(0);
    expect(r.settled).toBe(1);
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
      nowSec: 1800, // 距 formationTs(1000)800s < 900,新鲜
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
      clobTokenIds: ["tok", "tok-no"],
      volume24hr: null,
      liquidity: null,
      endDate: null,
      category: null,
      feesEnabled: false,
      feeType: null,
      feeSchedule: null,
      umaDisputed: false,
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
      clobTokenIds: ["tok", "tok-no"],
      volume24hr: null,
      liquidity: null,
      endDate: null,
      category: null,
      feesEnabled: false,
      feeType: null,
      feeSchedule: null,
      umaDisputed: false,
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
    // 成交需落在新鲜度窗口内(nowSec=2800、ts=2000 → 距 formationTs 800s<900),
    // 否则新鲜度闸门会拦下开仓,本用例考察的是「fetchPrice 抛错不掀翻整轮」而非
    // 陈旧组过滤。
    const trades = [
      trade({
        proxyWallet: "w1",
        transactionHash: "h1",
        size: 10000,
        timestamp: 2000,
      }),
      trade({
        proxyWallet: "w2",
        transactionHash: "h2",
        size: 10000,
        timestamp: 2000,
      }),
    ];
    const closed: MarketMeta = {
      conditionId: "c2",
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
    };
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades }),
      getSmart: smart,
      fetchPrice: async () => {
        throw new Error("CLOB 5xx");
      },
      getMeta: async () => ({ c2: closed }),
      nowSec: 2800,
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

// 新鲜度闸门 + 跳过已结算市场:消除「一启动就把过去 6h 里形成过的每个共识按当前价
// 补开一遍仓」的接飞刀 —— 只跟 freshSec(默认 900s=15min)内「形成」(formationTs,
// 第 N 个合格钱包跨线时刻)的共识,且不给已 closed 的市场开仓。两笔各净买 $6k
// (size=10000@0.6),满足默认策略阈值。
describe("runFollowCycle 新鲜度闸门 + 跳过已结算市场", () => {
  const bigTrades = (ts: number): Trade[] => [
    trade({
      proxyWallet: "w1",
      transactionHash: "h1",
      size: 10000,
      timestamp: ts,
    }),
    trade({
      proxyWallet: "w2",
      transactionHash: "h2",
      size: 10000,
      timestamp: ts,
    }),
  ];

  it("陈旧共识(formationTs 距 now 超过 freshSec)一律不开仓", async () => {
    const db = openDb(":memory:");
    // ts=1000、nowSec=3000 → age=2000s>900 → 陈旧,不该补开历史/接飞刀。
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: bigTrades(1000) }),
      getSmart: smart,
      fetchPrice: async () => 0.63,
      getMeta: async () => ({}),
      nowSec: 3000,
    });
    expect(r.opened).toBe(0);
    const cnt = db
      .prepare("SELECT COUNT(*) AS n FROM follow_positions")
      .get() as { n: number };
    expect(cnt.n).toBe(0);
    db.close();
  });

  it("新鲜共识(formationTs 距 now 在 freshSec 内)照常开仓", async () => {
    const db = openDb(":memory:");
    // ts=1000、nowSec=1800 → age=800s<900 → 新鲜,开仓。
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: bigTrades(1000) }),
      getSmart: smart,
      fetchPrice: async () => 0.63,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(r.opened).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("新鲜但市场已 closed → 不开仓(不该开一个已结算的仓)", async () => {
    const db = openDb(":memory:");
    const closed: MarketMeta = {
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
    };
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: bigTrades(1000) }),
      getSmart: smart,
      fetchPrice: async () => 0.63,
      getMeta: async () => ({ c1: closed }),
      nowSec: 1800,
    });
    expect(r.opened).toBe(0);
    const cnt = db
      .prepare("SELECT COUNT(*) AS n FROM follow_positions")
      .get() as { n: number };
    expect(cnt.n).toBe(0);
    db.close();
  });

  it("新鲜且 meta 缺失(未知≠已结算)→ 照常开仓", async () => {
    const db = openDb(":memory:");
    // getMeta 对该 cid 返回空对象:市场状态未知,不能当成已结算而拒开。
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: bigTrades(1000) }),
      getSmart: smart,
      fetchPrice: async () => 0.63,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(r.opened).toBeGreaterThanOrEqual(1);
    db.close();
  });
});

// M8 进场价偏离护栏:新鲜度闸门(30min)拦不住 in-play 体育盘 —— 真机实证 30 分钟内
// 现价照样能跑 20¢(Osaka 仓:聪明钱均价 46.4¢、我们进 26.5¢,单仓滑点 −$375)。
// 现价偏离聪明钱均价超过 maxEntryDeviationCents(默认 10¢)即不开仓,宁可错过也不
// 追高/接飞刀。单位:price 是 0-1 小数、阈值是 ¢,比较时 ×100。
describe("runFollowCycle 进场价偏离护栏", () => {
  // 新鲜共识:ts=1000、nowSec=1800 → 距 formationTs 800s < 900,不会被新鲜度闸门
  // 拦下,只考察偏离护栏本身。两钱包各净买 $6k @0.6 → 聪明钱均价 0.6,命中激进策略
  // (≥2 钱包 ≥$5k;保守要 ≥3 钱包 ≥$10k,不合格)。本组不注入 fetchFormationPrice
  // → formationPrice 为 null,护栏走 avgBuyPrice 回退基准(formationPrice 基准见
  // 下方「护栏基准 = formationPrice」组)。
  const freshTrades = (): Trade[] => [
    trade({
      proxyWallet: "w1",
      transactionHash: "h1",
      size: 10000,
      timestamp: 1000,
    }),
    trade({
      proxyWallet: "w2",
      transactionHash: "h2",
      size: 10000,
      timestamp: 1000,
    }),
  ];

  it("偏离超过默认 10¢ → 不开仓(现价 0.45 vs 均价 0.6,偏离 15¢)", async () => {
    const db = openDb(":memory:");
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: freshTrades() }),
      getSmart: smart,
      fetchPrice: async () => 0.45,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(r.opened).toBe(0);
    const cnt = db
      .prepare("SELECT COUNT(*) AS n FROM follow_positions")
      .get() as { n: number };
    expect(cnt.n).toBe(0);
    db.close();
  });

  it("偏离在默认阈内照常开仓(现价 0.55 vs 均价 0.6,偏离 5¢)", async () => {
    const db = openDb(":memory:");
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: freshTrades() }),
      getSmart: smart,
      fetchPrice: async () => 0.55,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(r.opened).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("每策略阈值可调:显式 maxEntryDeviationCents=50 时 15¢ 偏离照开", async () => {
    const db = openDb(":memory:");
    // 给种子「激进」策略显式放宽护栏到 50¢(params_json 就地 UPDATE,模拟运营调参)。
    db.prepare(
      "UPDATE follow_strategies SET params_json = ? WHERE name = '激进'",
    ).run(
      JSON.stringify({
        minWallets: 2,
        minPerWalletUsd: 5000,
        sizeUsd: 500,
        exitRule: "settlement",
        maxEntryDeviationCents: 50,
      }),
    );
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: freshTrades() }),
      getSmart: smart,
      fetchPrice: async () => 0.45, // 偏离 15¢ < 50¢ → 该策略照开
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(r.opened).toBeGreaterThanOrEqual(1);
    const pos = db
      .prepare(
        "SELECT entry_price FROM follow_positions WHERE condition_id='c1'",
      )
      .get() as { entry_price: number };
    expect(pos.entry_price).toBe(0.45);
    db.close();
  });
});

// 分歧市场互斥:detectConsensus 按 (conditionId, outcome) 分组,不同的聪明钱各买
// 同一市场的对立结果时会产出两个单边「假共识」组(对冲者剔除只防同一钱包买两边)。
// 真机实锤:激进策略同时持有 Argentina O/U 2.5 的 Over@41.5¢ 和 Under@58.5¢ ——
// 跟了分歧,而产品语义是「只跟共识,不跟分歧」。修复:复用共识页同一口径
// (detectDisagreement + excludeContestedFromConsensus,DEFAULT_DISAGREEMENT 阈值:
// minPerSideUsd $5k / minWalletsPerSide 1)把分歧市场整体剔除,双边都不跟。
describe("runFollowCycle 分歧市场不跟(市场级互斥)", () => {
  // 4 个白名单钱包桩:w1,w2 买 Yes;w3,w4 买 No。
  const smart4 = (): Map<string, SmartTag> =>
    new Map([
      ["w1", { score: 80, winRate: 0.7, netPnl: 1, isWhitelist: true }],
      ["w2", { score: 75, winRate: 0.65, netPnl: 1, isWhitelist: true }],
      ["w3", { score: 70, winRate: 0.6, netPnl: 1, isWhitelist: true }],
      ["w4", { score: 65, winRate: 0.55, netPnl: 1, isWhitelist: true }],
    ]);

  // 同一市场 c1 的对立两 token:Yes=tokYes/0、No=tokNo/1,asset 与 outcomeIndex
  // 均不同。价格互补(0.6/0.4),size 折算每笔净买 $6000 —— 同时超过激进策略阈值
  // ($5k/钱包)与分歧 side 阈值(minPerSideUsd $5k)。ts=1000、nowSec=2000 →
  // 距 formationTs 800s < 900,全部 fresh,新鲜度闸门不会先拦下,单独考察分歧互斥。
  const yesBuy = (wallet: string, hash: string): Trade =>
    trade({
      proxyWallet: wallet,
      transactionHash: hash,
      asset: "tokYes",
      outcome: "Yes",
      outcomeIndex: 0,
      size: 10000,
      price: 0.6,
      timestamp: 1000,
    });
  const noBuy = (wallet: string, hash: string): Trade =>
    trade({
      proxyWallet: wallet,
      transactionHash: hash,
      asset: "tokNo",
      outcome: "No",
      outcomeIndex: 1,
      size: 15000,
      price: 0.4,
      timestamp: 1000,
    });
  // 现价按 token 给:与各侧聪明钱均价一致(偏离 0¢),偏离护栏也不会先拦下。
  const priceByAsset = async (asset: string) =>
    asset === "tokYes" ? 0.6 : 0.4;

  it("分歧市场(两边各 2 钱包净买 $6k)→ 双边都不跟,c1 无任何仓", async () => {
    const db = openDb(":memory:");
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({
        trades: [
          yesBuy("w1", "h1"),
          yesBuy("w2", "h2"),
          noBuy("w3", "h3"),
          noBuy("w4", "h4"),
        ],
      }),
      getSmart: smart4,
      fetchPrice: priceByAsset,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    // 修复前:Yes/No 各成一个激进「假共识」组,各开一仓(opened=2)。
    expect(r.opened).toBe(0);
    const cnt = db
      .prepare(
        "SELECT COUNT(*) AS n FROM follow_positions WHERE condition_id='c1'",
      )
      .get() as { n: number };
    expect(cnt.n).toBe(0);
    db.close();
  });

  it("软对立(Yes 侧够共识,No 侧单钱包 $6k 只够分歧 side)→ 同样不跟", async () => {
    const db = openDb(":memory:");
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({
        trades: [yesBuy("w1", "h1"), yesBuy("w2", "h2"), noBuy("w3", "h3")],
      }),
      getSmart: smart4,
      fetchPrice: priceByAsset,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    // No 侧单钱包不构成共识组,但 $6k ≥ minPerSideUsd($5k)/1 钱包 ≥
    // minWalletsPerSide(1)→ 市场即分歧,Yes 侧共识也被市场级互斥剔除。
    expect(r.opened).toBe(0);
    const cnt = db
      .prepare(
        "SELECT COUNT(*) AS n FROM follow_positions WHERE condition_id='c1'",
      )
      .get() as { n: number };
    expect(cnt.n).toBe(0);
    db.close();
  });

  it("单边共识(仅 w1,w2 买 Yes,无对立方)不受互斥误伤,照常开仓", async () => {
    const db = openDb(":memory:");
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({
        trades: [yesBuy("w1", "h1"), yesBuy("w2", "h2")],
      }),
      getSmart: smart4,
      fetchPrice: priceByAsset,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(r.opened).toBeGreaterThanOrEqual(1);
    const pos = db
      .prepare("SELECT outcome FROM follow_positions WHERE condition_id='c1'")
      .get() as { outcome: string };
    expect(pos.outcome).toBe("Yes");
    db.close();
  });
});

// P1 信号触发改造:新鲜度从 lastTs 换锚到 formationTs(第 N 个合格钱包跨线时刻)。
// 已验证的缺陷:lastTs 被组内任何白名单成交(含 SELL、含不达标非成员)刷新 ——
// 5 小时前形成的老共识被一笔 $2k 卖单"续命"成新鲜,按现价跟入,买入成本失控
// (真实尾部 0~6h)。formationTs 只随合格钱包的跨线动作移动,杂音续不了命。
describe("runFollowCycle formationTs 锚定新鲜度(P1 核心)", () => {
  const smart3 = (): Map<string, SmartTag> =>
    new Map([
      ["w1", { score: 80, winRate: 0.7, netPnl: 1, isWhitelist: true }],
      ["w2", { score: 75, winRate: 0.65, netPnl: 1, isWhitelist: true }],
      ["w3", { score: 70, winRate: 0.6, netPnl: 1, isWhitelist: true }],
    ]);

  it("老共识 + 白名单杂音续命 → 不再被跟(修复前锚 lastTs 会开仓)", async () => {
    const db = openDb(":memory:");
    const trades = [
      // A t=1000 买 $6k、B t=1200 买 $6k → formationTs=1200(第 2 人跨线)。
      trade({
        proxyWallet: "w1",
        transactionHash: "h1",
        size: 10000,
        price: 0.6,
        timestamp: 1000,
      }),
      trade({
        proxyWallet: "w2",
        transactionHash: "h2",
        size: 10000,
        price: 0.6,
        timestamp: 1200,
      }),
      // C 白名单但只买 $2.5k(不达标非成员)在 t=9000 —— 旧实现里这笔刷新
      // lastTs=9000,把 2 小时前的老共识"续命"成新鲜。
      trade({
        proxyWallet: "w3",
        transactionHash: "h3",
        size: 5000,
        price: 0.5,
        timestamp: 9000,
      }),
    ];
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades }),
      getSmart: smart3,
      fetchPrice: async () => 0.6,
      getMeta: async () => ({}),
      // lastTs=9000 距 now 仅 600s(很"新鲜"),但 formationTs=1200 距 now
      // 8400s ≫ freshSec(900)→ 陈旧,不开。
      nowSec: 9600,
    });
    expect(r.opened).toBe(0);
    const cnt = db
      .prepare("SELECT COUNT(*) AS n FROM follow_positions")
      .get() as { n: number };
    expect(cnt.n).toBe(0);
    db.close();
  });

  it("INSERT 落库 formation_ts=组 formationTs、formation_price=fetchFormationPrice 结果", async () => {
    const db = openDb(":memory:");
    const trades = [
      trade({
        proxyWallet: "w1",
        transactionHash: "h1",
        size: 10000,
        price: 0.6,
        timestamp: 1000,
      }),
      trade({
        proxyWallet: "w2",
        transactionHash: "h2",
        size: 10000,
        price: 0.6,
        timestamp: 1200,
      }),
    ];
    const calls: { asset: string; ts: number }[] = [];
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades }),
      getSmart: smart,
      fetchPrice: async () => 0.63,
      fetchFormationPrice: async (asset, ts) => {
        calls.push({ asset, ts });
        return 0.58;
      },
      getMeta: async () => ({}),
      nowSec: 1800, // 距 formationTs(1200)600s < 900,新鲜
    });
    expect(r.opened).toBeGreaterThanOrEqual(1);
    // 形成价按「形成时刻」查:asset=组 token、ts=formationTs(第 2 人跨线 @1200)。
    expect(calls).toContainEqual({ asset: "tok", ts: 1200 });
    const pos = db
      .prepare(
        "SELECT formation_ts, formation_price FROM follow_positions WHERE condition_id='c1'",
      )
      .get() as { formation_ts: number; formation_price: number };
    expect(pos.formation_ts).toBe(1200);
    expect(pos.formation_price).toBe(0.58);
    db.close();
  });

  it("fetchFormationPrice 抛错/null → formation_price 存 null,不阻塞开仓", async () => {
    const db = openDb(":memory:");
    const trades = [
      trade({
        proxyWallet: "w1",
        transactionHash: "h1",
        size: 10000,
        price: 0.6,
        timestamp: 1000,
      }),
      trade({
        proxyWallet: "w2",
        transactionHash: "h2",
        size: 10000,
        price: 0.6,
        timestamp: 1200,
      }),
    ];
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades }),
      getSmart: smart,
      fetchPrice: async () => 0.63,
      fetchFormationPrice: async () => {
        throw new Error("CLOB 5xx");
      },
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(r.opened).toBeGreaterThanOrEqual(1);
    const pos = db
      .prepare(
        "SELECT formation_ts, formation_price FROM follow_positions WHERE condition_id='c1'",
      )
      .get() as { formation_ts: number; formation_price: number | null };
    expect(pos.formation_ts).toBe(1200);
    expect(pos.formation_price).toBeNull();
    db.close();
  });
});

// 护栏基准切换:偏离护栏改比 |entry − formationPrice|(形成后的真实漂移);
// formationPrice 为 null 时回退旧基准 |entry − avgBuyPrice|。均价差含聪明钱的
// 信息租金(他们买得早/便宜),用它当基准会误拦正常跟进、漏拦真漂移。
describe("runFollowCycle 护栏基准 = formationPrice", () => {
  // 两钱包各净买 $6k @0.5(avgBuyPrice=0.5),formationPrice 桩 0.6 —— 两基准
  // 拉开 10¢ 差距,才能区分护栏用的是哪个。ts=1000/1200、nowSec=1800 → 新鲜。
  const freshTrades = (): Trade[] => [
    trade({
      proxyWallet: "w1",
      transactionHash: "h1",
      size: 12000,
      price: 0.5,
      timestamp: 1000,
    }),
    trade({
      proxyWallet: "w2",
      transactionHash: "h2",
      size: 12000,
      price: 0.5,
      timestamp: 1200,
    }),
  ];

  it("entry=0.75 vs formationPrice=0.6:偏 15¢ > 10 → 不开", async () => {
    const db = openDb(":memory:");
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: freshTrades() }),
      getSmart: smart,
      fetchPrice: async () => 0.75,
      fetchFormationPrice: async () => 0.6,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(r.opened).toBe(0);
    db.close();
  });

  it("entry=0.65 vs formationPrice=0.6:偏 5¢ ≤ 10 → 开(旧基准 avg=0.5 差 15¢ 会误拦 —— 坐实基准已切换)", async () => {
    const db = openDb(":memory:");
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: freshTrades() }),
      getSmart: smart,
      fetchPrice: async () => 0.65,
      fetchFormationPrice: async () => 0.6,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(r.opened).toBeGreaterThanOrEqual(1);
    const pos = db
      .prepare(
        "SELECT entry_price, formation_price FROM follow_positions WHERE condition_id='c1'",
      )
      .get() as { entry_price: number; formation_price: number };
    expect(pos.entry_price).toBe(0.65);
    expect(pos.formation_price).toBe(0.6);
    db.close();
  });

  it("formationPrice=null → 回退 avgBuyPrice 基准仍生效(0.65 vs avg 0.5 = 15¢ → 拦)", async () => {
    const db = openDb(":memory:");
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: freshTrades() }),
      getSmart: smart,
      fetchPrice: async () => 0.65,
      fetchFormationPrice: async () => null,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(r.opened).toBe(0);
    db.close();
  });

  it("formationPrice=null 回退基准内(0.55 vs avg 0.5 = 5¢)→ 照常开", async () => {
    const db = openDb(":memory:");
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: freshTrades() }),
      getSmart: smart,
      fetchPrice: async () => 0.55,
      fetchFormationPrice: async () => null,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(r.opened).toBeGreaterThanOrEqual(1);
    db.close();
  });
});

// markout 惰性回填:formation_ts 非空、markout 列为 null 且 nowSec >
// formation_ts+delta+300 的仓位(open+settled 都要),用 fetchPrice(asset,
// formation_ts+delta) 取常规最近点回填。红线:markout 只用于归因展示,绝不参与
// realized_pnl。
describe("runFollowCycle markout 惰性回填", () => {
  it("open+settled 两仓均回填 markout_30m/markout_2h;已填不重复拉", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status,formation_ts) VALUES (2,'m1','Yes','tokM',0,0.6,500,833,'open',1000)",
    ).run();
    db.prepare(
      "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status,formation_ts,exit_ts,exit_price,realized_pnl) VALUES (2,'m2','Yes','tokM2',0,0.6,500,833,'settled',1000,9000,1,333)",
    ).run();
    // nowSec=8501:1000+1800+300=3100 与 1000+7200+300=8500 都已过 → 两列均可回填。
    const priceByTs = async (_asset: string, ts: number) =>
      ts === 2800 ? 0.66 : ts === 8200 ? 0.72 : null;
    const r1 = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: [] }),
      getSmart: smart,
      fetchPrice: priceByTs,
      getMeta: async () => ({}),
      nowSec: 8501,
    });
    expect(r1.opened).toBe(0);
    const rows = db
      .prepare(
        "SELECT condition_id, markout_30m, markout_2h, realized_pnl FROM follow_positions ORDER BY condition_id",
      )
      .all() as {
      condition_id: string;
      markout_30m: number;
      markout_2h: number;
      realized_pnl: number | null;
    }[];
    for (const row of rows) {
      expect(row.markout_30m).toBe(0.66); // 价格 @ formation_ts+1800=2800
      expect(row.markout_2h).toBe(0.72); // 价格 @ formation_ts+7200=8200
    }
    // 红线:markout 回填绝不改 realized_pnl(settled 仓保持原值,open 仓保持 null)。
    expect(rows.find((row) => row.condition_id === "m2")?.realized_pnl).toBe(
      333,
    );
    expect(
      rows.find((row) => row.condition_id === "m1")?.realized_pnl,
    ).toBeNull();

    // 第二轮:桩改返回 0.99 —— 已填列不得被重复拉取/覆盖。
    const r2 = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: [] }),
      getSmart: smart,
      fetchPrice: async () => 0.99,
      getMeta: async () => ({}),
      nowSec: 9000,
    });
    expect(r2.opened).toBe(0);
    const again = db
      .prepare("SELECT markout_30m, markout_2h FROM follow_positions")
      .all() as { markout_30m: number; markout_2h: number }[];
    for (const row of again) {
      expect(row.markout_30m).toBe(0.66);
      expect(row.markout_2h).toBe(0.72);
    }
    db.close();
  });

  it("30m 已到期、2h 未到 → 只回填 markout_30m;fetchPrice 失败留 null 下轮再试", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status,formation_ts) VALUES (2,'m1','Yes','tokM',0,0.6,500,833,'open',1000)",
    ).run();
    db.prepare(
      "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status,formation_ts) VALUES (2,'m2','Yes','tokFAIL',0,0.6,500,833,'open',1000)",
    ).run();
    // nowSec=3101 > 1000+1800+300=3100,但 < 1000+7200+300=8500 → 只有 30m 到期。
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: [] }),
      getSmart: smart,
      fetchPrice: async (asset: string) => {
        if (asset === "tokFAIL") throw new Error("CLOB 5xx");
        return 0.66;
      },
      getMeta: async () => ({}),
      nowSec: 3101,
    });
    expect(r.opened).toBe(0);
    const m1 = db
      .prepare(
        "SELECT markout_30m, markout_2h FROM follow_positions WHERE condition_id='m1'",
      )
      .get() as { markout_30m: number; markout_2h: number | null };
    expect(m1.markout_30m).toBe(0.66);
    expect(m1.markout_2h).toBeNull(); // 未到期
    // 失败仓:两列都留 null(下轮重试),且失败不掀翻整轮(m1 已正常回填)。
    const m2 = db
      .prepare(
        "SELECT markout_30m, markout_2h FROM follow_positions WHERE condition_id='m2'",
      )
      .get() as { markout_30m: number | null; markout_2h: number | null };
    expect(m2.markout_30m).toBeNull();
    expect(m2.markout_2h).toBeNull();
    db.close();
  });

  it("死仓不饿死新仓:10 个取不到价的旧仓占不满名额,最新仓照常回填", async () => {
    const db = openDb(":memory:");
    // 11 个 formation_ts 递增的仓:前 10 个(旧)的 token 已失活 —— fetchPriceAt
    // 对这类 token 恒返回 null,markout 列永远填不上。修复前按 ORDER BY id 它们
    // 永远排在前面占住每轮 10 个名额,最新仓的回填永久停摆且每轮空烧 HTTP。
    const ins = db.prepare(
      "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status,formation_ts) VALUES (2,?,'Yes',?,0,0.6,500,833,'open',?)",
    );
    for (let i = 1; i <= 10; i++) {
      ins.run(`dead${i}`, `tokDead${i}`, 1000 + i * 100);
    }
    ins.run("newest", "tokNew", 2000); // formation_ts 最大 → 应最先被处理
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: [] }),
      getSmart: smart,
      fetchPrice: async (asset: string) => (asset === "tokNew" ? 0.7 : null),
      getMeta: async () => ({}),
      nowSec: 10_000, // 2000+7200+300=9500 < 10000 → 两列均到期
    });
    expect(r.opened).toBe(0);
    const fresh = db
      .prepare(
        "SELECT markout_30m, markout_2h FROM follow_positions WHERE condition_id='newest'",
      )
      .get() as { markout_30m: number | null; markout_2h: number | null };
    // ORDER BY formation_ts DESC → 最新仓排第一,不被死仓堵住。
    expect(fresh.markout_30m).toBe(0.7);
    expect(fresh.markout_2h).toBe(0.7);
    // 死仓取不到价 → 列保持 null(不写脏值)。
    const dead = db
      .prepare(
        "SELECT markout_30m FROM follow_positions WHERE condition_id='dead1'",
      )
      .get() as { markout_30m: number | null };
    expect(dead.markout_30m).toBeNull();
    db.close();
  });

  it("形成超 7 天的仓不再重试(截止期出队,不空烧 HTTP)", async () => {
    const db = openDb(":memory:");
    const nowSec = 30 * 86400;
    // 形成于 8 天前:已过 7 天截止,即使 markout 仍为 null 也不再进回填队列。
    db.prepare(
      "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status,formation_ts) VALUES (2,'ancient','Yes','tokA',0,0.6,500,833,'open',?)",
    ).run(nowSec - 8 * 86400);
    let called = 0;
    await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: [] }),
      getSmart: smart,
      fetchPrice: async () => {
        called++;
        return 0.5;
      },
      getMeta: async () => ({}),
      nowSec,
    });
    expect(called).toBe(0); // 截止期把死仓彻底出队,不再每轮空烧
    const row = db
      .prepare(
        "SELECT markout_30m, markout_2h FROM follow_positions WHERE condition_id='ancient'",
      )
      .get() as { markout_30m: number | null; markout_2h: number | null };
    expect(row.markout_30m).toBeNull();
    expect(row.markout_2h).toBeNull();
    db.close();
  });

  it("formation_ts 为 null 的历史仓不参与回填(老数据兼容)", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status) VALUES (2,'legacy','Yes','tokL',0,0.6,500,833,'open')",
    ).run();
    let called = 0;
    await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: [] }),
      getSmart: smart,
      fetchPrice: async () => {
        called++;
        return 0.5;
      },
      getMeta: async () => ({}),
      nowSec: 100_000,
    });
    expect(called).toBe(0); // 无 formation_ts → 无 markout 目标,也无开仓取价
    const row = db
      .prepare(
        "SELECT markout_30m, markout_2h FROM follow_positions WHERE condition_id='legacy'",
      )
      .get() as { markout_30m: number | null; markout_2h: number | null };
    expect(row.markout_30m).toBeNull();
    expect(row.markout_2h).toBeNull();
    db.close();
  });
});

// --- 执行层建模:开仓瞬间盘口快照 → 模拟吃单落 exec_* 归因列 ---
describe("runFollowCycle 执行滑点归因(fetchBook)", () => {
  const twoWalletTrades = () => [
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
  const baseDeps = (db: ReturnType<typeof openDb>) => ({
    db,
    fetchWindow: async () => ({ trades: twoWalletTrades() }),
    getSmart: smart,
    fetchPrice: async () => 0.63,
    getMeta: async () => ({}),
    nowSec: 1800,
  });

  it("注入 fetchBook → 模拟吃单结果落 exec_price/exec_best_ask/exec_filled_usd", async () => {
    const db = openDb(":memory:");
    // 升序簿(AskBook 契约):最优 0.64 档只有 $320 深度,余下吃 0.66 档。
    const r = await runFollowCycle({
      ...baseDeps(db),
      fetchBook: async () => ({
        asks: [
          { price: 0.64, size: 500 }, // $320
          { price: 0.66, size: 100000 },
        ],
      }),
    });
    expect(r.opened).toBeGreaterThanOrEqual(1);
    const row = db
      .prepare(
        "SELECT exec_price, exec_best_ask, exec_filled_usd FROM follow_positions WHERE condition_id='c1'",
      )
      .get() as {
      exec_price: number;
      exec_best_ask: number;
      exec_filled_usd: number;
    };
    const shares = 500 + 180 / 0.66; // 0.64 档 $320/0.64=500 份 + 0.66 档 $180
    expect(row.exec_best_ask).toBeCloseTo(0.64);
    expect(row.exec_filled_usd).toBeCloseTo(500);
    expect(row.exec_price).toBeCloseTo(500 / shares);
  });

  it("薄簿吃穿:exec_filled_usd < size_usd 如实落库(部分成交)", async () => {
    const db = openDb(":memory:");
    await runFollowCycle({
      ...baseDeps(db),
      fetchBook: async () => ({ asks: [{ price: 0.5, size: 100 }] }), // 仅 $50 深度
    });
    const row = db
      .prepare(
        "SELECT exec_price, exec_filled_usd FROM follow_positions WHERE condition_id='c1'",
      )
      .get() as { exec_price: number; exec_filled_usd: number };
    expect(row.exec_filled_usd).toBeCloseTo(50);
    expect(row.exec_price).toBeCloseTo(0.5);
  });

  it("fetchBook 抛错 → 开仓照常,exec 列全 null(归因抖动杀不死开仓)", async () => {
    const db = openDb(":memory:");
    const r = await runFollowCycle({
      ...baseDeps(db),
      fetchBook: async () => {
        throw new Error("boom 500");
      },
    });
    expect(r.opened).toBeGreaterThanOrEqual(1);
    const row = db
      .prepare(
        "SELECT exec_price, exec_best_ask, exec_filled_usd FROM follow_positions WHERE condition_id='c1'",
      )
      .get() as {
      exec_price: number | null;
      exec_best_ask: number | null;
      exec_filled_usd: number | null;
    };
    expect(row.exec_price).toBeNull();
    expect(row.exec_best_ask).toBeNull();
    expect(row.exec_filled_usd).toBeNull();
  });

  it("空簿(拿到了簿但无人挂卖)→ exec 列 null,开仓照常", async () => {
    const db = openDb(":memory:");
    const r = await runFollowCycle({
      ...baseDeps(db),
      fetchBook: async () => ({ asks: [] }),
    });
    expect(r.opened).toBeGreaterThanOrEqual(1);
    const row = db
      .prepare(
        "SELECT exec_price FROM follow_positions WHERE condition_id='c1'",
      )
      .get() as { exec_price: number | null };
    expect(row.exec_price).toBeNull();
  });

  it("未注入 fetchBook(向后兼容)→ exec 列 null", async () => {
    const db = openDb(":memory:");
    await runFollowCycle(baseDeps(db));
    const row = db
      .prepare(
        "SELECT exec_price FROM follow_positions WHERE condition_id='c1'",
      )
      .get() as { exec_price: number | null };
    expect(row.exec_price).toBeNull();
  });
});

// --- Task 4:DETECTORS 注册表接线 —— maxPrice 闸门 + 轮内缓存 + 多 source 集成 ---

// maxPrice 闸门:拦的是 entry(我们的实际入场价),不是聪明钱的成本 referencePrice。
// 用 0.9 价位的成交构造 referencePrice=0.9,让 entry 落在偏离护栏阈内(默认 10¢)
// 的同时可控地贴住/穿越 maxPrice(默认 0.95)—— 若沿用别处 0.6 的默认成交价,
// entry 必须 >0.95 才碰得到 maxPrice,但那样偏离基准(0.6)早超了 10¢ 偏离护栏,
// 分不清究竟是哪道闸拦下的开仓。
describe("runFollowCycle — maxPrice 闸门", () => {
  const highRefTrades = (): Trade[] => [
    trade({
      proxyWallet: "w1",
      transactionHash: "h1",
      size: 10000,
      price: 0.9,
      timestamp: 1000,
    }),
    trade({
      proxyWallet: "w2",
      transactionHash: "h2",
      size: 10000,
      price: 0.9,
      timestamp: 1000,
    }),
  ];

  it("entry 高于 maxPrice → 不开仓", async () => {
    const db = openDb(":memory:");
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: highRefTrades() }),
      getSmart: smart,
      // 0.96 vs referencePrice 0.9:偏离 6¢ < 默认偏离护栏 10¢(不会被那道闸拦),
      // 但 0.96 > 默认 maxPrice 0.95 → 应被价格上限单独拦下。
      fetchPrice: async () => 0.96,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(r.opened).toBe(0);
    const cnt = db
      .prepare("SELECT COUNT(*) AS n FROM follow_positions")
      .get() as { n: number };
    expect(cnt.n).toBe(0);
    db.close();
  });

  it("entry 等于 maxPrice → 照常开仓(边界:严格 >)", async () => {
    const db = openDb(":memory:");
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: highRefTrades() }),
      getSmart: smart,
      fetchPrice: async () => 0.95, // == maxPrice,严格 `>` 判定不拦
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    // highRefTrades 只有 2 个钱包 → 只有「激进」(2×$5k)命中,「保守」(3×$10k)
    // 因钱包数不够不产生候选,精确值就是 1(而非 toBeGreaterThanOrEqual)。
    expect(r.opened).toBe(1);
    const pos = db
      .prepare(
        "SELECT entry_price FROM follow_positions WHERE condition_id='c1'",
      )
      .get() as { entry_price: number };
    expect(pos.entry_price).toBe(0.95);
    db.close();
  });
});

// 轮内缓存:12 档并行下同一 asset 会被多条策略反复取价(参数完全相同的
// fetchPrice(asset, nowSec) 请求)。createPromiseCache 缓存的是 PROMISE,第一个
// 发起后其余直接拿同一个 in-flight promise,一次往返都不多花(见 lib/promiseCache.ts)。
describe("runFollowCycle — 轮内缓存(同 asset 只取一次价)", () => {
  const smart3 = (): Map<string, SmartTag> =>
    new Map([
      ["w1", { score: 80, winRate: 0.7, netPnl: 1, isWhitelist: true }],
      ["w2", { score: 75, winRate: 0.65, netPnl: 1, isWhitelist: true }],
      ["w3", { score: 70, winRate: 0.6, netPnl: 1, isWhitelist: true }],
    ]);

  it("同一 asset 被多条策略命中时 fetchPrice 只调用一次", async () => {
    const db = openDb(":memory:");
    // 3 个钱包各净买 $10k @0.5(size=20000)→ 同时满足种子「保守」(3×$10k)与
    // 「激进」(2×$5k)两条策略的阈值,两条策略各自对同一组(同一 asset=tok)
    // 产出一个候选 —— 开仓阶段会为这两个候选分别请求现价,若无缓存则请求两次。
    const trades = [
      trade({
        proxyWallet: "w1",
        transactionHash: "h1",
        size: 20000,
        price: 0.5,
        timestamp: 1000,
      }),
      trade({
        proxyWallet: "w2",
        transactionHash: "h2",
        size: 20000,
        price: 0.5,
        timestamp: 1000,
      }),
      trade({
        proxyWallet: "w3",
        transactionHash: "h3",
        size: 20000,
        price: 0.5,
        timestamp: 1000,
      }),
    ];
    let calls = 0;
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades }),
      getSmart: smart3,
      fetchPrice: async () => {
        calls++;
        return 0.55;
      },
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(calls).toBe(1);
    expect(r.opened).toBe(2);
    db.close();
  });

  // 上一条用例只覆盖了「同 asset」命中两次的场景 —— 缓存 key 若漏写 asset(例如
  // 误写成只按 `price:${nowSec}`),同 asset 场景一样能通过(反正只有一个 key,
  // 命中几次都对)。真正能测出漏 asset 的,是两个不同 asset 各开一仓:key 若不
  // 含 asset,第二个 asset 会命中第一个 asset 的缓存条目 —— fetchPrice 对它
  // 恒不调用、且它的 entry_price 会被错误地"串"成第一个 asset 的价格。
  it("不同 asset 各自独立取价,互不串价(缓存 key 必须含 asset)", async () => {
    const db = openDb(":memory:");
    // 两个独立市场(cA/tokA、cB/tokB),各 2 个钱包净买 $6k@0.6 → 都只满足
    // 「激进」(2×$5k);「保守」(3×$10k)钱包数不够,两边都不产生候选。
    const trades = [
      trade({
        proxyWallet: "w1",
        transactionHash: "hA1",
        conditionId: "cA",
        asset: "tokA",
        size: 10000,
        price: 0.6,
        timestamp: 1000,
      }),
      trade({
        proxyWallet: "w2",
        transactionHash: "hA2",
        conditionId: "cA",
        asset: "tokA",
        size: 10000,
        price: 0.6,
        timestamp: 1000,
      }),
      trade({
        proxyWallet: "w1",
        transactionHash: "hB1",
        conditionId: "cB",
        asset: "tokB",
        size: 10000,
        price: 0.6,
        timestamp: 1000,
      }),
      trade({
        proxyWallet: "w2",
        transactionHash: "hB2",
        conditionId: "cB",
        asset: "tokB",
        size: 10000,
        price: 0.6,
        timestamp: 1000,
      }),
    ];
    const calls: Record<string, number> = {};
    const priceByAsset: Record<string, number> = { tokA: 0.61, tokB: 0.58 };
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades }),
      getSmart: smart,
      fetchPrice: async (asset) => {
        calls[asset] = (calls[asset] ?? 0) + 1;
        return priceByAsset[asset];
      },
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    expect(r.opened).toBe(2);
    // 各 asset 各取一次价:key 缺 asset 时,第二个处理到的 asset 会直接命中
    // 第一个的缓存条目,对应的 fetchPrice 调用数会是 0(undefined)而非 1。
    expect(calls.tokA).toBe(1);
    expect(calls.tokB).toBe(1);
    const posA = db
      .prepare(
        "SELECT entry_price FROM follow_positions WHERE condition_id='cA'",
      )
      .get() as { entry_price: number };
    const posB = db
      .prepare(
        "SELECT entry_price FROM follow_positions WHERE condition_id='cB'",
      )
      .get() as { entry_price: number };
    // 精确核对各自应得的价格(而非只判"互不相等")—— 这样即使两者被整体对调
    // (key 冲突的另一种表现形式)也逃不过断言。
    expect(posA.entry_price).toBeCloseTo(0.61);
    expect(posB.entry_price).toBeCloseTo(0.58);
    db.close();
  });
});

// 多 source 集成:注册表按 source 查表分派,天然不会被 params_json 里残留的
// consensus 专属字段(minWallets/minPerWalletUsd)误导。这条测试锁的是 Task 3
// 修掉的真实缺口(修复前实测会静默落一条 strategy_id=heavy 的仓位):当时的临时
// 守卫只判 minWallets/minPerWalletUsd 是否非空,一条 source:"heavy" 但从
// consensus 模板复制粘贴、残留了这两个字段的策略会被误当成 consensus 送进
// detectConsensus。Task 4 的 DETECTORS 注册表按 source 严格查表分派,不检查这
// 两个字段是否存在,从设计上杜绝这类误判,不再依赖一道专门补丁式的守卫。
describe("runFollowCycle — 多 source 集成(注册表按 source 分派)", () => {
  it("heavy 策略残留 consensus 专属字段不会误走共识路径,consensus 策略正常开仓", async () => {
    const db = openDb(":memory:");
    // 模拟运营从 consensus 模板复制粘贴新增 heavy 档,没删干净残留字段
    // (minWallets/minPerWalletUsd),但没抄到 heavy 真正需要的
    // minSingleFillUsd。DETECTORS.heavy 现在是 Task 6 落地的真实实现
    // (detectHeavyCandidates,见 lib/sourceHeavy.ts)—— 这条测试仍然通过,
    // 但通过的原因已经变了:不再是"占位实现恒空",而是注册表按 source 严格
    // 分派到 detectHeavyCandidates 后,该函数发现自己的必需参数
    // minSingleFillUsd 缺失(残留的 minWallets/minPerWalletUsd 对它没有任何
    // 意义,它压根不读这两个字段)—— 按自身的必需参数校验产出空候选 +
    // console.warn,而不是被误当成 consensus 送进 detectConsensus。
    db.prepare(
      "INSERT INTO follow_strategies (name, enabled, params_json, created_at) VALUES (?,1,?,?)",
    ).run(
      "重仓单笔(占位)",
      JSON.stringify({
        source: "heavy",
        minWallets: 2,
        minPerWalletUsd: 5000,
        sizeUsd: 500,
        exitRule: "settlement",
      }),
      1000,
    );
    const trades = [
      trade({
        proxyWallet: "w1",
        transactionHash: "h1",
        size: 10000,
        timestamp: 1000,
      }),
      trade({
        proxyWallet: "w2",
        transactionHash: "h2",
        size: 10000,
        timestamp: 1000,
      }),
    ];
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades }),
      getSmart: smart,
      fetchPrice: async () => 0.63,
      getMeta: async () => ({}),
      nowSec: 1800,
    });
    // 种子「激进」(source 缺省 → consensus)命中并开仓。
    expect(r.opened).toBeGreaterThanOrEqual(1);
    const heavyStrategy = db
      .prepare("SELECT id FROM follow_strategies WHERE name = ?")
      .get("重仓单笔(占位)") as { id: number };
    const heavyPositions = db
      .prepare(
        "SELECT COUNT(*) AS n FROM follow_positions WHERE strategy_id = ?",
      )
      .get(heavyStrategy.id) as { n: number };
    expect(heavyPositions.n).toBe(0);
    db.close();
  });
});

// Task 9:market_tilt_history 跨轮读写的端到端集成 —— 证明"读必须在写之前"
// 这条不变量在真实两轮调用下确实成立:第一轮市场刚变 contested,prevTilt 还
// 是空的(C2 无候选,只写快照);第二轮少数边转净卖、市场跌出 contested,
// C2 靠第一轮写下的快照才能判定"转变"并开仓。若读写顺序反了(写在读之前),
// 第二轮的 prevTilt 会读到的仍是空/或本轮自己的东西,C2 永远不会在这里开仓 ——
// 这条集成测试直接锁死"第一轮不开仓、第二轮才开仓"这个可观察行为。
describe("runFollowCycle — market_tilt_history 跨轮读写(C2 分歧解除,读写顺序核心不变量)", () => {
  it("第一轮 contested 市场只写快照不开仓;第二轮少数边转净卖 → 靠上一轮快照产出候选并开仓", async () => {
    const db = openDb(":memory:");
    // Task 12(策略种子 v2)起,openDb(":memory:") 也会一次性种进全部 12 条
    // 生产策略(含另一条同为 source:"resolved" 的「分歧解除」)。这条用例
    // 断言的是 r1.opened/r2.opened 的精确计数,验证的是 C2 读写顺序这一个
    // 不变量 —— 不该被"生产种子里恰好也有一条 resolved 策略,对同一市场独立
    // 判定出同一个候选"这件事干扰(两条 resolved 策略给的 params 不同名但
    // 判据等价,会各开一仓,把 opened 计数翻倍)。清空自动种入的策略,只留下
    // 下面手工插入的这一条,把测试隔离回"只有这一个 source:resolved 策略"
    // 的场景。
    db.prepare("DELETE FROM follow_strategies").run();
    db.prepare(
      "INSERT INTO follow_strategies (name, enabled, params_json, created_at) VALUES (?,1,?,?)",
    ).run(
      "分歧解除测试档",
      JSON.stringify({
        source: "resolved",
        sizeUsd: 500,
        exitRule: "settlement",
      }),
      900,
    );

    // 第一轮(nowSec=1000):w1 买 Yes $10k(score 80),w2 买 No $10k(score 75)
    // —— 两边都过 $5k floor,市场 contested;quality weight 不同(0.84 vs 0.8)
    // 使 Yes 确定性地成为主导边,不依赖排序平局规则。
    const round1Trades: Trade[] = [
      trade({
        proxyWallet: "w1",
        transactionHash: "r1",
        asset: "tokYes",
        outcome: "Yes",
        outcomeIndex: 0,
        conditionId: "c1",
        size: 20000,
        price: 0.5,
        timestamp: 900,
      }),
      trade({
        proxyWallet: "w2",
        transactionHash: "r2",
        asset: "tokNo",
        outcome: "No",
        outcomeIndex: 1,
        conditionId: "c1",
        size: 20000,
        price: 0.5,
        timestamp: 900,
      }),
    ];
    const r1 = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: round1Trades }),
      getSmart: smart,
      fetchPrice: async () => 0.5,
      getMeta: async () => ({}),
      nowSec: 1000,
    });
    // prevTilt 在第一轮进入 ctx 时必然是空 Map(数据库里还没有任何快照)——
    // resolved 策略这一轮不可能有候选,不该开仓。
    expect(r1.opened).toBe(0);

    // 快照必须已经落库:轮末 write 发生在结算/markout 之后,但早于函数返回。
    const afterRound1 = readMarketTiltSnapshots(db);
    const snap = afterRound1.get("c1");
    expect(snap).toEqual({
      conditionId: "c1",
      leadOutcome: "Yes", // weightedUsd 更大(w1 score 80 > w2 score 75)
      minorOutcome: "No",
      minorNetUsd: 10000,
      tiltPct: 8400 / (8400 + 8000), // Σweighted(Yes) / Σweighted(总)
      ts: 1000,
    });

    // 第二轮(nowSec=2000):窗口沿用第一轮的两笔成交(模拟滚动窗口仍覆盖旧
    // 成交)+ w2 新增一笔卖出 30000@0.4=$12k —— 现金流:buyUsd=10000,
    // sellUsd=12000,卖均价(0.4)<买均价(0.5)→ 满足认输判据(isCapitulating);
    // 同时 netShares=-10000<=0,exposureUsd 被 clamp 到 0,No 边 walletCount
    // 归零,市场本轮不再 contested(sides.length<2)。
    const round2Trades: Trade[] = [
      ...round1Trades,
      trade({
        proxyWallet: "w2",
        transactionHash: "r3",
        side: "SELL",
        asset: "tokNo",
        outcome: "No",
        outcomeIndex: 1,
        conditionId: "c1",
        size: 30000,
        price: 0.4,
        timestamp: 1500,
      }),
    ];
    const r2 = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: round2Trades }),
      getSmart: smart,
      fetchPrice: async () => 0.5,
      getMeta: async () => ({}),
      nowSec: 2000,
    });
    expect(r2.opened).toBe(1); // 恰好一仓:resolved 档跟 Yes,consensus 两档本轮仍不够格

    const strat = db
      .prepare("SELECT id FROM follow_strategies WHERE name = ?")
      .get("分歧解除测试档") as { id: number };
    const positions = db
      .prepare(
        "SELECT condition_id, outcome, formation_ts, entry_price FROM follow_positions WHERE strategy_id = ?",
      )
      .all(strat.id) as {
      condition_id: string;
      outcome: string;
      formation_ts: number;
      entry_price: number;
    }[];
    expect(positions).toHaveLength(1);
    expect(positions[0].condition_id).toBe("c1");
    expect(positions[0].outcome).toBe("Yes"); // 跟主导边,不是转净卖的 No
    expect(positions[0].formation_ts).toBe(2000); // = 第二轮 nowSec,不是任何一笔成交 ts
    expect(positions[0].entry_price).toBeCloseTo(0.5);

    db.close();
  });
});

// 复审 Important 3:对抗测试,专门构造"读写顺序颠倒会给出不同答案"的场景 ——
// 之前那条跨轮集成测试证明不了这一点,因为"本轮被写入"(要求市场仍 contested,
// 少数边净买者子集必须过 floor)与"本轮触发 C2"(要求少数边现金流已满足认输)
// 对同一个 conditionId 结构性互斥:少数边只要还有一个够格的净买者,少数边整体
// 就"仍 contested"会被写入,但该净买者的存在不妨碍*其它*钱包的巨额卖出把
// 现金流聚合拖成"已认输" —— 这正是本用例构造的东西,两个条件在同一市场、
// 同一轮里可以同时成立。
describe("runFollowCycle — market_tilt_history 读写顺序对抗测试(mutation-tested,复审 Important 3)", () => {
  const smartThreeWallets = (): Map<string, SmartTag> =>
    new Map([
      ["w1", { score: 90, winRate: 0.7, netPnl: 1, isWhitelist: true }], // Yes 边:score 更高,确定性地成为主导边
      ["w2", { score: 80, winRate: 0.65, netPnl: 1, isWhitelist: true }], // No 边:唯一的净买者,单独就能让 No 边过 floor
      ["w3", { score: 80, winRate: 0.65, netPnl: 1, isWhitelist: true }], // No 边:买一点、卖很多,net<=0 不进 netUsd,但现金流把 No 边拖成"已认输"
    ]);

  it("市场首次变 contested:少数边净买者子集够格入选(会被写入),但少数边现金流本轮已满足认输 —— 正确顺序(读在写之前)不产出虚假候选", async () => {
    const db = openDb(":memory:");
    // Task 12(策略种子 v2)起,openDb(":memory:") 也会一次性种进全部 12 条
    // 生产策略。这条用例断言 r.opened 精确等于 0,验证的是"prevTilt 首次
    // 观察必为空"这一个不变量 —— 但下面构造的 trades 里 w1(score 90)单独
    // 净买 Yes $10k,同时满足生产种子「高分独狼」(lone_wolf,score>=90 且
    // net>=$10k)的判据,且 D 族不受分歧互斥约束(见 lib/sourceWallet.ts),
    // 会在与本测试意图无关的另一条策略上开出 1 仓,把 r.opened 从 0 污染成
    // 1。清空自动种入的策略,只留下面手工插入的这一条,把测试隔离回"只有
    // 这一个 source:resolved 策略"的场景。
    db.prepare("DELETE FROM follow_strategies").run();
    db.prepare(
      "INSERT INTO follow_strategies (name, enabled, params_json, created_at) VALUES (?,1,?,?)",
    ).run(
      "读写顺序对抗测试档",
      JSON.stringify({
        source: "resolved",
        sizeUsd: 500,
        exitRule: "settlement",
      }),
      900,
    );

    const trades: Trade[] = [
      // Yes(lead):w1 买 $10k,健康,score 90(weightedUsd=10000×0.92=9200)。
      trade({
        proxyWallet: "w1",
        transactionHash: "b1",
        asset: "tokYes",
        outcome: "Yes",
        outcomeIndex: 0,
        conditionId: "cFirst",
        size: 20000,
        price: 0.5,
        timestamp: 900,
      }),
      // No(minor)钳位口径够格入选的净买者:w2 买 $10k,不卖 —— 单独这一笔就让
      // No 边过 $5k floor(walletCount=1,netUsd=10000,score 80,
      // weightedUsd=8400<9200,No 确定是 minor 不是 lead)。
      trade({
        proxyWallet: "w2",
        transactionHash: "b2",
        asset: "tokNo",
        outcome: "No",
        outcomeIndex: 1,
        conditionId: "cFirst",
        size: 20000,
        price: 0.5,
        timestamp: 900,
      }),
      // No 边另一个钱包 w3:买一点(exposureUsd 仍为正,不影响判定)、卖很多——
      // netShares=1000-100000=-99000<=0,exposureUsd 被 clamp 到 0,不进
      // No 边的 netUsd/walletCount(No 边"够格"完全靠 w2 一个人撑住)。但它的
      // buyUsd/sellUsd 现金流贡献不受这道 clamp 影响,把 No 边的现金流聚合拖成
      // sellUsd(40000)>buyUsd(10500) 且卖均价(0.4)<买均价(0.5)——本轮就已经
      // 满足认输判据 isCapitulating。
      trade({
        proxyWallet: "w3",
        transactionHash: "b3",
        asset: "tokNo",
        outcome: "No",
        outcomeIndex: 1,
        conditionId: "cFirst",
        size: 1000,
        price: 0.5,
        timestamp: 900,
      }),
      trade({
        proxyWallet: "w3",
        transactionHash: "b4",
        side: "SELL",
        asset: "tokNo",
        outcome: "No",
        outcomeIndex: 1,
        conditionId: "cFirst",
        size: 100000,
        price: 0.4,
        timestamp: 950,
      }),
    ];

    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades }),
      getSmart: smartThreeWallets,
      fetchPrice: async () => 0.5,
      getMeta: async () => ({}),
      nowSec: 1000,
    });

    // 库里此前没有任何 market_tilt_history 记录(:memory: 全新库,首次观察)——
    // 正确顺序下 ctx.prevTilt 读到空 Map,resolved 策略这一轮不可能有候选,
    // 即便"cFirst"本轮同时满足"够格入选 contested"与"少数边现金流已认输"
    // 这两个条件。
    expect(r.opened).toBe(0);

    // 快照仍然正常落库(轮末写,不受读的结果影响)——下一轮才轮到它被读到。
    const snap = readMarketTiltSnapshots(db).get("cFirst");
    expect(snap?.leadOutcome).toBe("Yes");
    expect(snap?.minorOutcome).toBe("No");

    db.close();
  });

  // 变异验证(手工执行,不作为常驻用例保留):把上面 it 块里 runFollowCycle 的
  // 调用临时替换成"先写后读"—— 在 lib/follow.ts 的 readMarketTiltSnapshots(db)
  // 调用之前临时插入一行 writeMarketTiltSnapshots(db, contested, nowSec),
  // 模拟"写在读之前"的错误顺序,重跑本文件:上面这条用例从 r.opened===0
  // 变为 r.opened===1(读到了本轮自己刚写的行,把"当前状态"误认成"上一轮
  // 状态",凭空产出 1 个虚假候选)。验证完成后已还原 lib/follow.ts,不保留
  // 这个临时改动 —— 这条注释只记录验证过程,供复核。
});

// Task 11:D2(early_winner)钱包预取的端到端集成 —— 证明 runFollowCycle 真的
// 从 wallet_candidates 表读出 channel='early_winner' 的地址喂给 ctx,以及
// 查询失败时的降级不拖累同轮其它策略。detector 内部判据(净买门槛/跨线语义/
// MM 剔除/新鲜度/折叠规则)已在 lib/sourceWallet.test.ts 覆盖,这里只测预取
// 这一层「读表 → 填 ctx → detector 真的用上了」的接线是否正确。
describe("runFollowCycle — D2(early_winner)钱包预取", () => {
  it("wallet_candidates 有 early_winner 渠道的行 → 能读到,D2 策略据此开仓;非 early_winner 渠道的行不算数", async () => {
    const db = openDb(":memory:");
    // Task 12(策略种子 v2)起,openDb(":memory:") 会自动种入一条同名的生产
    // 策略「早期赢家跟投」—— 下面这条 INSERT 若不先清场会直接撞
    // follow_strategies.name 的 UNIQUE 约束报错。这条用例只关心它自己插入
    // 的这一条(后面按名字查 strat.id 精确 scoped 查询,不受其它策略干扰),
    // 清空自动种入的策略,腾出这个名字,也避免其它生产策略在同一批 trades
    // 上产出无关候选。
    db.prepare("DELETE FROM follow_strategies").run();
    db.prepare(
      "INSERT INTO follow_strategies (name, enabled, params_json, created_at) VALUES (?,1,?,?)",
    ).run(
      "早期赢家跟投",
      JSON.stringify({
        source: "early_winner",
        minNetUsd: 5000,
        sizeUsd: 500,
        exitRule: "settlement",
      }),
      1000,
    );
    // w1:channel='early_winner',应当入选。w2:channel='echo'(其它渠道),
    // 即使也有一笔够格的净买,也不该被 D2 当作渠道成员。
    db.prepare(
      `INSERT INTO wallet_candidates
         (address, channel, condition_id, evidence_ts, usd, price, note, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run("w1", "early_winner", "cSomeMarket", 900, 1000, 0.5, "note", 900);
    db.prepare(
      `INSERT INTO wallet_candidates
         (address, channel, condition_id, evidence_ts, usd, price, note, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run("w2", "echo", "cSomeMarket", 900, 1000, 0.5, "note", 900);

    const trades = [
      // w1(early_winner 成员):净买 $6,000 >= minNetUsd(5000)→ 应当开仓。
      trade({
        proxyWallet: "w1",
        transactionHash: "hEW1",
        conditionId: "cD2a",
        asset: "tokD2a",
        size: 10000,
        price: 0.6,
        timestamp: 1000,
      }),
      // w2(echo 成员,非 early_winner):同样净买 $6,000,但不该被 D2 开仓。
      trade({
        proxyWallet: "w2",
        transactionHash: "hEW2",
        conditionId: "cD2b",
        asset: "tokD2b",
        size: 10000,
        price: 0.6,
        timestamp: 1000,
      }),
    ];

    await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades }),
      getSmart: smart, // w1/w2 都在白名单里(见文件头 smart() 工厂)
      fetchPrice: async () => 0.6,
      getMeta: async () => ({}),
      nowSec: 1500, // 距 formationTs(1000)500s <= freshSec 默认 900,新鲜
    });

    const strat = db
      .prepare("SELECT id FROM follow_strategies WHERE name = ?")
      .get("早期赢家跟投") as { id: number };
    const positions = db
      .prepare(
        "SELECT condition_id FROM follow_positions WHERE strategy_id = ?",
      )
      .all(strat.id) as { condition_id: string }[];
    expect(positions).toHaveLength(1);
    expect(positions[0].condition_id).toBe("cD2a"); // w1 的市场,不是 w2 的
    db.close();
  });

  it("wallet_candidates 查询抛错 → 预取降级为空 Set,D2 本轮无候选,不影响同轮其它策略", async () => {
    const db = openDb(":memory:");
    // 破坏表本身,模拟"查询抛错"这个极端场景(而不是 mock db.prepare ——
    // 直接损坏真实表,断言的是 runFollowCycle 面对真实 SQL 异常时的行为)。
    // 用 .prepare(...).run() 而非 .exec(...) 执行 DDL,与 lib/db.ts 里
    // ALTER TABLE 等既有 DDL 语句同一套写法。
    db.prepare("DROP TABLE wallet_candidates").run();

    // Task 12(策略种子 v2)起,openDb(":memory:") 会自动种入一条同名的生产
    // 策略「早期赢家跟投」—— 下面这条 INSERT 若不先让出这个名字会直接撞
    // follow_strategies.name 的 UNIQUE 约束报错。注意这里只删这一条同名的,
    // 不是清空全表(DELETE FROM follow_strategies 不加 WHERE):本用例下面
    // 的断言明确依赖种子自带的「激进」consensus 策略仍然存在且启用(见下面
    // "种子自带的「激进」consensus 策略"那条注释与 consensusPos 断言)。
    db.prepare(
      "DELETE FROM follow_strategies WHERE name = '早期赢家跟投'",
    ).run();
    db.prepare(
      "INSERT INTO follow_strategies (name, enabled, params_json, created_at) VALUES (?,1,?,?)",
    ).run(
      "早期赢家跟投",
      JSON.stringify({
        source: "early_winner",
        minNetUsd: 5000,
        sizeUsd: 500,
        exitRule: "settlement",
      }),
      1000,
    );

    const trades = [
      // 同轮内还有一组正常的 2 钱包共识(w1+w2 各净买 $6k)—— 用来证明
      // early_winner 预取失败不会拖垮同轮其它 source 的策略(种子自带的
      // "激进" consensus 策略:2 钱包 × $5k)。
      trade({
        proxyWallet: "w1",
        transactionHash: "hC1",
        conditionId: "cConsensus",
        asset: "tokConsensus",
        size: 10000,
        price: 0.6,
        timestamp: 1000,
      }),
      trade({
        proxyWallet: "w2",
        transactionHash: "hC2",
        conditionId: "cConsensus",
        asset: "tokConsensus",
        size: 10000,
        price: 0.6,
        timestamp: 1000,
      }),
      // 若预取没有正确降级(比如异常没被兜住导致整轮 reject),这笔本该被
      // D2 开仓的交易也能反证:D2 本该产出候选但降级后必须是 0。
      trade({
        proxyWallet: "w1",
        transactionHash: "hEW",
        conditionId: "cD2",
        asset: "tokD2",
        size: 10000,
        price: 0.6,
        timestamp: 1000,
      }),
    ];

    // 不 reject 整轮:预取失败被 runFollowCycle 内部 try/catch 兜住。
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades }),
      getSmart: smart,
      fetchPrice: async () => 0.6,
      getMeta: async () => ({}),
      nowSec: 1500,
    });

    // 激进(consensus)策略照常开仓 —— early_winner 预取失败不影响它。
    expect(r.opened).toBeGreaterThanOrEqual(1);
    const consensusPos = db
      .prepare(
        "SELECT 1 FROM follow_positions WHERE condition_id = 'cConsensus'",
      )
      .all();
    expect(consensusPos.length).toBeGreaterThanOrEqual(1);

    // early_winner 策略本轮无候选(earlyWinnerWallets 降级为空 Set)。
    const strat = db
      .prepare("SELECT id FROM follow_strategies WHERE name = ?")
      .get("早期赢家跟投") as { id: number };
    const ewPos = db
      .prepare(
        "SELECT 1 FROM follow_positions WHERE strategy_id = ? AND condition_id = 'cD2'",
      )
      .all(strat.id);
    expect(ewPos).toHaveLength(0);
    db.close();
  });
});

/* ------------------------------------------------- 反向对照档(reverse) */
// 设计:docs/plans/2026-08-13-reverse-control-design.md §3-§4。测试自建策略行
// 并停用全部种子档 —— 反向语义的断言(方向/镜像基准/配对结算)必须与种子
// 内容解耦,种子归 follow.db.test.ts 管。
describe("runFollowCycle 反向对照档", () => {
  // 完整 MarketMeta(本 describe 专用桩):Yes/No 二元市场 c1,token 对齐
  // trades 桩的 asset("tok" = Yes 侧)。
  const rmeta = (over: Partial<MarketMeta> = {}): MarketMeta => ({
    conditionId: "c1",
    closed: false,
    outcomePrices: [0.6, 0.4],
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
    ...over,
  });

  // 停用全部种子档,插入一对镜像 heavy 档(检测参数逐字节相同,仅 reverse
  // 分叉),返回两个 id。种子档若保持启用,同一笔巨鲸单会让「巨鲸」等档也
  // 开仓,污染本组按 strategy_id 的隔离断言。
  const insertPair = (db: ReturnType<typeof openDb>) => {
    db.prepare("UPDATE follow_strategies SET enabled = 0").run();
    const ins = db.prepare(
      "INSERT INTO follow_strategies (name, enabled, params_json, created_at) VALUES (?,1,?,0)",
    );
    const fwd = ins.run(
      "T-巨鲸",
      JSON.stringify({
        source: "heavy",
        minSingleFillUsd: 50000,
        sizeUsd: 500,
      }),
    ).lastInsertRowid as number;
    const rev = ins.run(
      "T-反巨鲸",
      JSON.stringify({
        source: "heavy",
        reverse: true,
        minSingleFillUsd: 50000,
        sizeUsd: 500,
      }),
    ).lastInsertRowid as number;
    return { fwd, rev };
  };

  // 单笔巨鲸 BUY:notional = 100000 × 0.6 = $60k ≥ $50k 门槛。
  const whaleTrades = () => [
    trade({
      proxyWallet: "w1",
      transactionHash: "h1",
      size: 100000,
      price: 0.6,
    }),
  ];

  // 现价按 asset 分派:Yes 侧 0.62、No 侧 0.38(镜像基准 0.4 的 2¢ 偏离内)。
  const priceByAsset = async (asset: string) =>
    asset === "tok" ? 0.62 : asset === "tok-no" ? 0.38 : null;

  it("反向档开对面仓:outcome/asset/index 翻转,entry 取对面现价,smart_avg_price 是镜像基准", async () => {
    const db = openDb(":memory:");
    const { fwd, rev } = insertPair(db);
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: whaleTrades() }),
      getSmart: smart,
      fetchPrice: priceByAsset,
      getMeta: async () => ({ c1: rmeta() }),
      nowSec: 1800,
    });
    expect(r.opened).toBe(2);
    const fp = db
      .prepare("SELECT * FROM follow_positions WHERE strategy_id = ?")
      .get(fwd) as Record<string, unknown>;
    const rp = db
      .prepare("SELECT * FROM follow_positions WHERE strategy_id = ?")
      .get(rev) as Record<string, unknown>;
    // 正向档:巨鲸的同边。
    expect(fp.outcome).toBe("Yes");
    expect(fp.asset).toBe("tok");
    expect(fp.outcome_index).toBe(0);
    expect(fp.entry_price).toBe(0.62);
    expect(fp.smart_avg_price).toBeCloseTo(0.6);
    // 反向档:同一笔信号的对面。entry 是对面自己的现价(不是 1−0.62 的近似),
    // smart_avg_price 是镜像成本基准 1−0.6。
    expect(rp.outcome).toBe("No");
    expect(rp.asset).toBe("tok-no");
    expect(rp.outcome_index).toBe(1);
    expect(rp.entry_price).toBe(0.38);
    expect(rp.smart_avg_price).toBeCloseTo(0.4);
    // 对照的时刻纪律:两仓 formation_ts 完全相同(同一信号)。
    expect(rp.formation_ts).toBe(fp.formation_ts);
    db.close();
  });

  it("配对结算:Yes 结算 1 → 正向赢、反向输,退出价各用自己的 outcome_index", async () => {
    const db = openDb(":memory:");
    const { fwd, rev } = insertPair(db);
    const open = { trades: whaleTrades() };
    await runFollowCycle({
      db,
      fetchWindow: async () => open,
      getSmart: smart,
      fetchPrice: priceByAsset,
      getMeta: async () => ({ c1: rmeta() }),
      nowSec: 1800,
    });
    // 第二轮:市场结算为 Yes(outcomePrices [1,0]),两仓同时平。
    const r2 = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: [] }),
      getSmart: smart,
      fetchPrice: priceByAsset,
      getMeta: async () => ({
        c1: rmeta({ closed: true, outcomePrices: [1, 0] }),
      }),
      nowSec: 3600,
    });
    expect(r2.settled).toBe(2);
    const fp = db
      .prepare("SELECT * FROM follow_positions WHERE strategy_id = ?")
      .get(fwd) as Record<string, unknown>;
    const rp = db
      .prepare("SELECT * FROM follow_positions WHERE strategy_id = ?")
      .get(rev) as Record<string, unknown>;
    // 正向:exit = outcomePrices[0] = 1,盈利 shares×(1−0.62)。
    expect(fp.exit_price).toBe(1);
    expect(fp.realized_pnl as number).toBeGreaterThan(0);
    // 反向:exit = outcomePrices[1] = 0,整仓亏光 −500。
    expect(rp.exit_price).toBe(0);
    expect(rp.realized_pnl as number).toBeCloseTo(-500);
    // 配对语义:同一信号恰好一赢一输。
    db.close();
  });

  it("幂等:同一信号第二轮不给反向档重复开仓(查重键用翻转后的 outcome)", async () => {
    const db = openDb(":memory:");
    const { rev } = insertPair(db);
    const deps = {
      db,
      fetchWindow: async () => ({ trades: whaleTrades() }),
      getSmart: smart,
      fetchPrice: priceByAsset,
      getMeta: async () => ({ c1: rmeta() }),
      nowSec: 1800,
    };
    await runFollowCycle(deps);
    const r2 = await runFollowCycle(deps);
    expect(r2.opened).toBe(0);
    const rows = db
      .prepare("SELECT 1 FROM follow_positions WHERE strategy_id = ?")
      .all(rev);
    expect(rows).toHaveLength(1);
    db.close();
  });

  it("meta 缺失 → 反向档 fail-closed 弃权,同轮正向档照常开(缺失≠已结算)", async () => {
    const db = openDb(":memory:");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { fwd, rev } = insertPair(db);
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: whaleTrades() }),
      getSmart: smart,
      fetchPrice: priceByAsset,
      getMeta: async () => ({}), // meta 拿不到:正向视为「状态未知」照开,反向翻不了边
      nowSec: 1800,
    });
    expect(r.opened).toBe(1);
    expect(
      db
        .prepare("SELECT 1 FROM follow_positions WHERE strategy_id = ?")
        .all(fwd),
    ).toHaveLength(1);
    expect(
      db
        .prepare("SELECT 1 FROM follow_positions WHERE strategy_id = ?")
        .all(rev),
    ).toHaveLength(0);
    // 弃权必须留痕且带原因(调试第一问:反向档这轮为什么没开)。
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("反向"));
    logSpy.mockRestore();
    db.close();
  });

  it("3-way 市场 → 反向档弃权(「买对面」不良定义),正向档不受影响", async () => {
    const db = openDb(":memory:");
    const { fwd, rev } = insertPair(db);
    const r = await runFollowCycle({
      db,
      fetchWindow: async () => ({ trades: whaleTrades() }),
      getSmart: smart,
      fetchPrice: priceByAsset,
      getMeta: async () => ({
        c1: rmeta({
          outcomes: ["A", "B", "C"],
          outcomePrices: [0.5, 0.3, 0.2],
          clobTokenIds: ["tok", "t2", "t3"],
        }),
      }),
      nowSec: 1800,
    });
    expect(r.opened).toBe(1);
    expect(
      db
        .prepare("SELECT 1 FROM follow_positions WHERE strategy_id = ?")
        .all(fwd),
    ).toHaveLength(1);
    expect(
      db
        .prepare("SELECT 1 FROM follow_positions WHERE strategy_id = ?")
        .all(rev),
    ).toHaveLength(0);
    db.close();
  });
});
