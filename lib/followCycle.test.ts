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
      volume24hr: null,
      liquidity: null,
      endDate: null,
      category: null,
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
