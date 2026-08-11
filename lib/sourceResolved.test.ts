import { describe, it, expect } from "vitest";
import { detectResolvedCandidates } from "./sourceResolved";
import { DEFAULT_DISAGREEMENT, detectDisagreement } from "./disagreement";
import type {
  DetectorCtx,
  MarketTiltSnapshot,
  StrategyParams,
} from "./followCandidate";
import type { SmartTag } from "./smartWallets";
import type { Trade } from "./types";

// 与 sourceLopsided.test.ts 同一套 fixture 写法(mk/tag/smartMap/ctx/params)。
const mk = (over: Partial<Trade> = {}): Trade =>
  ({
    transactionHash: `0xtx${Math.random().toString(36).slice(2, 8)}`,
    asset: "assetYes",
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

const tag = (score: number | null = 80): SmartTag => ({
  score,
  winRate: 0.7,
  netPnl: 100_000,
  isWhitelist: false,
});

const smartMap = (
  entries: Record<string, number | null>,
): Map<string, SmartTag> =>
  new Map(Object.entries(entries).map(([w, s]) => [w.toLowerCase(), tag(s)]));

const ctx = (over: Partial<DetectorCtx> = {}): DetectorCtx => ({
  smart: new Map(),
  nowSec: 1500,
  contested: [],
  earlyWinnerWallets: new Set(),
  prevTilt: new Map(),
  ...over,
});

const params = (over: Partial<StrategyParams> = {}): StrategyParams => ({
  id: 1,
  source: "resolved",
  sizeUsd: 500,
  exitRule: "settlement",
  maxEntryDeviationCents: 10,
  maxPrice: 0.95,
  freshSec: 900,
  ...over,
});

const snapshot = (
  over: Partial<MarketTiltSnapshot> = {},
): MarketTiltSnapshot => ({
  conditionId: "0xc",
  leadOutcome: "Yes",
  minorOutcome: "No",
  minorNetUsd: 10000,
  tiltPct: 0.625,
  ts: 50,
  ...over,
});

// ---------------------------------------------------------------------------
// 共用 fixture:主导边(Yes)0xA 净买 $10k、稳稳留仓;少数边(No)0xB 先买
// $10k 再卖 $15k(30000 股)→ netShares=-10000,avgBuyPrice=0.5(买入均价不受
// 卖出影响),signedNetUsd = -10000 × 0.5 = -$5000 —— aggregateMarketOutcomes
// 的有符号口径能测出这个转负;而它的 clamp 口径(exposureUsd,DisagreementSide
// 用的那套)会把这个钱包按 net<=0 直接排除在外,netUsd/walletCount 都归零,
// 这正是"少数边真转净卖后,市场会从 ctx.contested 消失"这条论证的具体样子。
// ---------------------------------------------------------------------------
const leadTrades = (): Trade[] => [
  mk({
    proxyWallet: "0xA",
    transactionHash: "0x1",
    timestamp: 600,
    outcome: "Yes",
    outcomeIndex: 0,
    asset: "assetYes",
  }), // 0xA 买 Yes 20000@0.5=$10k,不卖
];
const minorFlippedTrades = (): Trade[] => [
  mk({
    proxyWallet: "0xB",
    transactionHash: "0x2",
    timestamp: 100,
    outcome: "No",
    outcomeIndex: 1,
    asset: "assetNo",
  }), // 0xB 买 No 20000@0.5=$10k
  mk({
    proxyWallet: "0xB",
    transactionHash: "0x3",
    timestamp: 200,
    outcome: "No",
    outcomeIndex: 1,
    asset: "assetNo",
    side: "SELL",
    size: 30000,
    price: 0.5,
  }), // 0xB 卖 No 30000@0.5=$15k → netShares=-10000,转净卖
];
const resolvedSmart = () => smartMap({ "0xa": 80, "0xb": 80 });

describe("detectResolvedCandidates", () => {
  it("正例:上轮快照记录 minor 净买 $10k,本轮该边净额转负 → 产出候选,12 个字段全部核对", () => {
    const trades = [...leadTrades(), ...minorFlippedTrades()];
    const smart = resolvedSmart();
    const c = ctx({
      smart,
      nowSec: 800,
      prevTilt: new Map([["0xc", snapshot()]]),
    });

    const out = detectResolvedCandidates(trades, params(), c);
    expect(out).toHaveLength(1);
    const cand = out[0];
    expect(cand.conditionId).toBe("0xc");
    expect(cand.outcome).toBe("Yes"); // 必须是主导边,不是转净卖的 No
    expect(cand.outcomeIndex).toBe(0);
    expect(cand.asset).toBe("assetYes");
    expect(cand.title).toBe("Market Title");
    expect(cand.slug).toBe("market-slug");
    expect(cand.eventSlug).toBe("event-slug");
    expect(cand.formationTs).toBe(800); // = ctx.nowSec,不是任何一笔成交的 ts
    expect(cand.referencePrice).toBeCloseTo(0.5); // 主导边净买者的加权均价
    expect(cand.sourceKind).toBe("resolved");
    expect(cand.walletCount).toBe(1); // 0xA
    expect(cand.totalNetUsd).toBe(10000); // 主导边净买,不是少数边的任何数字
  });

  it("首见市场(prevTilt 无记录)→ 不触发,没有'之前'就无所谓'转变'", () => {
    const trades = [...leadTrades(), ...minorFlippedTrades()];
    const c = ctx({ smart: resolvedSmart(), nowSec: 800, prevTilt: new Map() });
    expect(detectResolvedCandidates(trades, params(), c)).toHaveLength(0);
  });

  it("少数边仍在净买(未转负)→ 不触发", () => {
    const trades = [
      ...leadTrades(),
      mk({
        proxyWallet: "0xB",
        transactionHash: "0x2",
        timestamp: 100,
        outcome: "No",
        outcomeIndex: 1,
        asset: "assetNo",
      }), // 0xB 买 No $10k,本轮没有卖出 —— 仍是净买
    ];
    const c = ctx({
      smart: resolvedSmart(),
      nowSec: 800,
      prevTilt: new Map([["0xc", snapshot()]]),
    });
    expect(detectResolvedCandidates(trades, params(), c)).toHaveLength(0);
  });

  it("主导边换人(本轮真正的最大边已经是第三个 outcome,不再是 prev.leadOutcome)→ 不触发,这是翻转不是解除", () => {
    // Yes(prev 主导边)本轮只有一笔很小的净买 $1000 —— 自己还在净买,没有
    // "退出",但被同一市场里新崛起的第三个 outcome(Maybe,$50k)远远反超。
    const trades = [
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x1",
        timestamp: 600,
        outcome: "Yes",
        outcomeIndex: 0,
        asset: "assetYes",
        size: 2000,
        price: 0.5,
      }), // Yes:0xA 买 $1000
      ...minorFlippedTrades(), // No:转净卖,满足第一道判据
      mk({
        proxyWallet: "0xD",
        transactionHash: "0x4",
        timestamp: 300,
        outcome: "Maybe",
        outcomeIndex: 2,
        asset: "assetMaybe",
        size: 100000,
        price: 0.5,
      }), // Maybe:0xD 买 $50000,远超 Yes 的 $1000
    ];
    const smart = smartMap({ "0xa": 80, "0xb": 80, "0xd": 80 });
    const c = ctx({
      smart,
      nowSec: 800,
      prevTilt: new Map([["0xc", snapshot()]]),
    });
    expect(detectResolvedCandidates(trades, params(), c)).toHaveLength(0);
  });

  it("主导边自己也净卖 → 不触发(fail-closed:两边都在撤,不是'一边赢了')", () => {
    const trades = [
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x1",
        timestamp: 100,
        outcome: "Yes",
        outcomeIndex: 0,
        asset: "assetYes",
      }), // Yes:0xA 买 20000@0.5=$10k
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x1b",
        timestamp: 200,
        outcome: "Yes",
        outcomeIndex: 0,
        asset: "assetYes",
        side: "SELL",
        size: 30000,
        price: 0.5,
      }), // Yes:0xA 卖 30000@0.5=$15k → netShares=-10000,主导边自己也转负
      ...minorFlippedTrades(), // No:同样转净卖
    ];
    const c = ctx({
      smart: resolvedSmart(),
      nowSec: 800,
      prevTilt: new Map([["0xc", snapshot()]]),
    });
    expect(detectResolvedCandidates(trades, params(), c)).toHaveLength(0);
  });

  it("市场已不在 ctx.contested 里(少数边转净卖导致 sides.length<2)→ 仍能触发 —— 核心不变量,原草案做不到的事", () => {
    const trades = [...leadTrades(), ...minorFlippedTrades()];
    const smart = resolvedSmart();

    // 前置证明:用同一份 trades 真跑一遍 detectDisagreement,证明这个市场
    // 本轮确实【不】contested —— No 侧的净买者(0xB)因转净卖被 exposureUsd
    // clamp 到 0,walletCount 归零,连 minWalletsPerSide 的门槛都过不了,
    // Yes 单独一边不足以构成"分歧"(sides.length<2)。不是随手把 ctx.contested
    // 设成 [] 断言恒真,而是拿真实检测函数证明这一刻它就是不在那里。
    const contested = detectDisagreement(trades, smart, DEFAULT_DISAGREEMENT);
    expect(contested.filter((m) => m.conditionId === "0xc")).toHaveLength(0);

    const c = ctx({
      smart,
      nowSec: 800,
      contested, // 用真实检测结果(不含 "0xc"),而不是手工构造的空数组
      prevTilt: new Map([["0xc", snapshot()]]),
    });
    const out = detectResolvedCandidates(trades, params(), c);
    expect(out).toHaveLength(1);
    expect(out[0].conditionId).toBe("0xc");
    expect(out[0].outcome).toBe("Yes");
  });

  it("多个 prevTilt 市场混在一起:只有真正转净卖的那个产出候选,互不干扰", () => {
    const flippedTrades = [...leadTrades(), ...minorFlippedTrades()];
    const stillBuyingTrades = [
      mk({
        proxyWallet: "0xE",
        transactionHash: "0x10",
        timestamp: 100,
        conditionId: "0xother",
        outcome: "Yes",
        outcomeIndex: 0,
        asset: "assetYesOther",
      }),
      mk({
        proxyWallet: "0xF",
        transactionHash: "0x11",
        timestamp: 100,
        conditionId: "0xother",
        outcome: "No",
        outcomeIndex: 1,
        asset: "assetNoOther",
      }), // 0xF 仍在净买,未转负
    ];
    const smart = smartMap({ "0xa": 80, "0xb": 80, "0xe": 80, "0xf": 80 });
    const c = ctx({
      smart,
      nowSec: 800,
      prevTilt: new Map([
        ["0xc", snapshot()],
        [
          "0xother",
          snapshot({
            conditionId: "0xother",
            leadOutcome: "Yes",
            minorOutcome: "No",
          }),
        ],
      ]),
    });
    const out = detectResolvedCandidates(
      [...flippedTrades, ...stillBuyingTrades],
      params(),
      c,
    );
    expect(out).toHaveLength(1);
    expect(out[0].conditionId).toBe("0xc");
  });
});
