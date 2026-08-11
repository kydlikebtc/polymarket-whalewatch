import { describe, it, expect } from "vitest";
import { detectHeavyCandidates } from "./sourceHeavy";
import type { DetectorCtx, StrategyParams } from "./followCandidate";
import type { SmartTag } from "./smartWallets";
import type { Trade } from "./types";

const mk = (over: Partial<Trade> = {}): Trade =>
  ({
    transactionHash: `0xtx${Math.random().toString(36).slice(2, 8)}`,
    asset: "asset1",
    proxyWallet: "0xW1",
    side: "BUY",
    // 默认 $10k(20000×0.5),刻意压在 heavy 的 $50k 门槛之下 —— 任何一条用例要让
    // 候选产出,必须自己显式把 size/price 顶到门槛之上,不能靠默认值"顺便"过线。
    // 这样"非白名单/做市商不算"这类用例即使给了远超门槛的金额也仍然拦下,拦的
    // 理由才是干净的(身份闸,不是金额凑巧不够)。
    size: 20000,
    price: 0.5,
    timestamp: 1000,
    // title/slug/eventSlug 取三个一眼能分清彼此的值,用例1要逐字段核对
    // FollowCandidate 的映射,同为 string 的字段写反编译期和运行期都不会报错。
    title: "Market Title",
    slug: "market-slug",
    eventSlug: "event-slug",
    outcome: "Yes",
    outcomeIndex: 0,
    conditionId: "0xc",
    ...over,
  }) as Trade;

const tag = (over: Partial<SmartTag> = {}): SmartTag => ({
  score: 80,
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
  // [1000, 1900] 内默认组合才是"新鲜"的。这里取 1500(与 sourceConsensus.test.ts
  // 同一个已验证自洽的组合):nowSec-timestamp=500 <= freshSec=900,新鲜。
  nowSec: 1500,
  contested: [],
  earlyWinnerWallets: new Set(),
  prevTilt: new Map(),
  ...over,
});

const params = (over: Partial<StrategyParams> = {}): StrategyParams => ({
  id: 1,
  source: "heavy",
  sizeUsd: 500,
  exitRule: "settlement",
  maxEntryDeviationCents: 10,
  maxPrice: 0.95,
  freshSec: 900,
  minSingleFillUsd: 50_000,
  ...over,
});

describe("detectHeavyCandidates", () => {
  it("单笔 notional >= minSingleFillUsd 的白名单 BUY → 一个候选(12 个字段全部核对)", () => {
    const trades = [
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x1",
        size: 200_000,
        price: 0.25, // $50,000 notional,恰好等于门槛
        timestamp: 1000,
      }),
    ];
    const out = detectHeavyCandidates(trades, params(), ctx());
    expect(out).toHaveLength(1);
    const c = out[0];
    // FollowCandidate 的全部 12 个字段逐一核对 —— 只断言部分字段时,slug/
    // eventSlug 这类同为 string 且语义相近的字段写反,编译器和运行时都拦不住。
    expect(c.conditionId).toBe("0xc");
    expect(c.outcome).toBe("Yes");
    expect(c.outcomeIndex).toBe(0);
    expect(c.asset).toBe("asset1");
    expect(c.title).toBe("Market Title");
    expect(c.slug).toBe("market-slug");
    expect(c.eventSlug).toBe("event-slug");
    // formationTs = 那一笔的 timestamp(单笔信号,无形成过程,天然精确)。
    expect(c.formationTs).toBe(1000);
    // referencePrice = 那一笔的成交价。
    expect(c.referencePrice).toBeCloseTo(0.25);
    expect(c.sourceKind).toBe("heavy");
    expect(c.walletCount).toBe(1);
    expect(c.totalNetUsd).toBeCloseTo(50_000);
  });

  it("差一点点($49,999)→ 无候选(阈值边界)", () => {
    const out = detectHeavyCandidates(
      [mk({ proxyWallet: "0xA", size: 199_996, price: 0.25 })], // 199996*0.25=49999
      params(),
      ctx(),
    );
    expect(out).toHaveLength(0);
  });

  it("恰好等于阈值($50,000)→ 有候选(usd < floor 是严格小于,等于要过)", () => {
    const out = detectHeavyCandidates(
      // 与用例1不同的数字组合(100_000×0.5),避免看起来像是复用同一笔数据。
      [mk({ proxyWallet: "0xA", size: 100_000, price: 0.5 })],
      params(),
      ctx(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].totalNetUsd).toBeCloseTo(50_000);
  });

  it("SELL 不算 —— heavy 的语义是买入", () => {
    const out = detectHeavyCandidates(
      // $100k SELL:金额远超门槛,确保拦下的理由只能是方向,不是金额不够。
      [mk({ proxyWallet: "0xA", side: "SELL", size: 400_000, price: 0.25 })],
      params(),
      ctx(),
    );
    expect(out).toHaveLength(0);
  });

  it("非白名单钱包不算", () => {
    const out = detectHeavyCandidates(
      // ctx() 默认白名单只有 0xa/0xb,0xSTRANGER 不在其中。
      [mk({ proxyWallet: "0xSTRANGER", size: 400_000, price: 0.25 })],
      params(),
      ctx(),
    );
    expect(out).toHaveLength(0);
  });

  it("做市商钱包不算(isMarketMaker:true,与 consensus/disagreement 同纪律)", () => {
    const smart = new Map([["0xa", tag({ isMarketMaker: true })]]);
    const out = detectHeavyCandidates(
      [mk({ proxyWallet: "0xA", size: 400_000, price: 0.25 })],
      params(),
      ctx({ smart }),
    );
    expect(out).toHaveLength(0);
  });

  it("不受分歧互斥约束:contested 市场里照样产出候选(与 A 族的关键差异)", () => {
    const out = detectHeavyCandidates(
      [mk({ proxyWallet: "0xA", size: 200_000, price: 0.25 })],
      params(),
      // 该市场(conditionId "0xc")在 contested 列表里 —— A 族(consensus)会把它
      // 整个剔除,heavy 不受这条约束,必须照样产出候选。
      ctx({ contested: [{ conditionId: "0xc" }] as never }),
    );
    expect(out).toHaveLength(1);
  });

  it("同一(市场,方向)多笔达标 → 折叠成一个候选,取 notional 最大的那笔(不是最新那笔)", () => {
    const out = detectHeavyCandidates(
      [
        // 更晚但更小:若实现误用"最新一笔"而非"最大一笔",formationTs 会错判成
        // 1500、totalNetUsd 会错判成 50_000 —— 这笔数据专门用来拆穿那个 bug。
        mk({
          proxyWallet: "0xA",
          transactionHash: "0x1",
          size: 200_000,
          price: 0.25, // $50k,较小但较新
          timestamp: 1500,
        }),
        mk({
          proxyWallet: "0xB",
          transactionHash: "0x2",
          size: 400_000,
          price: 0.25, // $100k,较大但较早
          timestamp: 1000,
        }),
      ],
      params(),
      ctx(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].totalNetUsd).toBeCloseTo(100_000); // 取最大那笔(第二笔)
    expect(out[0].formationTs).toBe(1000); // 最大那笔的 ts,不是最新的 1500
    expect(out[0].referencePrice).toBeCloseTo(0.25);
  });

  it("不同市场(conditionId 不同)各自独立产出候选,不会被错误合并", () => {
    const out = detectHeavyCandidates(
      [
        mk({
          proxyWallet: "0xA",
          transactionHash: "0x1",
          conditionId: "0xc1",
          size: 200_000,
          price: 0.25,
        }),
        mk({
          proxyWallet: "0xB",
          transactionHash: "0x2",
          conditionId: "0xc2",
          size: 200_000,
          price: 0.25,
        }),
      ],
      params(),
      ctx(),
    );
    expect(out).toHaveLength(2);
  });

  it("新鲜度闸门照常生效", () => {
    const out = detectHeavyCandidates(
      [mk({ proxyWallet: "0xA", size: 200_000, price: 0.25, timestamp: 1000 })],
      params(),
      // nowSec - formationTs = 99_000,远超 freshSec(900)。
      ctx({ nowSec: 100_000 }),
    );
    expect(out).toHaveLength(0);
  });

  it("参数缺失(minSingleFillUsd undefined)→ 空候选,不抛错", () => {
    const trades = [mk({ proxyWallet: "0xA", size: 400_000, price: 0.25 })]; // $100k,若阈值生效本该达标
    expect(() =>
      detectHeavyCandidates(
        trades,
        params({ minSingleFillUsd: undefined }),
        ctx(),
      ),
    ).not.toThrow();
    const out = detectHeavyCandidates(
      trades,
      params({ minSingleFillUsd: undefined }),
      ctx(),
    );
    expect(out).toHaveLength(0);
  });

  it("参数非法(minSingleFillUsd<=0)→ 空候选,不抛错", () => {
    const out = detectHeavyCandidates(
      [mk({ proxyWallet: "0xA", size: 400_000, price: 0.25 })],
      params({ minSingleFillUsd: 0 }),
      ctx(),
    );
    expect(out).toHaveLength(0);
  });
});

describe("detectHeavyCandidates — B3 质量门槛", () => {
  it("minWalletScore=80:score 不够的钱包不算", () => {
    const smart = new Map([["0xa", tag({ score: 50 })]]);
    const out = detectHeavyCandidates(
      [mk({ proxyWallet: "0xA", size: 200_000, price: 0.25 })],
      params({ minWalletScore: 80 }),
      ctx({ smart }),
    );
    expect(out).toHaveLength(0);
  });

  it("score 为 null(未知)视为不达标 —— 与 A3 同纪律", () => {
    const smart = new Map([["0xa", tag({ score: null })]]);
    const out = detectHeavyCandidates(
      [mk({ proxyWallet: "0xA", size: 200_000, price: 0.25 })],
      params({ minWalletScore: 80 }),
      ctx({ smart }),
    );
    expect(out).toHaveLength(0);
  });

  it("score 达标 → 产出候选", () => {
    const smart = new Map([["0xa", tag({ score: 90 })]]);
    const out = detectHeavyCandidates(
      [mk({ proxyWallet: "0xA", size: 200_000, price: 0.25 })],
      params({ minWalletScore: 80 }),
      ctx({ smart }),
    );
    expect(out).toHaveLength(1);
  });
});
