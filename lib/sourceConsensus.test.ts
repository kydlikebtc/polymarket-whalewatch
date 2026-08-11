import { describe, it, expect } from "vitest";
import { detectConsensusCandidates } from "./sourceConsensus";
import type { DetectorCtx, StrategyParams } from "./followCandidate";
import type { SmartTag } from "./smartWallets";
import type { Trade } from "./types";

const mk = (over: Partial<Trade> = {}): Trade =>
  ({
    transactionHash: `0xtx${Math.random().toString(36).slice(2, 8)}`,
    asset: "asset1",
    proxyWallet: "0xW1",
    side: "BUY",
    size: 20000,
    price: 0.5, // $10k notional by default
    timestamp: 1000,
    // title/slug/eventSlug 刻意取三个一眼能分清彼此的值(而非 "Market"/"slug"/
    // "event" 这种容易在断言里对错都长得一样的占位符)—— 用例1要逐字段核对
    // FollowCandidate 的映射,slug/eventSlug 写反这种 bug 编译器和运行时都不
    // 会报,只有断言值本身互不相同才拦得住。
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
  // [1000, 1900] 内,默认组合才是「新鲜」的(用于 happy-path 用例)。原草案给的
  // 2000 会让 nowSec-formationTs=1000 > 900,反被新鲜度闸门剔除,与用例1的
  // 断言(产出 1 个候选)自相矛盾 —— 实测(console.log 打出"剔除 1 个陈旧共识组")
  // 验证过这是草案本身的数值不自洽,不是实现的问题。
  nowSec: 1500,
  contested: [],
  earlyWinnerWallets: new Set(),
  prevTilt: new Map(),
  ...over,
});

const params = (over: Partial<StrategyParams> = {}): StrategyParams => ({
  id: 1,
  source: "consensus",
  sizeUsd: 500,
  exitRule: "settlement",
  maxEntryDeviationCents: 10,
  maxPrice: 0.95,
  freshSec: 900,
  minWallets: 2,
  minPerWalletUsd: 5000,
  ...over,
});

describe("detectConsensusCandidates", () => {
  it("2 个聪明钱各净买过门槛 → 产出一个候选", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1" }),
      mk({ proxyWallet: "0xB", transactionHash: "0x2" }),
    ];
    const out = detectConsensusCandidates(trades, params(), ctx());
    expect(out).toHaveLength(1);
    // 12 个字段逐个核对映射(FollowCandidate 契约的全部字段)—— Task 4 要把
    // 这些字段直接喂进 INSERT 语句,slug/eventSlug 这类同为 string 的语义相近
    // 字段写反,TS 不报错、只挑几个字段断言也测不出来,必须全覆盖。
    expect(out[0].conditionId).toBe("0xc");
    expect(out[0].outcome).toBe("Yes");
    expect(out[0].outcomeIndex).toBe(0);
    expect(out[0].asset).toBe("asset1");
    expect(out[0].title).toBe("Market Title");
    expect(out[0].slug).toBe("market-slug");
    expect(out[0].eventSlug).toBe("event-slug");
    // formationTs = 两个钱包各自唯一一笔 BUY 的 timestamp(单笔即跨线)。
    expect(out[0].formationTs).toBe(1000);
    // referencePrice = 聪明钱加权均价(此处两笔同价 0.5)
    expect(out[0].referencePrice).toBeCloseTo(0.5);
    expect(out[0].sourceKind).toBe("consensus");
    expect(out[0].walletCount).toBe(2);
    // totalNetUsd = 两个钱包各 $10k 净买(size 20000 × price 0.5)之和。
    expect(out[0].totalNetUsd).toBe(20000);
  });

  it("只有 1 个钱包 → 无候选", () => {
    const out = detectConsensusCandidates(
      [mk({ proxyWallet: "0xA" })],
      params(),
      ctx(),
    );
    expect(out).toHaveLength(0);
  });

  it("新鲜度闸门:formationTs 距 now 超 freshSec → 剔除", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1", timestamp: 1000 }),
      mk({ proxyWallet: "0xB", transactionHash: "0x2", timestamp: 1000 }),
    ];
    // nowSec - formationTs = 100_000 - 1000 远超 900
    const out = detectConsensusCandidates(
      trades,
      params(),
      ctx({ nowSec: 100_000 }),
    );
    expect(out).toHaveLength(0);
  });

  it("分歧互斥:contested 市场整个剔除(A 族保持现状)", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1" }),
      mk({ proxyWallet: "0xB", transactionHash: "0x2" }),
    ];
    const out = detectConsensusCandidates(
      trades,
      params(),
      // 只用到 conditionId 做互斥,其余字段与本用例无关
      ctx({ contested: [{ conditionId: "0xc" }] as never }),
    );
    expect(out).toHaveLength(0);
  });

  it("参数缺失(minWallets undefined)→ 空候选,不抛错", () => {
    const trades = [mk({ proxyWallet: "0xA" }), mk({ proxyWallet: "0xB" })];
    const bad = { ...params(), minWallets: undefined };
    expect(detectConsensusCandidates(trades, bad, ctx())).toHaveLength(0);
  });

  // 上一条只覆盖了 `minWallets == null || minPerWalletUsd == null` 的前半支;
  // 这里单独覆盖后半支(minWallets 保持有效),否则短路求值下后半支从未被
  // 真正执行过 —— 两支各自独立覆盖,不能只测其一就当整个 OR 条件测过了。
  it("参数缺失(minPerWalletUsd undefined)→ 空候选,不抛错", () => {
    const trades = [mk({ proxyWallet: "0xA" }), mk({ proxyWallet: "0xB" })];
    const bad = { ...params(), minPerWalletUsd: undefined };
    expect(detectConsensusCandidates(trades, bad, ctx())).toHaveLength(0);
  });
});
