import { describe, it, expect, vi } from "vitest";
import { detectLopsidedCandidates } from "./sourceLopsided";
import { detectConsensusCandidates } from "./sourceConsensus";
import {
  detectDisagreement,
  DEFAULT_DISAGREEMENT,
  type DisagreementMarket,
} from "./disagreement";
import { detectConsensus, DEFAULT_CONSENSUS } from "./consensus";
import type { DetectorCtx, StrategyParams } from "./followCandidate";
import type { SmartTag } from "./smartWallets";
import type { Trade } from "./types";

// 与 disagreement.test.ts / sourceConsensus.test.ts / sourceHeavy.test.ts 同一套
// fixture 写法。本文件刻意不手工构造 DisagreementMarket 字面量 —— 全部经由真实
// detectDisagreement(trades, smart, opts) 算出 ctx.contested,sides 排序/
// tiltPct/formationTs 都是真实算法的产物,不是我们自己假设的形状。
const mk = (over: Partial<Trade> = {}): Trade =>
  ({
    transactionHash: `0xtx${Math.random().toString(36).slice(2, 8)}`,
    asset: "assetYes",
    proxyWallet: "0xW1",
    side: "BUY",
    size: 20000,
    price: 0.5,
    timestamp: 1000,
    // title/slug/eventSlug 取三个一眼能分清彼此的值(而非容易在断言里写反也
    // 测不出来的占位符)—— 正例用例要逐字段核对 FollowCandidate 的映射。
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
  source: "lopsided",
  sizeUsd: 500,
  exitRule: "settlement",
  maxEntryDeviationCents: 10,
  maxPrice: 0.95,
  freshSec: 900,
  ...over,
});

// ---------------------------------------------------------------------------
// 一边倒 fixture:t=100 0xA 买 Yes $6k @0.5(12000 股),t=200 0xB 买 No $6k
// @0.4(15000 股,此刻 6:6 = tiltPct 0.5,未跨线),t=300 0xC 再买 Yes $20k
// @0.625(32000 股)→ Yes=$26k / No=$6k,tiltPct=26000/32000=0.8125 ≥ 0.7 ←
// 倾斜形成于 t=300。三个钱包同分(80)→ qualityWeight 均匀(0.84),weightedUsd
// 比例与原始 USD 比例相同,可以直接用 USD 数字心算校验。
//
// Yes 侧刻意用两个不同单价(0.5 与 0.625)买入 —— avgBuyPrice 是
// (6000+20000)/(12000+32000)=26000/44000≈0.590909,一个不等于任何单笔价格、
// 也不等于 No 侧价格(0.4)的加权均值,能拆穿"referencePrice 抄错侧/抄错单笔"
// 这类 bug(若实现误用 A 或 C 某一笔的单价,或误用 No 侧的均价,断言都会失败)。
// ---------------------------------------------------------------------------
const lopsidedTrades = (): Trade[] => [
  mk({
    proxyWallet: "0xA",
    transactionHash: "0x1",
    timestamp: 100,
    outcome: "Yes",
    outcomeIndex: 0,
    asset: "assetYes",
    size: 12000,
    price: 0.5,
  }),
  mk({
    proxyWallet: "0xB",
    transactionHash: "0x2",
    timestamp: 200,
    outcome: "No",
    outcomeIndex: 1,
    asset: "assetNo",
    size: 15000,
    price: 0.4,
  }),
  mk({
    proxyWallet: "0xC",
    transactionHash: "0x3",
    timestamp: 300,
    outcome: "Yes",
    outcomeIndex: 0,
    asset: "assetYes",
    size: 32000,
    price: 0.625,
  }),
];
const lopsidedSmart = () => smartMap({ "0xa": 80, "0xb": 80, "0xc": 80 });

// balanced fixture:A 买 Yes $10k,B 买 No $10k → tiltPct=0.5,从未跨过 0.7,
// sides[0].formationTs 恒为 null(真·势均力敌,不是"算错了")。
const balancedTrades = (): Trade[] => [
  mk({
    proxyWallet: "0xA",
    transactionHash: "0x1",
    timestamp: 100,
    outcome: "Yes",
    outcomeIndex: 0,
    asset: "assetYes",
  }),
  mk({
    proxyWallet: "0xB",
    transactionHash: "0x2",
    timestamp: 200,
    outcome: "No",
    outcomeIndex: 1,
    asset: "assetNo",
  }),
];
const balancedSmart = () => smartMap({ "0xa": 80, "0xb": 80 });

describe("detectLopsidedCandidates", () => {
  it("tilt >= minTiltPct(一边倒)→ 跟主导边,12 个 FollowCandidate 字段全部核对", () => {
    const contested = detectDisagreement(
      lopsidedTrades(),
      lopsidedSmart(),
      DEFAULT_DISAGREEMENT,
    );
    expect(contested).toHaveLength(1);
    // 锁定 fixture 本身的形状,不然下面的断言无从谈起。
    expect(contested[0].tilt).toBe("lopsided");
    expect(contested[0].tiltPct).toBeCloseTo(0.8125);
    expect(contested[0].sides[0].outcome).toBe("Yes");
    expect(contested[0].sides[0].formationTs).toBe(300);

    // 故意传空数组:这个 detector 真的不读 trades,只吃 ctx.contested —— 传
    // 空数组还能算出正确候选,才是"不读 trades"这条声明的真实验证,而不是
    // 恰好没测出来。
    const out = detectLopsidedCandidates(
      [],
      params(),
      ctx({ contested, nowSec: 800 }), // nowSec-formationTs=500 <= freshSec 900,新鲜
    );
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.conditionId).toBe("0xc");
    expect(c.outcome).toBe("Yes"); // 必须是主导边,不是 No
    expect(c.outcomeIndex).toBe(0);
    expect(c.asset).toBe("assetYes");
    expect(c.title).toBe("Market Title");
    expect(c.slug).toBe("market-slug");
    expect(c.eventSlug).toBe("event-slug");
    expect(c.formationTs).toBe(300); // 倾斜形成时刻,不是 lastTs(200)也不是某笔单独 ts
    expect(c.referencePrice).toBeCloseTo(26000 / 44000); // 主导边加权均价 ≈0.590909
    expect(c.sourceKind).toBe("lopsided");
    expect(c.walletCount).toBe(2); // 0xA + 0xC
    expect(c.totalNetUsd).toBe(26000); // 主导边(Yes)净买,不是市场级 totalNetUsd(32000)
  });

  it("恰好等于阈值(tiltPct===minTiltPct,0.7)→ 仍算一边倒(边界含等号)", () => {
    // A 单笔买 Yes $70,000,B 单笔买 No $30,000 → tiltPct=70000/100000=0.7 整。
    const trades = [
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x1",
        timestamp: 100,
        outcome: "Yes",
        outcomeIndex: 0,
        asset: "assetYes",
        size: 140000,
        price: 0.5,
      }),
      mk({
        proxyWallet: "0xB",
        transactionHash: "0x2",
        timestamp: 200,
        outcome: "No",
        outcomeIndex: 1,
        asset: "assetNo",
        size: 60000,
        price: 0.5,
      }),
    ];
    const smart = smartMap({ "0xa": 80, "0xb": 80 });
    const contested = detectDisagreement(trades, smart, DEFAULT_DISAGREEMENT);
    expect(contested[0].tiltPct).toBeCloseTo(0.7);
    expect(contested[0].tilt).toBe("lopsided"); // detectDisagreement 自身也是 >= 含等号

    const out = detectLopsidedCandidates(
      [],
      params(), // 未配置 minTiltPct → 默认 DEFAULT_DISAGREEMENT.lopsidedTiltPct(0.7)
      ctx({ contested, nowSec: 300 }),
    );
    expect(out).toHaveLength(1); // 0.7 < 0.7 为 false,不应被跳过
  });

  it("tilt < minTiltPct(真·势均力敌)→ 无候选,谁都不跟", () => {
    const contested = detectDisagreement(
      balancedTrades(),
      balancedSmart(),
      DEFAULT_DISAGREEMENT,
    );
    expect(contested[0].tilt).toBe("balanced"); // 锁定 fixture 形状

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = detectLopsidedCandidates(
      [],
      params(), // 默认 minTiltPct=0.7
      ctx({ contested, nowSec: 800 }),
    );
    expect(out).toHaveLength(0);
    // 走的是"真·势均力敌"这条弃权理由,不是 fail-closed 分支 —— 见下一条用例
    // 对 fail-closed 分支的独立验证。
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("真·势均力敌"))).toBe(true);
    expect(lines.some((l) => l.includes("fail-closed"))).toBe(false);
    logSpy.mockRestore();
  });

  it("formationTs 为 null → 无候选(fail-closed),且这条弃权理由独立于 tiltPct 门槛本身触发", () => {
    // 复用 balanced fixture,但把本策略的 minTiltPct 配置得比市场最终 tiltPct
    // (0.5)还低(0.3)—— 第一道 tiltPct 检查放行(0.5 >= 0.3),但
    // sides[0].formationTs 仍是 null:ctx.contested 恒由 DEFAULT_DISAGREEMENT
    // (0.7)算出,这个市场从未跨过那个固定阈值,跟本策略的 minTiltPct 无关。
    // 这才是专门验证 fail-closed 分支、而不是复测上一条 tiltPct 分支的用例。
    const contested = detectDisagreement(
      balancedTrades(),
      balancedSmart(),
      DEFAULT_DISAGREEMENT,
    );
    expect(contested[0].sides[0].formationTs).toBeNull(); // 自然产生的 null,不是手工塞的

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = detectLopsidedCandidates(
      [],
      params({ minTiltPct: 0.3 }),
      ctx({ contested, nowSec: 800 }),
    );
    expect(out).toHaveLength(0);
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("fail-closed"))).toBe(true);
    expect(lines.some((l) => l.includes("真·势均力敌"))).toBe(false);
    logSpy.mockRestore();
  });

  it("新鲜度闸门锚在倾斜形成时刻(formationTs),不是 lastTs:陈旧的不产出候选", () => {
    const contested = detectDisagreement(
      lopsidedTrades(),
      lopsidedSmart(),
      DEFAULT_DISAGREEMENT,
    );
    expect(contested[0].sides[0].formationTs).toBe(300);
    // nowSec 远超 formationTs(300)+ freshSec(900)。
    const out = detectLopsidedCandidates(
      [],
      params(),
      ctx({ contested, nowSec: 100_000 }),
    );
    expect(out).toHaveLength(0);
  });

  it("与 A 族互补:同一 contested 市场,A 族剔除、C1 接住,不会被两族同时开仓(核心不变量)", () => {
    const trades = lopsidedTrades();
    const smart = lopsidedSmart();
    const contested = detectDisagreement(trades, smart, DEFAULT_DISAGREEMENT);
    expect(contested).toHaveLength(1); // 确实 contested,不是 sanity 恒真

    // 前置证明:如果没有分歧互斥,Yes 侧的 0xA($6k)/0xC($20k)两个钱包本来就
    // 够格组成一个 DEFAULT_CONSENSUS 共识组(各自净买 >= $5k floor,2 个钱包
    // >= minWallets 2)—— 否则下面"consensus 无候选"可能只是因为阈值本来就
    // 不够,测不出互斥到底生没生效,这条不变量会变成假阳性。
    const rawGroups = detectConsensus(trades, smart, DEFAULT_CONSENSUS);
    expect(
      rawGroups.some((g) => g.conditionId === "0xc" && g.outcome === "Yes"),
    ).toBe(true);

    const sharedCtx = ctx({ smart, contested, nowSec: 800 });
    const consensusOut = detectConsensusCandidates(
      trades,
      params({
        source: "consensus",
        minWallets: DEFAULT_CONSENSUS.minWallets,
        minPerWalletUsd: DEFAULT_CONSENSUS.minPerWalletUsd,
      }),
      sharedCtx,
    );
    const lopsidedOut = detectLopsidedCandidates(
      trades,
      params({ source: "lopsided" }),
      sharedCtx,
    );

    // A 族:contested 市场被 excludeContestedFromConsensus 整体剔除 → 0xc 无候选。
    expect(consensusOut.filter((c) => c.conditionId === "0xc")).toHaveLength(0);
    // C1:一边倒接住主导边(Yes)。
    expect(lopsidedOut.filter((c) => c.conditionId === "0xc")).toHaveLength(1);
    expect(lopsidedOut[0].outcome).toBe("Yes");

    // 核心不变量:同一个 (conditionId, outcome) 不会同时出现在两族的候选里 ——
    // 合并后按 key 计数,任何 key 出现 >= 2 次就是"双开",必须全部为 1。这条
    // 断言比单独检查"consensus 里没有"或"lopsided 里有"更强:它锁死的是两族
    // 的输出集合本身互斥,任何一族将来的改动(比如误删互斥过滤、或 C1 误跟了
    // 已被 A 族覆盖的市场)都会让某个 key 计数变成 2,直接拆穿。
    const allCandidates = [...consensusOut, ...lopsidedOut];
    const counts = new Map<string, number>();
    for (const c of allCandidates) {
      const key = `${c.conditionId}|${c.outcome}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });

  it("minTiltPct 可配:自定义更高门槛(0.9)让全局判定为 lopsided(0.8125)但达不到这个门槛的市场也被剔除", () => {
    const contested = detectDisagreement(
      lopsidedTrades(),
      lopsidedSmart(),
      DEFAULT_DISAGREEMENT,
    );
    expect(contested[0].tilt).toBe("lopsided"); // 全局口径(0.7)判定为一边倒
    expect(contested[0].tiltPct).toBeCloseTo(0.8125);

    // 默认阈值下(上面第一条用例)这个市场会产出候选;这里改用更保守的 0.9,
    // 0.8125 < 0.9,应被剔除 —— 证明 minTiltPct 传参真的生效,不是被忽略。
    const out = detectLopsidedCandidates(
      [],
      params({ minTiltPct: 0.9 }),
      ctx({ contested, nowSec: 800 }),
    );
    expect(out).toHaveLength(0);
  });

  it("多个 contested 市场:balanced 与 lopsided 混在一起,只有 lopsided 的产出候选", () => {
    // 两个不同 conditionId 的市场分别喂两套 fixture,合并成一份 contested 列表 ——
    // 验证 detector 是逐市场独立判定,不会因为数组里混了 balanced 市场就整体受影响。
    const lopsidedC = detectDisagreement(
      lopsidedTrades(),
      lopsidedSmart(),
      DEFAULT_DISAGREEMENT,
    )[0];
    const balancedTradesOtherMarket = balancedTrades().map((t) => ({
      ...t,
      conditionId: "0xother",
    }));
    const balancedC = detectDisagreement(
      balancedTradesOtherMarket,
      balancedSmart(),
      DEFAULT_DISAGREEMENT,
    )[0];
    const contested: DisagreementMarket[] = [lopsidedC, balancedC];

    const out = detectLopsidedCandidates(
      [],
      params(),
      ctx({ contested, nowSec: 800 }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].conditionId).toBe("0xc");
  });
});
