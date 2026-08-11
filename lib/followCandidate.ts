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
 *
 * 故意没有 `truncated` 字段:那是「这轮抓的窗口完不完整」的性质,描述的是窗口
 * 本身的质量,不是任何一条策略的检测输入,不该塞进逐策略传递的 ctx 里。但调用方
 * (runFollowCycle)**必须**在 truncated 时跳过本轮全部 detector 调用,一条都不能
 * 漏 —— 每个 detector 产出的 formationTs 都建立在「窗口完整覆盖跨线区间」这个
 * 前提上:窗口被页数上限/瞬态失败裁短后,截断边缘之前的成交不可见,幸存下来的
 * 可见跨线会把 formationTs 系统性后移,新鲜度闸门与(开仓侧的)形成价护栏被同
 * 一个错误时间戳同时削弱。论证见 lib/follow.ts 的 `FollowCycleDeps.fetchWindow`
 * 字段注释(那里已经详细写过一遍,这里只是提醒调用方别忘了接上)。
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
