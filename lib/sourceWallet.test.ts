import { describe, it, expect, vi } from "vitest";
import {
  detectEarlyWinnerCandidates,
  detectLoneWolfCandidates,
} from "./sourceWallet";
import type { DetectorCtx, StrategyParams } from "./followCandidate";
import type { SmartTag } from "./smartWallets";
import type { Trade } from "./types";

// 与 sourceHeavy.test.ts / sourceLopsided.test.ts 同一套 fixture 写法。
const mk = (over: Partial<Trade> = {}): Trade =>
  ({
    transactionHash: `0xtx${Math.random().toString(36).slice(2, 8)}`,
    asset: "asset1",
    proxyWallet: "0xW1",
    side: "BUY",
    size: 20000,
    price: 0.5,
    timestamp: 1000,
    title: "Market Title",
    slug: "market-slug",
    eventSlug: "event-slug",
    outcome: "Yes",
    outcomeIndex: 0,
    conditionId: "0xc",
    ...over,
  }) as Trade;

const tag = (over: Partial<SmartTag> = {}): SmartTag => ({
  score: 95,
  winRate: 0.7,
  netPnl: 100_000,
  isWhitelist: false,
  ...over,
});

const ctx = (over: Partial<DetectorCtx> = {}): DetectorCtx => ({
  smart: new Map([
    ["0xa", tag()],
    ["0xb", tag()],
  ]),
  // mk() 默认 timestamp=1000,params() 默认 freshSec=900 —— nowSec 必须落在
  // [1000, 1900] 内默认组合才是"新鲜"的,取 1500(与其它 detector 测试同一个
  // 已验证自洽的组合)。
  nowSec: 1500,
  contested: [],
  earlyWinnerWallets: new Set(),
  prevTilt: new Map(),
  ...over,
});

const loneWolfParams = (
  over: Partial<StrategyParams> = {},
): StrategyParams => ({
  id: 1,
  source: "lone_wolf",
  sizeUsd: 500,
  exitRule: "settlement",
  maxEntryDeviationCents: 10,
  maxPrice: 0.95,
  freshSec: 900,
  minNetUsd: 10_000,
  minWalletScore: 90,
  ...over,
});

const earlyWinnerParams = (
  over: Partial<StrategyParams> = {},
): StrategyParams => ({
  id: 2,
  source: "early_winner",
  sizeUsd: 500,
  exitRule: "settlement",
  maxEntryDeviationCents: 10,
  maxPrice: 0.95,
  freshSec: 900,
  minNetUsd: 5_000,
  ...over,
});

describe("detectLoneWolfCandidates", () => {
  it("单钱包净买 >= minNetUsd 且 score >= minWalletScore → 一个候选(12 个字段全部核对)", () => {
    const trades = [
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x1",
        size: 20000,
        price: 0.5, // $10,000 notional,恰好等于净买门槛
        timestamp: 1000,
      }),
    ];
    const out = detectLoneWolfCandidates(trades, loneWolfParams(), ctx());
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.conditionId).toBe("0xc");
    expect(c.outcome).toBe("Yes");
    expect(c.outcomeIndex).toBe(0);
    expect(c.asset).toBe("asset1");
    expect(c.title).toBe("Market Title");
    expect(c.slug).toBe("market-slug");
    expect(c.eventSlug).toBe("event-slug");
    // formationTs = 该钱包净买跨过门槛的那一刻(唯一一笔,即那笔的 timestamp)。
    expect(c.formationTs).toBe(1000);
    // referencePrice = 该钱包的 avgBuyPrice(它自己的成本基准)。
    expect(c.referencePrice).toBeCloseTo(0.5);
    expect(c.sourceKind).toBe("lone_wolf");
    expect(c.walletCount).toBe(1);
    expect(c.totalNetUsd).toBeCloseTo(10_000);
  });

  it("score 不够(50 < 90)→ 无候选", () => {
    const smart = new Map([["0xa", tag({ score: 50 })]]);
    const out = detectLoneWolfCandidates(
      [mk({ proxyWallet: "0xA", size: 40000, price: 0.5 })], // $20k,净买绰绰有余
      loneWolfParams(),
      ctx({ smart }),
    );
    expect(out).toHaveLength(0);
  });

  it("score 为 null(未知)视为不达标 —— 与 A3/B3 同纪律", () => {
    const smart = new Map([["0xa", tag({ score: null })]]);
    const out = detectLoneWolfCandidates(
      [mk({ proxyWallet: "0xA", size: 40000, price: 0.5 })],
      loneWolfParams(),
      ctx({ smart }),
    );
    expect(out).toHaveLength(0);
  });

  it("score 恰好等于阈值(90)→ 达标(边界含等号)", () => {
    const smart = new Map([["0xa", tag({ score: 90 })]]);
    const out = detectLoneWolfCandidates(
      [mk({ proxyWallet: "0xA", size: 40000, price: 0.5 })],
      loneWolfParams(),
      ctx({ smart }),
    );
    expect(out).toHaveLength(1);
  });

  it("做市商钱包不算(isMarketMaker:true,与 consensus/heavy 同纪律)", () => {
    const smart = new Map([["0xa", tag({ isMarketMaker: true })]]);
    const out = detectLoneWolfCandidates(
      [mk({ proxyWallet: "0xA", size: 40000, price: 0.5 })],
      loneWolfParams(),
      ctx({ smart }),
    );
    expect(out).toHaveLength(0);
  });

  it("非白名单钱包不算", () => {
    const out = detectLoneWolfCandidates(
      // ctx() 默认白名单只有 0xa/0xb,0xSTRANGER 不在其中。
      [mk({ proxyWallet: "0xSTRANGER", size: 40000, price: 0.5 })],
      loneWolfParams(),
      ctx(),
    );
    expect(out).toHaveLength(0);
  });

  it("净卖不算(净股数口径,不是现金流口径):等股买卖不同价的假净买必须读出 0", () => {
    // 买 20000 股 @0.75($15,000),卖 20000 股 @0.25($5,000):
    // 现金流口径 buyUsd-sellUsd = +$10,000(若用这个口径,恰好达标,是本项目
    // 付出过代价的 bug——netPosition.ts 文件头注释记录的同一个坑);
    // 净股数口径 netShares=0 → exposureUsd=0,远低于 $10k 门槛,不应产出候选。
    const trades = [
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x1",
        side: "BUY",
        size: 20000,
        price: 0.75,
        timestamp: 1000,
      }),
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x2",
        side: "SELL",
        size: 20000,
        price: 0.25,
        timestamp: 1100,
      }),
    ];
    const out = detectLoneWolfCandidates(trades, loneWolfParams(), ctx());
    expect(out).toHaveLength(0);
  });

  it("不受分歧互斥约束:contested 市场里照样产出候选(与族 B 同,D6 裁决)", () => {
    const out = detectLoneWolfCandidates(
      [mk({ proxyWallet: "0xA", size: 40000, price: 0.5 })],
      loneWolfParams(),
      // 该市场(conditionId "0xc")在 contested 列表里 —— A 族会把它整个剔除,
      // lone_wolf 不受这条约束,必须照样产出候选。
      ctx({ contested: [{ conditionId: "0xc" }] as never }),
    );
    expect(out).toHaveLength(1);
  });

  it("新鲜度闸门照常生效", () => {
    const out = detectLoneWolfCandidates(
      [mk({ proxyWallet: "0xA", size: 40000, price: 0.5, timestamp: 1000 })],
      loneWolfParams(),
      // nowSec - formationTs = 99_000,远超 freshSec(900)。
      ctx({ nowSec: 100_000 }),
    );
    expect(out).toHaveLength(0);
  });

  it("跨门槛时刻:last-upward-crossing,含中途跌回再跨则覆盖(借鉴 ConsensusWallet.qualifiedTs)", () => {
    // 全程价格恒 0.5,聚焦纯粹的跨线时序,不与均价计算耦合。floor=$10,000。
    const trades = [
      // t=100: 买 $6,000 → 净买 $6,000,未跨线。
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x1",
        side: "BUY",
        size: 12000,
        price: 0.5,
        timestamp: 100,
      }),
      // t=200: 再买 $6,000 → 净买 $12,000,首次跨线(第一次 crossTs=200)。
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x2",
        side: "BUY",
        size: 12000,
        price: 0.5,
        timestamp: 200,
      }),
      // t=300: 卖 $4,000 → 净买 $8,000,跌回线下(不产生新的 crossTs)。
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x3",
        side: "SELL",
        size: 8000,
        price: 0.5,
        timestamp: 300,
      }),
      // t=400: 再买 $3,000 → 净买 $11,000,二次跨线,crossTs 覆盖为 400。
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x4",
        side: "BUY",
        size: 6000,
        price: 0.5,
        timestamp: 400,
      }),
    ];
    const out = detectLoneWolfCandidates(
      trades,
      loneWolfParams(),
      ctx({ nowSec: 500 }), // 500-400=100 <= freshSec 900,新鲜
    );
    expect(out).toHaveLength(1);
    // 关键断言:formationTs 必须是"最后一次"跨线(400),不是"第一次"(200)。
    // 若实现误用第一次跨线,这里会读到 200 而不是 400。
    expect(out[0].formationTs).toBe(400);
    expect(out[0].totalNetUsd).toBeCloseTo(11_000);
  });

  it("同一钱包在同一 (市场,方向) 只产出一个候选(多笔累加成一个)", () => {
    const trades = [
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x1",
        size: 12000,
        price: 0.5, // $6,000
        timestamp: 100,
      }),
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x2",
        size: 12000,
        price: 0.5, // $6,000,合计 $12,000
        timestamp: 200,
      }),
    ];
    const out = detectLoneWolfCandidates(
      trades,
      loneWolfParams(),
      ctx({ nowSec: 300 }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].totalNetUsd).toBeCloseTo(12_000);
  });

  it("同一 (市场,方向) 多个够格钱包 → 折叠成一个候选,取净买最大的那个钱包(不是最早跨线的)", () => {
    const trades = [
      // 0xA:t=100 更早跨线,但净买更小($15,000)。
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x1",
        size: 25000,
        price: 0.6, // $15,000
        timestamp: 100,
      }),
      // 0xB:t=200 更晚跨线,但净买更大($30,000)——应当是它中选。
      mk({
        proxyWallet: "0xB",
        transactionHash: "0x2",
        size: 75000,
        price: 0.4, // $30,000
        timestamp: 200,
      }),
    ];
    const out = detectLoneWolfCandidates(
      trades,
      loneWolfParams(),
      ctx({ nowSec: 300 }),
    );
    expect(out).toHaveLength(1); // 两个钱包折叠成一个候选,不是两个
    expect(out[0].totalNetUsd).toBeCloseTo(30_000); // 0xB 的净买
    expect(out[0].formationTs).toBe(200); // 0xB 自己的跨线时刻,不是 0xA 的 100
    expect(out[0].referencePrice).toBeCloseTo(0.4); // 0xB 自己的均价,不是 0xA 的 0.6,也不是混合值
  });

  it("不同市场(conditionId 不同)各自独立产出候选,不会被错误合并", () => {
    const out = detectLoneWolfCandidates(
      [
        mk({
          proxyWallet: "0xA",
          transactionHash: "0x1",
          conditionId: "0xc1",
          size: 40000,
          price: 0.5,
        }),
        mk({
          proxyWallet: "0xB",
          transactionHash: "0x2",
          conditionId: "0xc2",
          size: 40000,
          price: 0.5,
        }),
      ],
      loneWolfParams(),
      ctx(),
    );
    expect(out).toHaveLength(2);
  });

  it("参数缺失(minNetUsd undefined)→ 空候选,不抛错", () => {
    const trades = [mk({ proxyWallet: "0xA", size: 40000, price: 0.5 })];
    expect(() =>
      detectLoneWolfCandidates(
        trades,
        loneWolfParams({ minNetUsd: undefined }),
        ctx(),
      ),
    ).not.toThrow();
    const out = detectLoneWolfCandidates(
      trades,
      loneWolfParams({ minNetUsd: undefined }),
      ctx(),
    );
    expect(out).toHaveLength(0);
  });

  it("参数缺失(minWalletScore undefined)→ 空候选,不抛错", () => {
    const trades = [mk({ proxyWallet: "0xA", size: 40000, price: 0.5 })];
    expect(() =>
      detectLoneWolfCandidates(
        trades,
        loneWolfParams({ minWalletScore: undefined }),
        ctx(),
      ),
    ).not.toThrow();
    const out = detectLoneWolfCandidates(
      trades,
      loneWolfParams({ minWalletScore: undefined }),
      ctx(),
    );
    expect(out).toHaveLength(0);
  });

  it("参数非法(minNetUsd<=0)→ 空候选,不抛错", () => {
    const out = detectLoneWolfCandidates(
      [mk({ proxyWallet: "0xA", size: 40000, price: 0.5 })],
      loneWolfParams({ minNetUsd: 0 }),
      ctx(),
    );
    expect(out).toHaveLength(0);
  });
});

describe("detectEarlyWinnerCandidates", () => {
  it("属于 ctx.earlyWinnerWallets 的钱包 → 产出候选,即使 score 很低(与 D1 的关键区别)", () => {
    const smart = new Map([["0xa", tag({ score: 10 })]]); // 远低于任何合理的 minWalletScore
    const out = detectEarlyWinnerCandidates(
      [mk({ proxyWallet: "0xA", size: 20000, price: 0.5 })], // $10,000 net
      earlyWinnerParams(),
      ctx({ smart, earlyWinnerWallets: new Set(["0xa"]) }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].sourceKind).toBe("early_winner");
    expect(out[0].totalNetUsd).toBeCloseTo(10_000);
  });

  it("属于 ctx.earlyWinnerWallets 的钱包 → 产出候选,即使 score 为 null", () => {
    const smart = new Map([["0xa", tag({ score: null })]]);
    const out = detectEarlyWinnerCandidates(
      [mk({ proxyWallet: "0xA", size: 20000, price: 0.5 })],
      earlyWinnerParams(),
      ctx({ smart, earlyWinnerWallets: new Set(["0xa"]) }),
    );
    expect(out).toHaveLength(1);
  });

  it("不在 earlyWinnerWallets 集合里的钱包 → 无候选(即使 score 很高)", () => {
    const smart = new Map([["0xa", tag({ score: 99 })]]);
    const out = detectEarlyWinnerCandidates(
      [mk({ proxyWallet: "0xA", size: 20000, price: 0.5 })],
      earlyWinnerParams(),
      // earlyWinnerWallets 里没有 0xa —— 高分不能替代渠道成员资格。
      ctx({ smart, earlyWinnerWallets: new Set(["0xother"]) }),
    );
    expect(out).toHaveLength(0);
  });

  it("earlyWinnerWallets 为空集(预取失败的降级态)→ 无候选,不抛错", () => {
    const smart = new Map([["0xa", tag({ score: 99 })]]);
    const trades = [mk({ proxyWallet: "0xA", size: 20000, price: 0.5 })];
    expect(() =>
      detectEarlyWinnerCandidates(
        trades,
        earlyWinnerParams(),
        ctx({ smart, earlyWinnerWallets: new Set() }),
      ),
    ).not.toThrow();
    const out = detectEarlyWinnerCandidates(
      trades,
      earlyWinnerParams(),
      ctx({ smart, earlyWinnerWallets: new Set() }),
    );
    expect(out).toHaveLength(0);
  });

  it("做市商钱包不算,即使属于 earlyWinnerWallets(MM 剔除与 D1 共享同一道闸)", () => {
    const smart = new Map([["0xa", tag({ isMarketMaker: true })]]);
    const out = detectEarlyWinnerCandidates(
      [mk({ proxyWallet: "0xA", size: 20000, price: 0.5 })],
      earlyWinnerParams(),
      ctx({ smart, earlyWinnerWallets: new Set(["0xa"]) }),
    );
    expect(out).toHaveLength(0);
  });

  it("非白名单钱包不算,即使属于 earlyWinnerWallets(必须先有 SmartTag 才谈得上 MM 判定)", () => {
    const out = detectEarlyWinnerCandidates(
      [mk({ proxyWallet: "0xSTRANGER", size: 20000, price: 0.5 })],
      earlyWinnerParams(),
      // smart 为空(0xstranger 不在其中),即使它在 earlyWinnerWallets 里也不算。
      ctx({ smart: new Map(), earlyWinnerWallets: new Set(["0xstranger"]) }),
    );
    expect(out).toHaveLength(0);
  });

  it("新鲜度闸门与折叠规则与 D1 共享:陈旧跨线不产出候选", () => {
    const smart = new Map([["0xa", tag({ score: null })]]);
    const out = detectEarlyWinnerCandidates(
      [mk({ proxyWallet: "0xA", size: 20000, price: 0.5, timestamp: 1000 })],
      earlyWinnerParams(),
      ctx({
        smart,
        earlyWinnerWallets: new Set(["0xa"]),
        nowSec: 100_000, // 远超 freshSec 900
      }),
    );
    expect(out).toHaveLength(0);
  });

  it("折叠规则与 D1 共享:同一 (市场,方向) 多个渠道钱包 → 取净买最大的那个", () => {
    const smart = new Map([
      ["0xa", tag({ score: null })],
      ["0xb", tag({ score: null })],
    ]);
    const trades = [
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x1",
        size: 20000,
        price: 0.5, // $10,000
        timestamp: 100,
      }),
      mk({
        proxyWallet: "0xB",
        transactionHash: "0x2",
        size: 40000,
        price: 0.5, // $20,000,更大
        timestamp: 200,
      }),
    ];
    const out = detectEarlyWinnerCandidates(
      trades,
      earlyWinnerParams(),
      ctx({
        smart,
        earlyWinnerWallets: new Set(["0xa", "0xb"]),
        nowSec: 300,
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].totalNetUsd).toBeCloseTo(20_000);
  });

  it("参数缺失(minNetUsd undefined)→ 空候选,不抛错", () => {
    const smart = new Map([["0xa", tag()]]);
    const trades = [mk({ proxyWallet: "0xA", size: 20000, price: 0.5 })];
    const out = detectEarlyWinnerCandidates(
      trades,
      earlyWinnerParams({ minNetUsd: undefined }),
      ctx({ smart, earlyWinnerWallets: new Set(["0xa"]) }),
    );
    expect(out).toHaveLength(0);
  });

  it("身份/资格门槛剔除数会打日志(调试可诊断性)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const smart = new Map([["0xa", tag({ score: 1 })]]);
    detectEarlyWinnerCandidates(
      [mk({ proxyWallet: "0xA", size: 20000, price: 0.5 })],
      earlyWinnerParams(),
      // 0xa 不在 earlyWinnerWallets 里 → notQualified 计数 +1。
      ctx({ smart, earlyWinnerWallets: new Set() }),
    );
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("身份/资格门槛"))).toBe(true);
    logSpy.mockRestore();
  });
});

describe("wallets 快照(向前落库)", () => {
  it("lone_wolf:单钱包单元素,netUsd=聚合净买,score=检测时评分", () => {
    const trades = [
      mk({ proxyWallet: "0xA", size: 16_000, price: 0.5 }), // $8k
      mk({ proxyWallet: "0xA", size: 8_000, price: 0.5 }), // $4k → 净 $12k
    ];
    const c = detectLoneWolfCandidates(trades, loneWolfParams(), ctx())[0];
    expect(c.wallets).toEqual([
      { wallet: "0xa", netUsd: c.totalNetUsd, score: 95 },
    ]);
    expect(c.totalNetUsd).toBeCloseTo(12_000, 6);
  });
});
