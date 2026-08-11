# 纸面跟单策略档位扩充 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把纸面跟单从「2 条只在共识门槛上有区别的策略」扩到「4 个信号族 × 12 档」，并抽出信号检测与开仓的解耦层。

**Architecture:** 抽 `FollowCandidate` 统一契约 + Detector 注册表，六个 detector 全部是**纯函数**（DB 依赖在外层预取成数据传入），`runFollowCycle` 的开仓循环只认 `FollowCandidate`、不知道信号从哪来。新增信号源 = 写一个纯函数 + 注册一行，开仓代码零改动。

**Tech Stack:** TypeScript · Next.js 16 · better-sqlite3 · vitest。设计见 `docs/plans/2026-08-11-follow-strategy-tiers-design.md`。

**约定:** 每个纯函数先写失败测试 → 跑失败 → 最小实现 → 跑通 → 提交。测试命令 `npx vitest run <path>`。分支 `claude/paper-tracking-strategy-tiers-96ed7f`，勿动 main。

**红线（贯穿全程）:**

1. **向后兼容优先** — 无 `source` 字段的旧 `params_json` 必须与改造前**逐字节同行为**。Task 3 的兼容测试是整个计划的守门员，它挂了就停下来，不要往前推。
2. **detector 全部纯函数** — 不做 IO、不碰 DB。`wallet_candidates` 查询、tilt 历史读取都在 `runFollowCycle` 里预取成数据传进 `DetectorCtx`。
3. **fail-closed** — 任何"算不出来"的情形（`formationTs` 无法确定、参数非法）一律**不产出候选**，绝不用兜底值硬开仓。宁可错过，不开脏仓。

---

## 阶段 1 — 架构层

### Task 1: `FollowCandidate` 契约

> 只立契约，**不建** `DETECTORS` 注册表 —— 那是 Task 4 的范围。

**Files:**

- Create: `lib/followCandidate.ts`
- Test: `lib/followCandidate.test.ts`

**Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import {
  FOLLOW_SOURCE_KINDS,
  isFollowSourceKind,
  type FollowCandidate,
} from "./followCandidate";

describe("FollowCandidate 契约", () => {
  it("六个 source kind 全部登记", () => {
    expect([...FOLLOW_SOURCE_KINDS].sort()).toEqual([
      "consensus",
      "early_winner",
      "heavy",
      "lone_wolf",
      "lopsided",
      "resolved",
    ]);
  });

  it("isFollowSourceKind 只认登记过的字符串", () => {
    expect(isFollowSourceKind("consensus")).toBe(true);
    expect(isFollowSourceKind("heavy")).toBe(true);
    expect(isFollowSourceKind("accumulate")).toBe(false);
    expect(isFollowSourceKind("")).toBe(false);
    expect(isFollowSourceKind(null)).toBe(false);
    expect(isFollowSourceKind(42)).toBe(false);
  });

  it("候选结构可构造且字段齐全", () => {
    const c: FollowCandidate = {
      conditionId: "0xc",
      outcome: "Yes",
      outcomeIndex: 0,
      asset: "a1",
      title: "t",
      slug: "s",
      eventSlug: "e",
      formationTs: 1000,
      referencePrice: 0.42,
      sourceKind: "heavy",
      walletCount: 1,
      totalNetUsd: 50_000,
    };
    expect(c.sourceKind).toBe("heavy");
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/followCandidate.test.ts`
Expected: FAIL — `Failed to resolve import "./followCandidate"`

**Step 3: 最小实现**

```ts
// lib/followCandidate.ts
import type { DisagreementMarket } from "./disagreement";
import type { SmartTag } from "./smartWallets";
import type { Trade } from "./types";

// 纸面跟单的统一候选契约。所有信号源产出这一个结构,开仓循环只认它 ——
// 新增信号源不必再动 runFollowCycle 里那堆已调稳的护栏/查重/费用/执行层逻辑。
// 设计见 docs/plans/2026-08-11-follow-strategy-tiers-design.md §4。

export const FOLLOW_SOURCE_KINDS = [
  "consensus", // 族 A:N 个聪明钱买同一边
  "heavy", // 族 B:单个钱包单笔巨额
  "lopsided", // C1:分歧但一边倒
  "resolved", // C2:分歧解除(少数边转净卖)
  "lone_wolf", // D1:高分单钱包
  "early_winner", // D2:early_winner 渠道钱包
] as const;

export type FollowSourceKind = (typeof FOLLOW_SOURCE_KINDS)[number];

export function isFollowSourceKind(v: unknown): v is FollowSourceKind {
  return (
    typeof v === "string" &&
    (FOLLOW_SOURCE_KINDS as readonly string[]).includes(v)
  );
}

export interface FollowCandidate {
  // —— 身份(开什么仓)
  conditionId: string;
  outcome: string;
  outcomeIndex: number;
  asset: string;
  title: string;
  slug: string;
  eventSlug: string;
  // —— 时机:信号成立时刻。三个用途:新鲜度闸门 / 护栏基准取价 / markout 锚点。
  // 每个源的语义各不相同,见设计文档 §4.3 —— 定错了这三件事会同时失效。
  formationTs: number;
  // —— 成本基准:聪明钱的成本。护栏基准 + positionSlippage 的减数。
  // consensus 用多钱包加权均价、heavy 用那一笔的价、lopsided 用主导边加权均价 ——
  // 来源不同但跟单语义相同,统一成一个字段后 positionSlippage 与进场护栏一行不改。
  referencePrice: number;
  // —— 归因(仅日志与展示,不参与任何开仓判定)
  sourceKind: FollowSourceKind;
  walletCount: number;
  totalNetUsd: number;
}

/**
 * Detector 的只读上下文。**全部是数据,没有 DB 句柄** —— detector 必须是纯函数,
 * 便于单测(对齐 detectConsensus/detectDisagreement 的既有纪律)。DB 查询
 * (wallet_candidates、tilt 历史)由 runFollowCycle 每轮预取一次后填进来。
 */
export interface DetectorCtx {
  smart: Map<string, SmartTag>;
  nowSec: number;
  /** 每轮只算一次的分歧结果,所有策略共享(阈值与策略无关)。 */
  contested: DisagreementMarket[];
  /** early_winner 渠道发现的钱包(小写),D2 用。 */
  earlyWinnerWallets: Set<string>;
  /** 上一轮各市场的 tilt 快照,C2 判定「少数边转净卖」用。 */
  prevTilt: Map<string, MarketTiltSnapshot>;
}

/** 一个市场在某一时刻的分歧快照(落在 market_tilt_history 表)。 */
export interface MarketTiltSnapshot {
  conditionId: string;
  /** 主导边的 outcome。 */
  leadOutcome: string;
  /** 少数边的 outcome(sides[1])。 */
  minorOutcome: string;
  /** 少数边的累计净买(USD)。转净卖的判定基准。 */
  minorNetUsd: number;
  tiltPct: number;
  ts: number;
}

export type Detector = (
  trades: Trade[],
  params: StrategyParams,
  ctx: DetectorCtx,
) => FollowCandidate[];

/**
 * 一条策略解析后的参数。通用字段全部必填(parseStrategy 已兜好默认),
 * source 专属字段可选 —— 各 detector 自己校验并在缺失时产出空候选 + 日志。
 */
export interface StrategyParams {
  /**
   * follow_strategies 行 id。只用于日志定位 —— 12 档并行时,不带 id 的日志
   * (「剔除 3 个共识组」)无法回答「是哪条策略」,可诊断性会比单档时代倒退。
   * 不参与任何检测判定。
   */
  id: number;
  source: FollowSourceKind;
  sizeUsd: number;
  exitRule: string;
  maxEntryDeviationCents: number;
  maxPrice: number;
  freshSec: number;
  // consensus 专属
  minWallets?: number;
  minPerWalletUsd?: number;
  minTotalNetUsd?: number | null;
  // consensus / heavy / lone_wolf 共用
  minWalletScore?: number | null;
  // heavy 专属
  minSingleFillUsd?: number;
  // lopsided / resolved 专属
  minTiltPct?: number;
  minPerSideUsd?: number;
  // lone_wolf / early_winner 专属
  minNetUsd?: number;
}
```

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/followCandidate.test.ts`
Expected: PASS (3 tests)

**Step 5: 提交**

```bash
git add lib/followCandidate.ts lib/followCandidate.test.ts
git commit -m "feat: FollowCandidate 统一候选契约 —— 信号检测与开仓解耦的地基"
```

---

### Task 2: consensus detector（提取现有逻辑，行为完全不变）

这一步**不加任何新门槛**，只把 `runFollowCycle` 里 `follow.ts:263-296` 那段搬成一个纯函数。行为逐字节不变是本任务的唯一验收标准。

**Files:**

- Create: `lib/sourceConsensus.ts`
- Test: `lib/sourceConsensus.test.ts`

**Step 1: 写失败测试**

```ts
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
    title: "Market",
    slug: "slug",
    eventSlug: "event",
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
  // 1500 而非 2000:mk() 默认 timestamp=1000、params() 默认 freshSec=900,
  // 取 2000 会让 2000−1000=1000 > 900,默认 fixture 被新鲜度闸门剔成空,
  // 与「产出一个候选」的用例自相矛盾。
  nowSec: 1500,
  contested: [],
  earlyWinnerWallets: new Set(),
  prevTilt: new Map(),
  ...over,
});

const params = (over: Partial<StrategyParams> = {}): StrategyParams => ({
  source: "consensus",
  sizeUsd: 500,
  exitRule: "settlement",
  maxEntryDeviationCents: 10,
  maxPrice: 0.95,
  freshSec: 900,
  id: 1,
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
    expect(out[0].sourceKind).toBe("consensus");
    expect(out[0].conditionId).toBe("0xc");
    expect(out[0].outcome).toBe("Yes");
    expect(out[0].walletCount).toBe(2);
    // referencePrice = 聪明钱加权均价(此处两笔同价 0.5)
    expect(out[0].referencePrice).toBeCloseTo(0.5);
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

  it("参数缺失(minWallets/minPerWalletUsd)→ 空候选,不抛错", () => {
    const trades = [mk({ proxyWallet: "0xA" }), mk({ proxyWallet: "0xB" })];
    const bad = { ...params(), minWallets: undefined };
    expect(detectConsensusCandidates(trades, bad, ctx())).toHaveLength(0);
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/sourceConsensus.test.ts`
Expected: FAIL — `Failed to resolve import "./sourceConsensus"`

**Step 3: 最小实现**

```ts
// lib/sourceConsensus.ts
import { detectConsensus } from "./consensus";
import type {
  DetectorCtx,
  FollowCandidate,
  StrategyParams,
} from "./followCandidate";
import { excludeContestedFromConsensus } from "./marketSignals";
import type { Trade } from "./types";

/**
 * 族 A:共识候选。这一版是 runFollowCycle 原有逻辑(follow.ts:263-296)的等价提取 ——
 * 每策略各跑一次 detectConsensus(不能用最松阈值跑一次再复筛:formationTs 的跨线
 * 时刻依赖该策略自己的 minPerWalletUsd)、分歧互斥、新鲜度闸门,顺序与语义完全不变。
 *
 * formationTs = g.formationTs(第 minWallets 个合格钱包跨线时刻)。不能用 lastTs ——
 * 后者被组内任何白名单成交(含 SELL、含不达标非成员)刷新,会把老共识"续命"成新鲜。
 * referencePrice = g.avgBuyPrice(聪明钱加权均价)。
 */
export function detectConsensusCandidates(
  trades: Trade[],
  params: StrategyParams,
  ctx: DetectorCtx,
): FollowCandidate[] {
  const { minWallets, minPerWalletUsd } = params;
  if (minWallets == null || minPerWalletUsd == null) {
    console.warn(
      `[follow] strategy ${params.id} (consensus) minWallets/minPerWalletUsd 缺失,本策略本轮无候选`,
    );
    return [];
  }
  const groups = detectConsensus(trades, ctx.smart, {
    minWallets,
    minPerWalletUsd,
  });
  const uncontested = excludeContestedFromConsensus(groups, ctx.contested);
  const dropped = groups.length - uncontested.length;
  if (dropped > 0) {
    console.log(
      `[follow] strategy ${params.id} 分歧互斥:剔除 ${dropped} 个单边共识组(聪明钱两边都买 → 不跟)`,
    );
  }
  const fresh = uncontested.filter(
    (g) => ctx.nowSec - g.formationTs <= params.freshSec,
  );
  const stale = uncontested.length - fresh.length;
  if (stale > 0) {
    console.log(
      `[follow] strategy ${params.id} 新鲜度闸门:跳过 ${stale} 个陈旧共识组(formationTs 距 now > ${params.freshSec}s),不补开历史`,
    );
  }
  return fresh.map((g) => ({
    conditionId: g.conditionId,
    outcome: g.outcome,
    outcomeIndex: g.outcomeIndex,
    asset: g.asset,
    title: g.title,
    slug: g.slug,
    eventSlug: g.eventSlug,
    formationTs: g.formationTs,
    referencePrice: g.avgBuyPrice,
    sourceKind: "consensus" as const,
    walletCount: g.walletCount,
    totalNetUsd: g.totalNetUsd,
  }));
}
```

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/sourceConsensus.test.ts`
Expected: PASS (5 tests)

**Step 5: 提交**

```bash
git add lib/sourceConsensus.ts lib/sourceConsensus.test.ts
git commit -m "feat: consensus detector —— 等价提取 runFollowCycle 的共识检测段"
```

---

### Task 3: `parseStrategy` 扩展（source / maxPrice / freshSec，向后兼容）

**这是整个计划的守门员任务。** 兼容测试挂了就停下来。

**Files:**

- Modify: `lib/follow.ts`（`FollowStrategy` 接口 + `parseStrategy` + `parseParamsView`）
- Test: `lib/follow.test.ts`（追加一组 describe）

**Step 1: 写失败测试**

```ts
// 追加到 lib/follow.test.ts 末尾
import { parseStrategyForTest } from "./follow";

describe("parseStrategy — source/maxPrice/freshSec 扩展", () => {
  it("向后兼容:无 source 字段 → consensus,且旧字段逐字段不变", () => {
    const old = JSON.stringify({
      minWallets: 3,
      minPerWalletUsd: 10000,
      sizeUsd: 500,
      exitRule: "settlement",
      maxEntryDeviationCents: 10,
    });
    const s = parseStrategyForTest(1, old);
    expect(s).not.toBeNull();
    expect(s!.source).toBe("consensus");
    expect(s!.minWallets).toBe(3);
    expect(s!.minPerWalletUsd).toBe(10000);
    expect(s!.sizeUsd).toBe(500);
    expect(s!.exitRule).toBe("settlement");
    expect(s!.maxEntryDeviationCents).toBe(10);
    // 新字段走默认
    expect(s!.maxPrice).toBe(0.95);
    expect(s!.freshSec).toBe(900);
  });

  it("未知 source → 跳过该策略(返回 null)", () => {
    const s = parseStrategyForTest(
      2,
      JSON.stringify({ source: "accumulate", sizeUsd: 500 }),
    );
    expect(s).toBeNull();
  });

  it("非 consensus 源不再强制要求 minWallets/minPerWalletUsd", () => {
    const s = parseStrategyForTest(
      3,
      JSON.stringify({
        source: "heavy",
        sizeUsd: 500,
        minSingleFillUsd: 50000,
      }),
    );
    expect(s).not.toBeNull();
    expect(s!.source).toBe("heavy");
    expect(s!.minSingleFillUsd).toBe(50000);
  });

  it("consensus 源仍强制要求 minWallets/minPerWalletUsd", () => {
    const s = parseStrategyForTest(
      4,
      JSON.stringify({ source: "consensus", sizeUsd: 500 }),
    );
    expect(s).toBeNull();
  });

  it("maxPrice/freshSec 非法值退默认(只有 >0 的有限数生效)", () => {
    const s = parseStrategyForTest(
      5,
      JSON.stringify({
        minWallets: 2,
        minPerWalletUsd: 5000,
        sizeUsd: 500,
        maxPrice: 0,
        freshSec: -1,
      }),
    );
    expect(s!.maxPrice).toBe(0.95);
    expect(s!.freshSec).toBe(900);
  });

  it("maxPrice > 1 视为非法(价格是 0-1 小数)", () => {
    const s = parseStrategyForTest(
      6,
      JSON.stringify({
        minWallets: 2,
        minPerWalletUsd: 5000,
        sizeUsd: 500,
        maxPrice: 95,
      }),
    );
    expect(s!.maxPrice).toBe(0.95);
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/follow.test.ts -t "source/maxPrice/freshSec"`
Expected: FAIL — `parseStrategyForTest` is not exported

**Step 3: 实现**

在 `lib/follow.ts`：

```ts
// 新增默认常量,与 alertConditions 的 maxPrice 同口径。
// 生产实测(见 alertConditions.ts:29):28.6% 的告警落在 >=0.90 —— 近确定结果上的
// 结算清扫单,零信息量。跟单此前没有任何价格上限,账本里混着「买 0.97 赚 3¢」的
// 仓:胜率被拉得很高很好看,但每次翻车亏掉 30 次的利润(赔率极度不对称,Wilson
// 区间衡量的是胜率不确定性,救不了这个)。故设为全局基础参数而非某档的可选项。
const DEFAULT_MAX_PRICE = 0.95;
// 新鲜度闸门默认值,从 FollowCycleDeps 的全局参数下放到每策略(A5 首发共识要 300)。
const DEFAULT_FRESH_SEC = 900;
```

`FollowStrategy` 直接改成 `StrategyParams`（复用 `followCandidate.ts` 的定义，不再另立一套）。`id` 已是 `StrategyParams` 的必填字段（Task 2 的实测教训：12 档并行时不带 id 的 detector 日志无法定位是哪条策略），所以不需要再交叉类型。

**顺手清一个契约瑕疵（Task 1 审查发现）：** `StrategyParams` 里 `minTotalNetUsd?: number | null` / `minWalletScore?: number | null` 与其余 `minXxx?: number` 的可空性不一致。`numOr` 从不区分「字段缺失」和「字段显式为 null」，消费方也统一用 `== null`，所以这个 `| null` **不承载任何独立于 `undefined` 的语义** —— 它是从设计文档的 JSON 示例机械转录来的。本任务把这两个字段统一成 `?: number`（`parseStrategy` 里对应改成 `?? undefined`），别让一个未经论证的不对称在后面 5 个 detector 里继续复制。

`parseStrategy` 改造要点：

```ts
function parseStrategy(
  id: number,
  paramsJson: string | null,
): StrategyParams | null {
  // ... 现有 JSON.parse + numOr 不变 ...

  // source:缺失 → "consensus"(既有两条策略零迁移);未知值 → 跳过整条策略。
  const rawSource = p.source ?? "consensus";
  if (!isFollowSourceKind(rawSource)) {
    console.warn(
      `[follow] strategy ${id}: 未知 source "${String(rawSource)}",跳过`,
    );
    return null;
  }

  const sizeUsd = numOr(p.sizeUsd);
  if (sizeUsd == null || sizeUsd <= 0) {
    console.warn(`[follow] strategy ${id}: sizeUsd 无效,跳过`);
    return null;
  }

  // consensus 源仍强制要求这两个阈值(它们决定 formationTs 的跨线时刻);
  // 其它源各有自己的必需字段,由对应 detector 校验并在缺失时产出空候选。
  const minWallets = numOr(p.minWallets);
  const minPerWalletUsd = numOr(p.minPerWalletUsd);
  if (
    rawSource === "consensus" &&
    (minWallets == null || minPerWalletUsd == null)
  ) {
    console.warn(
      `[follow] strategy ${id}: consensus 源缺 minWallets/minPerWalletUsd,跳过`,
    );
    return null;
  }

  // 护栏/价格/新鲜度:显式合法值生效,缺失或非法退默认(既有库无这些字段,靠这里兜底)。
  const maxDev = numOr(p.maxEntryDeviationCents);
  const maxPrice = numOr(p.maxPrice);
  const freshSec = numOr(p.freshSec);

  return {
    id,
    source: rawSource,
    sizeUsd,
    exitRule: typeof p.exitRule === "string" ? p.exitRule : "settlement",
    maxEntryDeviationCents:
      maxDev != null && maxDev > 0 ? maxDev : DEFAULT_MAX_ENTRY_DEVIATION_CENTS,
    // 价格是 0-1 小数,>1 一律视为非法(防把 95 当成 95¢ 写进来)。
    maxPrice:
      maxPrice != null && maxPrice > 0 && maxPrice <= 1
        ? maxPrice
        : DEFAULT_MAX_PRICE,
    freshSec: freshSec != null && freshSec > 0 ? freshSec : DEFAULT_FRESH_SEC,
    minWallets: minWallets ?? undefined,
    minPerWalletUsd: minPerWalletUsd ?? undefined,
    minTotalNetUsd: numOr(p.minTotalNetUsd) ?? undefined,
    minWalletScore: numOr(p.minWalletScore) ?? undefined,
    minSingleFillUsd: numOr(p.minSingleFillUsd) ?? undefined,
    minTiltPct: numOr(p.minTiltPct) ?? undefined,
    minPerSideUsd: numOr(p.minPerSideUsd) ?? undefined,
    minNetUsd: numOr(p.minNetUsd) ?? undefined,
  };
}

// 测试导出:parseStrategy 是模块私有的,但它的兼容性是整个扩充的守门员,
// 必须能被直接单测(而不是只能透过 runFollowCycle 间接观察)。
export const parseStrategyForTest = parseStrategy;
```

同步更新 `parseParamsView`（展示侧）：补 `source` / `maxPrice` / `freshSec` 三个字段，默认值与开仓侧**同源常量**——两侧默认值永远一致是既有约定（见 `follow.ts:1071` 注释）。

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/follow.test.ts`
Expected: PASS — 新增 6 个 + **原有全部测试仍通过**（这是守门员断言）

**Step 5: 提交**

```bash
git add lib/follow.ts lib/follow.test.ts
git commit -m "feat: parseStrategy 扩展 source/maxPrice/freshSec —— 缺 source 即 consensus,零迁移"
```

---

### Task 4: `runFollowCycle` 接入注册表 + `maxPrice` 闸门 + 轮内缓存

**Files:**

- Modify: `lib/follow.ts`（`runFollowCycle` 的检测段与开仓段）
- Modify: `lib/followCandidate.ts`（补 `DETECTORS` 注册表）
- Test: `lib/followCycle.test.ts`（追加）

**Step 1: 写失败测试**

```ts
// 追加到 lib/followCycle.test.ts
describe("runFollowCycle — maxPrice 闸门", () => {
  it("entry 高于 maxPrice → 不开仓", async () => {
    // 构造一个 2 钱包共识,fetchPrice 返回 0.96 > 默认 0.95
    const db = openDb(":memory:");
    // ... 沿用本文件既有的 seed/deps 构造辅助 ...
    const r = await runFollowCycle(depsWith({ price: 0.96 }));
    expect(r.opened).toBe(0);
  });

  it("entry 等于 maxPrice → 照常开仓(边界:严格 >)", async () => {
    const r = await runFollowCycle(depsWith({ price: 0.95 }));
    expect(r.opened).toBe(1);
  });
});

describe("runFollowCycle — 轮内价格缓存", () => {
  it("同一 asset 被多条策略命中时 fetchPrice 只调用一次", async () => {
    // 两条策略(保守 3×$10k / 激进 2×$5k)都能命中同一组:构造 3 个各净买 $10k 的钱包
    const calls: string[] = [];
    const deps = depsWithTwoStrategies({
      fetchPrice: async (asset: string) => {
        calls.push(asset);
        return 0.5;
      },
    });
    await runFollowCycle(deps);
    // 两条策略 → 两仓,但现价只取一次
    expect(calls.filter((a) => a === "asset1")).toHaveLength(1);
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/followCycle.test.ts`
Expected: FAIL — 第一个用例 `opened` 为 1（当前无价格上限）

**Step 3: 实现**

`lib/followCandidate.ts` 补注册表：

```ts
import { detectConsensusCandidates } from "./sourceConsensus";

// 注册表:新增信号源 = 写一个纯函数 + 在这里加一行,开仓代码零改动。
export const DETECTORS: Record<FollowSourceKind, Detector> = {
  consensus: detectConsensusCandidates,
  // 后续 Task 逐个填入
  heavy: () => [],
  lopsided: () => [],
  resolved: () => [],
  lone_wolf: () => [],
  early_winner: () => [],
};
```

`runFollowCycle` 三处改造：

1. **检测段**：`follow.ts:262-297` 整段替换为按 `source` 查表分派。`detectDisagreement` 每轮仍**只算一次**（阈值与策略无关），结果放进 `DetectorCtx.contested`。detector 抛错要 catch 住 —— 一个源炸掉不该拖垮其他策略：

```ts
const candidatesByStrategy = new Map<number, FollowCandidate[]>();
if (!truncated && strategies.length > 0 && trades.length > 0) {
  const contested = detectDisagreement(trades, smart, DEFAULT_DISAGREEMENT);
  const ctx: DetectorCtx = {
    smart,
    nowSec,
    contested,
    earlyWinnerWallets, // Task 13 填充,在此之前是空 Set
    prevTilt, // Task 11 填充,在此之前是空 Map
  };
  for (const s of strategies) {
    try {
      candidatesByStrategy.set(s.id, DETECTORS[s.source](trades, s, ctx));
    } catch (e) {
      // 单个 detector 的异常只该影响这一条策略,杀不死其它策略与后面的结算段。
      console.warn(
        `[follow] strategy ${s.id} (${s.source}) detector 抛错,本轮无候选:`,
        e,
      );
      candidatesByStrategy.set(s.id, []);
    }
  }
}
```

2. **开仓段**：把 `g.*` 换成 `c.*`（字段名已对齐，`g.avgBuyPrice` → `c.referencePrice`）。在取到 `entry` 之后、偏离护栏**之前**插入价格上限：

```ts
// 价格上限:拦的是 entry(我们的实际入场价),不是 referencePrice —— 清扫仓的问题
// 是「我们买在 0.97」,不是「聪明钱买在 0.97」。严格 >:0.95 可开、0.951 不可。
// 与偏离护栏同为瞬时态,不写查重,下轮价格回落仍可正常跟进。
if (entry > s.maxPrice) {
  console.log(
    `[follow] strategy ${s.id} 组 ${c.conditionId}/${c.outcome}: 现价 ${(entry * 100).toFixed(1)}¢ ` +
      `> 价格上限 ${(s.maxPrice * 100).toFixed(1)}¢(近确定结果的结算清扫,零信息量),跳过开仓`,
  );
  continue;
}
```

3. **轮内缓存**：在 `runFollowCycle` 开头 new 三个 `createPromiseCache`，包住三个 fetcher。

```ts
// 轮内共享:12 档下同一 asset 会被多条策略反复取价(参数完全相同)。
// createPromiseCache 缓存的是 PROMISE 而非值,所以即使多条策略在串行 await 循环里
// 先后走到,第一个发起后其余直接拿到同一个 in-flight promise,一次往返都不多花。
// 每轮 new 实例(而非设时间 TTL):语义最干净 —— 轮内共享、轮间必须重取。
const priceCache = createPromiseCache<number | null>(Infinity);
const formationCache = createPromiseCache<number | null>(Infinity);
const bookCache = createPromiseCache<AskBook | null>(Infinity);
const priceOnce = (a: string, t: number) =>
  priceCache(`${a}:${t}`, () => fetchPrice(a, t));
```

> **注意** markout 回填段**不要**走 `priceOnce` —— 它按 `(asset, formation_ts+Δ)` 取，key 天然不同，走缓存只是徒增内存；且它的失败要能逐仓重试。

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/`
Expected: PASS — 全套通过（含既有 625 个）

**Step 5: 提交**

```bash
git add lib/follow.ts lib/followCandidate.ts lib/followCycle.test.ts
git commit -m "feat: runFollowCycle 接入 detector 注册表 + maxPrice 闸门 + 轮内价格缓存"
```

---

## 阶段 2 — 族 A 扩充（A3 精英 / A4 重仓 / A5 首发）

### Task 5: consensus detector 加质量与总额门槛

A5 首发共识不需要改代码（`freshSec` 已在 Task 3 每策略化），只需种子里配 `freshSec: 300`。

**Files:**

- Modify: `lib/sourceConsensus.ts`
- Test: `lib/sourceConsensus.test.ts`

**Step 1: 写失败测试**

```ts
describe("detectConsensusCandidates — A3 质量门槛", () => {
  it("minWalletScore=80:合格钱包中低于 80 分的不计入人数", () => {
    const smart = new Map([
      ["0xa", tag({ score: 90 })],
      ["0xb", tag({ score: 50 })], // 分不够
    ]);
    const out = detectConsensusCandidates(
      [mk({ proxyWallet: "0xA" }), mk({ proxyWallet: "0xB" })],
      params({ minWalletScore: 80 }),
      ctx({ smart }),
    );
    // 只剩 1 个够格钱包 < minWallets(2) → 无候选
    expect(out).toHaveLength(0);
  });

  it("score 为 null(未知)视为不达标 —— 不把未知当合格", () => {
    const smart = new Map([
      ["0xa", tag({ score: 90 })],
      ["0xb", tag({ score: null })],
    ]);
    const out = detectConsensusCandidates(
      [mk({ proxyWallet: "0xA" }), mk({ proxyWallet: "0xB" })],
      params({ minWalletScore: 80 }),
      ctx({ smart }),
    );
    expect(out).toHaveLength(0);
  });

  it("两个都够分 → 产出候选,walletCount 只数够分的", () => {
    const smart = new Map([
      ["0xa", tag({ score: 90 })],
      ["0xb", tag({ score: 85 })],
    ]);
    const out = detectConsensusCandidates(
      [mk({ proxyWallet: "0xA" }), mk({ proxyWallet: "0xB" })],
      params({ minWalletScore: 80 }),
      ctx({ smart }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].walletCount).toBe(2);
  });
});

describe("detectConsensusCandidates — A4 总额门槛", () => {
  it("minTotalNetUsd=100000:总净买不足 → 无候选", () => {
    const out = detectConsensusCandidates(
      [mk({ proxyWallet: "0xA" }), mk({ proxyWallet: "0xB" })], // 各 $10k
      params({ minTotalNetUsd: 100_000 }),
      ctx(),
    );
    expect(out).toHaveLength(0);
  });

  it("总额达标 → 产出候选", () => {
    const big = { size: 200_000, price: 0.5 }; // $100k/笔
    const out = detectConsensusCandidates(
      [mk({ proxyWallet: "0xA", ...big }), mk({ proxyWallet: "0xB", ...big })],
      params({ minTotalNetUsd: 100_000 }),
      ctx(),
    );
    expect(out).toHaveLength(1);
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/sourceConsensus.test.ts`
Expected: FAIL — 门槛未实现，全部产出候选

**Step 3: 实现**

在 `fresh.map(...)` 之前插入两道过滤：

```ts
// A3 质量门槛:score 是 ConsensusWallet 已经带的字段(consensus.ts:23),
// detectConsensus 从没拿它做过门槛。score===null(未知)视为不达标 —— 与
// walletStats「不把未知当合格」的既有纪律一致,宁可漏跟不可误开。
// 注意重算 walletCount:够分的人数才是这一档意义上的"共识人数"。
const scored =
  params.minWalletScore == null
    ? fresh
    : fresh
        .map((g) => ({
          g,
          qualified: g.wallets.filter(
            (w) => w.score != null && w.score >= params.minWalletScore!,
          ),
        }))
        .filter((x) => x.qualified.length >= minWallets)
        .map((x) => ({
          ...x.g,
          wallets: x.qualified,
          walletCount: x.qualified.length,
        }));

// A4 总额门槛:totalNetUsd 也是现成字段。
const sized =
  params.minTotalNetUsd == null
    ? scored
    : scored.filter((g) => g.totalNetUsd >= params.minTotalNetUsd!);
```

> **不重算 `referencePrice`。** A3 过滤掉低分钱包后，理论上加权均价应随之变化，但 `avgBuyPrice` 是 `detectConsensus` 在**全部**合格钱包上算的。这里刻意不重算：`referencePrice` 的用途是护栏基准与追价成本，用"全体聪明钱的成本"比"筛选后子集的成本"更贴近"我们相对市场买贵了多少"这个语义。若将来要改，必须同时更新 `positionSlippage` 的口径说明。

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/sourceConsensus.test.ts`
Expected: PASS

**Step 5: 提交**

```bash
git add lib/sourceConsensus.ts lib/sourceConsensus.test.ts
git commit -m "feat: 共识档位加质量(A3)与总额(A4)门槛 —— 复用已在结构里的 score/totalNetUsd"
```

---

## 阶段 3 — 族 B 异常大额

### Task 6: heavy detector

**Files:**

- Create: `lib/sourceHeavy.ts`
- Test: `lib/sourceHeavy.test.ts`

**Step 1: 写失败测试**

```ts
describe("detectHeavyCandidates", () => {
  it("单笔 >= minSingleFillUsd 的白名单 BUY → 一个候选", () => {
    const out = detectHeavyCandidates(
      [mk({ proxyWallet: "0xA", size: 200_000, price: 0.25 })], // $50k
      params({ source: "heavy", minSingleFillUsd: 50_000 }),
      ctx(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].sourceKind).toBe("heavy");
    expect(out[0].walletCount).toBe(1);
    // formationTs = 那一笔的 timestamp;referencePrice = 那一笔的成交价
    expect(out[0].formationTs).toBe(1000);
    expect(out[0].referencePrice).toBeCloseTo(0.25);
    expect(out[0].totalNetUsd).toBeCloseTo(50_000);
  });

  it("差一点点($49,999)→ 无候选", () => {
    const out = detectHeavyCandidates(
      [mk({ proxyWallet: "0xA", size: 199_996, price: 0.25 })],
      params({ source: "heavy", minSingleFillUsd: 50_000 }),
      ctx(),
    );
    expect(out).toHaveLength(0);
  });

  it("SELL 不算 —— heavy 的语义是买入", () => {
    const out = detectHeavyCandidates(
      [mk({ proxyWallet: "0xA", side: "SELL", size: 400_000, price: 0.25 })],
      params({ source: "heavy", minSingleFillUsd: 50_000 }),
      ctx(),
    );
    expect(out).toHaveLength(0);
  });

  it("非白名单钱包不算", () => {
    const out = detectHeavyCandidates(
      [mk({ proxyWallet: "0xSTRANGER", size: 400_000, price: 0.25 })],
      params({ source: "heavy", minSingleFillUsd: 50_000 }),
      ctx(),
    );
    expect(out).toHaveLength(0);
  });

  it("做市商钱包不算(与 consensus/disagreement 同纪律)", () => {
    const smart = new Map([["0xa", tag({ isMarketMaker: true })]]);
    const out = detectHeavyCandidates(
      [mk({ proxyWallet: "0xA", size: 400_000, price: 0.25 })],
      params({ source: "heavy", minSingleFillUsd: 50_000 }),
      ctx({ smart }),
    );
    expect(out).toHaveLength(0);
  });

  it("不受分歧互斥约束(D6):争议市场照跟", () => {
    const out = detectHeavyCandidates(
      [mk({ proxyWallet: "0xA", size: 200_000, price: 0.25 })],
      params({ source: "heavy", minSingleFillUsd: 50_000 }),
      ctx({ contested: [{ conditionId: "0xc" }] as never }),
    );
    expect(out).toHaveLength(1);
  });

  it("同一 (市场,方向) 多笔达标 → 折叠成一个候选,取最大那笔", () => {
    const out = detectHeavyCandidates(
      [
        mk({
          proxyWallet: "0xA",
          transactionHash: "0x1",
          size: 200_000,
          price: 0.25,
          timestamp: 1000,
        }),
        mk({
          proxyWallet: "0xB",
          transactionHash: "0x2",
          size: 400_000,
          price: 0.25,
          timestamp: 1200,
        }),
      ],
      params({ source: "heavy", minSingleFillUsd: 50_000 }),
      ctx(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].totalNetUsd).toBeCloseTo(100_000); // 取最大那笔
    expect(out[0].formationTs).toBe(1200); // 也取最大那笔的时刻
  });

  it("新鲜度闸门照常生效", () => {
    const out = detectHeavyCandidates(
      [mk({ proxyWallet: "0xA", size: 200_000, price: 0.25, timestamp: 1000 })],
      params({ source: "heavy", minSingleFillUsd: 50_000 }),
      ctx({ nowSec: 100_000 }),
    );
    expect(out).toHaveLength(0);
  });

  it("B3:minWalletScore 生效", () => {
    const smart = new Map([["0xa", tag({ score: 50 })]]);
    const out = detectHeavyCandidates(
      [mk({ proxyWallet: "0xA", size: 200_000, price: 0.25 })],
      params({ source: "heavy", minSingleFillUsd: 50_000, minWalletScore: 80 }),
      ctx({ smart }),
    );
    expect(out).toHaveLength(0);
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/sourceHeavy.test.ts`
Expected: FAIL — 模块不存在

**Step 3: 实现**

```ts
// lib/sourceHeavy.ts
import type {
  DetectorCtx,
  FollowCandidate,
  StrategyParams,
} from "./followCandidate";
import { dedupKey, notionalUsd } from "./trades";
import type { Trade } from "./types";

/**
 * 族 B:单笔巨额买入。判据对齐推送侧的 signalFeed.foldHeavy —— 单个白名单钱包
 * 单笔 BUY notional >= minSingleFillUsd(生产阈值 $50k)。这一族上线即补上
 * 「推了不跟」的核心盲区:推送有三种 SignalKind,跟单此前只接了 consensus 一种。
 *
 * 与 foldHeavy 的**唯一有意差异**:不继承「consensus 已覆盖该 market+outcome 就
 * 抑制」那条规则。那是展示逻辑(一个市场不占两张卡),而跟单要的是归因逻辑 ——
 * 只有让 B 族与 A 族在同一市场各开各的仓,才能对比「共识 vs 单笔巨鲸谁更准」;
 * 抑制掉等于让 heavy 只在 consensus 失败的市场取样,样本被系统性偏置。
 * 代价是跨档持仓重叠(设计文档 §9.1 已声明:各档战绩不可相加)。
 *
 * 不受分歧互斥约束(D6):heavy 的语义是「这一笔单本身就是信号」,不依赖别的
 * 聪明钱怎么想。
 *
 * formationTs = 那一笔的 timestamp(单笔信号,无"形成过程",天然精确)。
 * referencePrice = 那一笔的成交价。
 */
export function detectHeavyCandidates(
  trades: Trade[],
  params: StrategyParams,
  ctx: DetectorCtx,
): FollowCandidate[] {
  const floor = params.minSingleFillUsd;
  if (floor == null || floor <= 0) {
    console.warn("[follow/heavy] minSingleFillUsd 缺失或非正,本策略本轮无候选");
    return [];
  }
  const seen = new Set<string>();
  // 同一 (市场,方向) 折叠成一个候选,取 notional 最大的那笔 —— 一个方向只开一仓,
  // 多笔达标时最大那笔是最强的证据,它的 ts/price 即候选的 formationTs/referencePrice。
  const byKey = new Map<string, FollowCandidate>();
  for (const t of trades) {
    if (t.side !== "BUY") continue;
    const wallet = t.proxyWallet.toLowerCase();
    const tag = ctx.smart.get(wallet);
    // MM 剔除:与 detectConsensus/detectDisagreement 同一道闸(P0.5)。做市商的
    // 大额吃单是库存再平衡,不是方向性意见。
    if (!tag || tag.isMarketMaker) continue;
    // B3 质量门槛:score===null(未知)视为不达标,与 A3 同纪律。
    if (
      params.minWalletScore != null &&
      (tag.score == null || tag.score < params.minWalletScore)
    ) {
      continue;
    }
    // 分页边界会重发同一行,一个 tx 也可能含多笔 fill —— 先去重再比阈值。
    const dk = dedupKey(t);
    if (seen.has(dk)) continue;
    seen.add(dk);

    const usd = notionalUsd(t);
    if (usd < floor) continue;
    if (ctx.nowSec - t.timestamp > params.freshSec) continue;

    const key = `${t.conditionId}|${t.outcome}`;
    const prev = byKey.get(key);
    if (prev && prev.totalNetUsd >= usd) continue;
    byKey.set(key, {
      conditionId: t.conditionId,
      outcome: t.outcome,
      outcomeIndex: t.outcomeIndex,
      asset: t.asset,
      title: t.title,
      slug: t.slug,
      eventSlug: t.eventSlug,
      formationTs: t.timestamp,
      referencePrice: t.price,
      sourceKind: "heavy",
      walletCount: 1,
      totalNetUsd: usd,
    });
  }
  return [...byKey.values()];
}
```

注册到 `DETECTORS.heavy`。

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/sourceHeavy.test.ts`
Expected: PASS (9 tests)

**Step 5: 提交**

```bash
git add lib/sourceHeavy.ts lib/sourceHeavy.test.ts lib/followCandidate.ts
git commit -m "feat: heavy detector(族 B)—— 补上推送有、跟单没有的单笔巨额信号"
```

---

## 阶段 4 — 族 C 分歧

### Task 7: `DisagreementSide` 补 `formationTs`（倾斜形成时刻）

**这是全计划技术上最难的一步。** 先读设计文档 §4.3 再动手。

**Files:**

- Modify: `lib/disagreement.ts`
- Test: `lib/disagreement.test.ts`

**Step 1: 写失败测试**

```ts
describe("detectDisagreement — 倾斜形成时刻", () => {
  it("tiltPct 首次跨过阈值的那一刻 = 主导边的 formationTs", () => {
    // t=100: A 买多数边 $6k → 只有一边,未 contested
    // t=200: B 买少数边 $6k → 两边都过 floor,但 tilt=0.5 < 0.7
    // t=300: C 买多数边 $20k → tilt=(6+20)/(6+20+6)=0.81 >= 0.7 ← 倾斜形成
    const trades = [/* 见上 */];
    const out = detectDisagreement(trades, smart, {
      minPerSideUsd: 5000,
      minWalletsPerSide: 1,
      lopsidedTiltPct: 0.7,
    });
    expect(out[0].tilt).toBe("lopsided");
    expect(out[0].sides[0].formationTs).toBe(300);
  });

  it("从未跨过阈值(balanced)→ formationTs 为 null", () => {
    // 两边始终五五开
    const out = detectDisagreement(balancedTrades, smart, opts);
    expect(out[0].tilt).toBe("balanced");
    expect(out[0].sides[0].formationTs).toBeNull();
  });

  it("倾斜后又回落再重新跨过 → 取【首次】跨过的时刻,不被后来的波动重置", () => {
    const out = detectDisagreement(wobbleTrades, smart, opts);
    expect(out[0].sides[0].formationTs).toBe(300); // 首次,不是第二次的 900
  });

  it("重放只认最终主导边:中途曾由另一边领先也不算", () => {
    // t=100~300 由 Under 领先并一度 tilt>=0.7,t=400 后 Over 反超并成为最终主导
    // → formationTs 必须是 Over 侧首次达标的时刻,不是 Under 那次
    const out = detectDisagreement(flipTrades, smart, opts);
    expect(out[0].sides[0].outcome).toBe("Over");
    expect(out[0].sides[0].formationTs).toBe(600);
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/disagreement.test.ts`
Expected: FAIL — `formationTs` 不存在于 `DisagreementSide`

**Step 3: 实现**

给 `DisagreementSide` 加 `formationTs: number | null`，并在 `detectDisagreement` 出结果后做一次**时序重放**：

```ts
/**
 * 「倾斜形成时刻」:tiltPct 首次跨过 lopsidedTiltPct 的那一笔成交时间。
 *
 * 为什么必须单算而不能用 firstTs/lastTs:lastTs 被市场内任何白名单成交(含 SELL、
 * 含不达标钱包)刷新 —— follow.ts:139 那段长注释记录过这个已修掉的 bug(5 小时前的
 * 老共识被一笔 $2k 卖单"续命"成新鲜,按现价跟入 → 买入成本失控)。C1 若拿 lastTs
 * 当 formationTs,等于把它从后门重新引进来。
 *
 * 也不能用「本边成立时刻」(本边净买跨过 minPerSideUsd 那刻):多数边往往早就站住了,
 * 倾斜是后来少数边撤退才形成的 —— 用前者会让 formationTs 落在几小时前,900s 新鲜度
 * 闸门把 C1 全部拦掉,这一档实质是空的。
 *
 * 只认最终主导边(lead):重放中途若由另一边短暂领先并达标,不计 —— 我们要跟的是
 * 「现在这一边赢了这场分歧」的时刻。
 *
 * 从未跨过阈值 → 返回 null。调用方(sourceLopsided)见 null 即不产出候选 ——
 * fail-closed,绝不用 lastTs 之类的兜底值硬开仓。
 */
function tiltFormationTs(
  marketTrades: Trade[],
  leadOutcome: string,
  smartTags: Map<string, SmartTag>,
  excluded: Set<string>, // 已剔除的对冲者/MM,与主检测同一份
  opts: DisagreementOptions,
): number | null {
  const byOutcome = new Map<string, { net: number; weighted: number }>();
  const seen = new Set<string>();
  for (const t of [...marketTrades].sort((a, b) => a.timestamp - b.timestamp)) {
    const wallet = t.proxyWallet.toLowerCase();
    const tag = smartTags.get(wallet);
    if (!tag || tag.isMarketMaker || excluded.has(wallet)) continue;
    const dk = dedupKey(t);
    if (seen.has(dk)) continue;
    seen.add(dk);

    const acc = byOutcome.get(t.outcome) ?? { net: 0, weighted: 0 };
    const usd = notionalUsd(t) * (t.side === "BUY" ? 1 : -1);
    acc.net += usd;
    acc.weighted += usd * qualityWeight(tag.score);
    byOutcome.set(t.outcome, acc);

    // 达标判定:>=2 边过 USD floor,且【最终主导边】的质量权重占比 >= 阈值。
    const qualified = [...byOutcome.entries()].filter(
      ([, v]) => v.net >= opts.minPerSideUsd,
    );
    if (qualified.length < 2) continue;
    const totalW = qualified.reduce(
      (s, [, v]) => s + Math.max(v.weighted, 0),
      0,
    );
    const leadW = Math.max(byOutcome.get(leadOutcome)?.weighted ?? 0, 0);
    if (totalW > 0 && leadW / totalW >= opts.lopsidedTiltPct) {
      return t.timestamp; // 首次达标即返回,后续波动不再重置
    }
  }
  return null;
}
```

> **成本提示**：这是每市场一次的 O(n log n) 重放，只对**已经判定为 contested 的市场**跑（通常每轮个位数），不是对全窗口跑。

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/disagreement.test.ts`
Expected: PASS — 含既有全部用例

**Step 5: 提交**

```bash
git add lib/disagreement.ts lib/disagreement.test.ts
git commit -m "feat: DisagreementSide 补倾斜形成时刻 —— C1 的 formationTs 锚点,不可用 lastTs"
```

---

### Task 8: lopsided detector（C1）

**Files:**

- Create: `lib/sourceLopsided.ts`
- Test: `lib/sourceLopsided.test.ts`

**Step 1: 写失败测试**

```ts
describe("detectLopsidedCandidates", () => {
  it("tilt >= minTiltPct → 跟主导边(sides[0])", () => {
    /* ... */
  });
  it("tilt < minTiltPct(真·势均力敌)→ 无候选", () => {
    /* ... */
  });
  it("formationTs 为 null(倾斜时刻算不出)→ 无候选(fail-closed)", () => {
    /* ... */
  });
  it("referencePrice = 主导边的加权均价", () => {
    /* ... */
  });
  it("新鲜度闸门锚在倾斜形成时刻", () => {
    /* ... */
  });
  it("与 A 族互补:同一市场 A 族不跟时 C1 才跟", () => {
    /* ... */
  });
});
```

**Step 2-5:** 实现要点 —— 从 `ctx.contested` 直接读（每轮已算一次，不重算）：

```ts
export function detectLopsidedCandidates(
  _trades: Trade[],
  params: StrategyParams,
  ctx: DetectorCtx,
): FollowCandidate[] {
  const minTilt = params.minTiltPct ?? 0.7;
  const out: FollowCandidate[] = [];
  for (const m of ctx.contested) {
    if (m.tiltPct < minTilt) continue; // 真·势均力敌 → 谁都不跟
    const lead = m.sides[0];
    // fail-closed:倾斜时刻算不出就不开仓,绝不退回 lastTs(见 Task 7 注释)。
    if (lead.formationTs == null) continue;
    if (ctx.nowSec - lead.formationTs > params.freshSec) continue;
    out.push({
      conditionId: m.conditionId,
      outcome: lead.outcome,
      outcomeIndex: lead.outcomeIndex,
      asset: lead.asset,
      title: m.title,
      slug: m.slug,
      eventSlug: m.eventSlug,
      formationTs: lead.formationTs,
      referencePrice: lead.avgBuyPrice,
      sourceKind: "lopsided",
      walletCount: lead.walletCount,
      totalNetUsd: lead.netUsd,
    });
  }
  return out;
}
```

```bash
git commit -m "feat: lopsided detector(C1)—— 捡回被 excludeContested 一刀切掉的一边倒信号"
```

---

### Task 9: `market_tilt_history` 表 + resolved detector（C2）

**Files:**

- Modify: `lib/db.ts`（建表 + 迁移）
- Create: `lib/sourceResolved.ts`
- Modify: `lib/follow.ts`（每轮读上轮快照 → 填 `ctx.prevTilt`；轮末写本轮快照）
- Test: `lib/sourceResolved.test.ts`、`lib/follow.db.test.ts`

**表结构:**

```sql
CREATE TABLE IF NOT EXISTS market_tilt_history (
  condition_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  lead_outcome TEXT,
  minor_outcome TEXT,
  minor_net_usd REAL,
  tilt_pct REAL,
  PRIMARY KEY (condition_id, ts)
);
```

**判据（D8：少数边开始净卖）:**

```ts
/**
 * C2 分歧解除。触发判据(D8):少数边从净买转为净卖 —— 「有人认输了」。
 *
 * 与其它三个候选判据的区别:tilt 从 <0.7 升到 >=0.7 会与 C1 高度重叠(C1 跟的
 * 正是倾斜形成时刻,C2 会退化成 C1 的子集);「少数边完全消失」则分不清是真撤退
 * 还是窗口滑出。净卖是唯一一个有主动动作、能与 C1 区分开的信号。
 *
 * 需要跨窗口状态:本轮的少数边净额 vs 上一轮快照。首次见到某市场(prevTilt 无
 * 记录)一律不触发 —— 没有"之前"就无所谓"转变"。
 */
export function detectResolvedCandidates(
  _trades: Trade[],
  params: StrategyParams,
  ctx: DetectorCtx,
): FollowCandidate[] {
  const out: FollowCandidate[] = [];
  for (const m of ctx.contested) {
    const prev = ctx.prevTilt.get(m.conditionId);
    if (!prev) continue; // 首见 → 无"之前",不触发
    const lead = m.sides[0];
    const minor = m.sides[1];
    if (!minor) continue;
    // 主导边换人 → 这不是"解除",是翻转,不属于本档语义。
    if (prev.leadOutcome !== lead.outcome) continue;
    // 少数边:上轮净买为正、本轮转负 = 认输。
    if (!(prev.minorNetUsd > 0 && minor.netUsd < 0)) continue;
    out.push({
      conditionId: m.conditionId,
      outcome: lead.outcome,
      outcomeIndex: lead.outcomeIndex,
      asset: lead.asset,
      title: m.title,
      slug: m.slug,
      eventSlug: m.eventSlug,
      // 解除是"本轮才观察到"的事件,锚 nowSec —— 新鲜度天然满足。
      formationTs: ctx.nowSec,
      referencePrice: lead.avgBuyPrice,
      sourceKind: "resolved",
      walletCount: lead.walletCount,
      totalNetUsd: lead.netUsd,
    });
  }
  return out;
}
```

`runFollowCycle` 里的读写：读上轮快照填 `ctx.prevTilt`；轮末写本轮。**写失败只记日志不阻塞开仓**（归因列纪律）。保留期建议 7 天，与 `MARKOUT_MAX_AGE_SEC` 同量级，轮末顺手清理。

```bash
git commit -m "feat: market_tilt_history + resolved detector(C2)—— 少数边转净卖即认输时刻"
```

---

## 阶段 5 — 族 D 钱包画像

### Task 10: lone_wolf detector（D1）

**Files:**

- Create: `lib/sourceWallet.ts`（D1 与 D2 判据同构，共用一个文件与内部实现）
- Test: `lib/sourceWallet.test.ts`

判据：单个钱包在窗口内对某 (市场, 方向) 的**净买**（净股数口径，复用 `netPosition.ts` 的 `netShares`/`avgBuyPrice`，与 `detectConsensus` 的 P0.6 口径一致）≥ `minNetUsd`，且 `score >= minWalletScore`。

`formationTs` = **该钱包净买跨过门槛的那一刻**，实现直接借鉴 `ConsensusWallet.qualifiedTs`（`consensus.ts:27`）的 last-upward-crossing 语义：按时序累加，记录最后一次由 `<floor` 升到 `>=floor` 的成交时刻。

**测试必须覆盖:**

- 跨门槛时刻正确（含"中途跌回再跨则覆盖"）
- `score` 为 null 不达标
- MM 剔除
- 净卖不算（净额为负）
- 不受分歧互斥约束（D6）

```bash
git commit -m "feat: lone_wolf detector(D1)—— 高分单钱包,formationTs 借鉴 qualifiedTs 跨线语义"
```

---

### Task 11: early_winner 钱包预取 + D2

**Files:**

- Modify: `lib/follow.ts`（预取 `earlyWinnerWallets` 填进 `ctx`）
- Modify: `lib/sourceWallet.ts`（`detectEarlyWinnerCandidates` 复用 D1 内部实现，钱包集合换成 `ctx.earlyWinnerWallets`）
- Test: `lib/sourceWallet.test.ts`

预取（`runFollowCycle` 每轮一次，失败降级为空 Set，D2 本轮无候选、不影响他人）：

```ts
let earlyWinnerWallets = new Set<string>();
try {
  const rows = db
    .prepare(
      "SELECT DISTINCT address FROM wallet_candidates WHERE channel = 'early_winner'",
    )
    .all() as { address: string }[];
  earlyWinnerWallets = new Set(rows.map((r) => r.address.toLowerCase()));
} catch (e) {
  console.warn("[follow] early_winner 钱包预取失败,D2 本轮无候选:", e);
}
```

D2 与 D1 的唯一差别：**不看 `score`，看是否属于 `earlyWinnerWallets`**。这批钱包的筛选轴（在 ≤40¢ 且距结算 ≥24h 押中赢家，`earlyWinner.ts:30`）与 `score` 完全正交 —— score 里没有"敢在便宜时下注"这个维度。

```bash
git commit -m "feat: early_winner 跟投(D2)—— 与 score 正交的钱包筛选轴"
```

---

## 阶段 6 — 种子与展示

### Task 12: 策略种子 v2（10 条新档位）

**Files:**

- Modify: `lib/db.ts`（`follow_seed_v` 从 `"1"` 升到 `"2"`）
- Test: `lib/follow.db.test.ts`

**关键:** 版本门控只 `INSERT OR IGNORE` **新增**的 10 条，**绝不 UPDATE 既有两条** —— 保守/激进的历史仓位与战绩必须连续，改它们的参数等于让历史数据失去意义。

```ts
if (followVer?.value !== "2") {
  // v2:新增 10 档(A3-A5 / B1-B3 / C1-C2 / D1-D2)。既有「保守」「激进」两条
  // 一个字段都不动 —— 它们的历史仓位与战绩必须连续,改参数等于让历史失去意义。
  const seeds: [string, Record<string, unknown>][] = [
    [
      "精英共识",
      {
        source: "consensus",
        minWallets: 2,
        minPerWalletUsd: 5000,
        minWalletScore: 80,
        sizeUsd: 500,
      },
    ],
    [
      "重仓共识",
      {
        source: "consensus",
        minWallets: 2,
        minPerWalletUsd: 5000,
        minTotalNetUsd: 100000,
        sizeUsd: 500,
      },
    ],
    [
      "首发共识",
      {
        source: "consensus",
        minWallets: 3,
        minPerWalletUsd: 10000,
        freshSec: 300,
        sizeUsd: 500,
      },
    ],
    ["巨鲸", { source: "heavy", minSingleFillUsd: 50000, sizeUsd: 500 }],
    ["超级巨鲸", { source: "heavy", minSingleFillUsd: 150000, sizeUsd: 500 }],
    [
      "巨鲸精英",
      {
        source: "heavy",
        minSingleFillUsd: 50000,
        minWalletScore: 80,
        sizeUsd: 500,
      },
    ],
    [
      "一边倒分歧",
      {
        source: "lopsided",
        minTiltPct: 0.7,
        minPerSideUsd: 5000,
        sizeUsd: 500,
      },
    ],
    ["分歧解除", { source: "resolved", minPerSideUsd: 5000, sizeUsd: 500 }],
    [
      "高分独狼",
      {
        source: "lone_wolf",
        minWalletScore: 90,
        minNetUsd: 10000,
        sizeUsd: 500,
      },
    ],
    ["早期赢家跟投", { source: "early_winner", minNetUsd: 5000, sizeUsd: 500 }],
  ];
  // 全部继承 exitRule/maxEntryDeviationCents/maxPrice/freshSec 的默认值
  // (parseStrategy 兜底,不必逐条写死 —— 将来调默认值时不用改 12 处)。
  for (const [name, params] of seeds)
    ins.run(name, JSON.stringify(params), now);
  db.prepare(
    "INSERT OR REPLACE INTO config (key, value) VALUES ('follow_seed_v', '2')",
  ).run();
}
```

**测试必须断言:** 升级后共 12 条策略；**保守/激进的 `params_json` 逐字节未变**。

```bash
git commit -m "feat: 策略种子 v2 —— 新增 10 档,既有两条一字不动"
```

---

### Task 13: 展示层 —— 分族呈现 + 口径声明

**Files:**

- Modify: `app/follow/page.tsx`
- Modify: `app/api/follow/route.ts`（`FollowStrategyView.params` 透出 `source`）

按 D7，**只加一句口径声明，不算重叠度矩阵**：

> 各档持仓存在重叠（同一市场可能同时命中多个信号源），**每一档的战绩是"只跟这一档"的独立假设下算出的，不可跨档相加**。同理，「建议跟单额度」也是单档口径。

策略卡按 `source` 分组呈现（共识 / 异常大额 / 分歧 / 钱包画像四组），每组标注该族在回答什么问题。

```bash
git commit -m "feat: 跟单页按信号族分组 + 战绩不可跨档相加的口径声明"
```

---

## 收尾验证

```bash
npm test          # 全套通过
npm run typecheck # 零类型错误
```

**上线后第一轮人工核对（必做，别跳）:**

1. 日志里 12 条策略都有 `[follow] cycle done` 记录，无 `未知 source` / `参数缺失` 警告
2. `maxPrice` 闸门有实际拦截日志 —— 若一条都没拦到，说明清扫仓的假设需要重新验证
3. C1/C2 若长期零候选，先查 `formationTs` 是否恒为 null（Task 7 的重放算错了），**而不是**先去放宽阈值
4. 对比改造前后：保守/激进两档的**新增**仓位数量应与改造前同量级。若骤降，多半是 `maxPrice` 或候选转换出了问题

---

## 技术债 backlog（审查提出、本批不做）

- **抽 `clampFraction(raw, default)` 共享校验**：`parseStrategy`（开仓侧）与 `parseParamsView`（展示侧）各自重新实现了一遍 `maxEntryDeviationCents` / `maxPrice` / `freshSec` 的边界校验 —— 同一判定式、同一常量，两处独立代码，靠注释互相提醒"必须同源"。字段加到三个就该抽了：抽出来能把「两侧必须同步」从**文档承诺**变成**结构保证**。现状靠两组测试（`parseStrategy` 用例 + `buildFollowView` 夹具）兜底，漂移要跑测试才发现。
  （这条约定踩过坑：展示侧若用自己的默认值，界面会显示"无护栏"而实际护栏生效 —— 看板骗人比没看板更糟。）

---

## 本批不做（设计文档 §9.3）

- **退出规则**：`exitRule` 仍是死字段，12 档全部 `settlement`
- **对照组**：随机选边 / 反向跟单 / 随机时点。**在此之前，任何一档的绝对收益都无法区分「策略 alpha」与「市场本身」**
- **吸筹族**（D3 已决定不做）
- **价格带专项档位**：`maxPrice=0.95` 是全局下限保护，长尾/高确定的专项归因档不在本批
