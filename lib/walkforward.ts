import { EXIT_RULES } from "./exitCounterfactual";
import { utcWeekStart } from "./followAnalysis";
import type { StrategyParams } from "./followCandidate";

// Walk-forward 阈值重推的纯函数层(2026-08-28,设计见 docs/plans/
// 2026-08-28-walkforward-rederivation-design.md,实现口径见同名实现计划 §0)。
//
// 分层纪律与 detector/exitCounterfactual 相同:本文件**全部是数据进数据出**,
// 没有 DB 句柄、没有时钟、没有 Math.random —— SQL 取数、终端渲染、落库都在
// scripts/walkforward.ts。统计错了比没有更糟(edge-audit 文件头的原话),所以
// 能被合成数据钉死的口径全部放在这里直测。

const DAY = 86_400;
const WEEK = 7 * DAY;

/**
 * validate 折清单:干净窗内**从第 2 个完整周起**的每个 UTC 整周(周一起点秒)。
 *
 * - 第 1 个干净周只做 train(扩张窗的地基,设计 §4.1);闸门起点非周一时,
 *   它所在的残周含闸门前脏数据,首个干净整周顺延到下一个周一。
 * - 跑的当天所在的不完整周不做 validate:「已结算」宇宙在最近的残周里天然
 *   偏向快结算市场,拿它评分是选择偏置(报告代表性一节须披露这层)。
 */
export function listValidateFolds(gateStart: number, nowSec: number): number[] {
  const w1 =
    utcWeekStart(gateStart) === gateStart
      ? gateStart
      : utcWeekStart(gateStart) + WEEK;
  const lastCompleteEnd = utcWeekStart(nowSec);
  const folds: number[] = [];
  for (let s = w1 + WEEK; s + WEEK <= lastCompleteEnd; s += WEEK) {
    folds.push(s);
  }
  return folds;
}

/**
 * 一笔仓按 formation_ts(决策时刻,不是结算时刻 —— 按结算归折会把训练期的
 * 决策泄进验证期)归到哪个 validate 折;不在任何折内(W1/闸门前/窗外)返回
 * null,这些仓只进 train。
 */
export function foldOf(formationTs: number, folds: number[]): number | null {
  for (const s of folds) {
    if (formationTs >= s && formationTs < s + WEEK) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 网格(实现计划 §0.4):单维平移 × 赛道 × 退出,不做维度间全叉积 —— 设计 §5
// 的「≤24 入场变体/档」只在一次只动一维下成立,全叉积还会把 Bonferroni 分母
// 炸大、且多维同动的胜出变体翻译不成一条可解释的挑战者档参数。
// 阶梯全部固定值 ∩ 严格紧于当前生效值(parseStrategy 消毒后的值,含默认兜底);
// 维度参数缺失不猜默认 —— 该维直接不出变体。

/** 入场过滤谓词的数据形态(判定逻辑在 entryMatches,分开是为了网格可枚举可断言)。 */
export type EntrySpec =
  | { kind: "base" }
  /** heavy 单笔下限:回放事实 = strategy_signals.total_net_usd(heavy 的 totalNetUsd 即那一笔)。 */
  | { kind: "minFillUsd"; min: number }
  /** 引擎护栏原样:entry > maxPrice 才拦,故子集条件是 entry ≤ max。 */
  | { kind: "maxPrice"; max: number }
  /** 引擎护栏原样:|entry − formation|×100 ≤ max。 */
  | { kind: "maxDevCents"; max: number }
  | { kind: "minWallets"; min: number }
  /**
   * 均值口径(实现计划 §0.4):逐钱包金额未落库,total/count ≥ X 是「每钱包
   * ≥ X」的必要不充分条件 —— 该子集是真收紧子集的超集,报告固定段落声明。
   */
  | { kind: "minAvgPerWalletUsd"; min: number }
  /** freshSec 近似:entry_ts − formation_ts(检测时新鲜度的落库残影,披露)。 */
  | { kind: "maxStalenessSec"; max: number }
  | { kind: "minTiltPct"; min: number }
  /** 钱包族净买下限 —— 顶替不可回放的 score 维(仓位未记录触发钱包与彼时评分)。 */
  | { kind: "minNetUsd"; min: number };

export type WfCategory = "all" | "sports" | "nonsports";

export interface WfEntryVariant {
  /** 稳定标识(报告/管理页按它认格),如 "minFillUsd:75000";基线 = "base"。 */
  entryKey: string;
  /** 动了哪一维;基线 = "base"。 */
  dim: string;
  label: string;
  spec: EntrySpec;
}

export interface WfCell {
  /** `${entryKey}|${category}|${exitRule}`,全网格唯一。 */
  key: string;
  entry: WfEntryVariant;
  category: WfCategory;
  /** "hold"(实际记录)或 position_exit_sims 的九规则 id。 */
  exitRule: string;
}

/** 退出维度:hold(实际记录的结算持有)+ 九规则查表。 */
export const WF_EXIT_RULES: readonly string[] = [
  "hold",
  ...EXIT_RULES.map((r) => r.id),
];

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

export function buildEntryVariants(p: StrategyParams): WfEntryVariant[] {
  const out: WfEntryVariant[] = [
    {
      entryKey: "base",
      dim: "base",
      label: "当前参数",
      spec: { kind: "base" },
    },
  ];
  const push = (dim: string, spec: EntrySpec, label: string) => {
    const value = "min" in spec ? spec.min : "max" in spec ? spec.max : "";
    out.push({ entryKey: `${spec.kind}:${value}`, dim, label, spec });
  };
  // 乘数阶梯(×1.5/×2):heavy 单笔、consensus 每钱包、钱包族净买共用。
  const scaled = (
    dim: string,
    cur: number | undefined,
    kind: "minFillUsd" | "minAvgPerWalletUsd" | "minNetUsd",
    name: string,
  ) => {
    if (cur == null || cur <= 0) return;
    for (const k of [1.5, 2]) {
      push(dim, { kind, min: cur * k }, `${name} ≥${usd(cur * k)}(×${k})`);
    }
  };
  if (p.source === "heavy") {
    scaled("minSingleFillUsd", p.minSingleFillUsd, "minFillUsd", "单笔下限");
    for (const v of [0.9, 0.85]) {
      if (v < p.maxPrice - 1e-9) {
        push("maxPrice", { kind: "maxPrice", max: v }, `价格上限 ${v * 100}¢`);
      }
    }
    for (const v of [6, 4]) {
      if (v < p.maxEntryDeviationCents) {
        push(
          "maxEntryDeviationCents",
          { kind: "maxDevCents", max: v },
          `形成偏离 ≤${v}¢`,
        );
      }
    }
  } else if (p.source === "consensus") {
    if (p.minWallets != null) {
      push(
        "minWallets",
        { kind: "minWallets", min: p.minWallets + 1 },
        `钱包数 ≥${p.minWallets + 1}(+1)`,
      );
    }
    scaled(
      "minPerWalletUsd",
      p.minPerWalletUsd,
      "minAvgPerWalletUsd",
      "每钱包(均值口径)",
    );
    for (const v of [600, 300]) {
      if (v < p.freshSec) {
        push("freshSec", { kind: "maxStalenessSec", max: v }, `新鲜度 ≤${v}s`);
      }
    }
  } else if (p.source === "lopsided" || p.source === "resolved") {
    if (p.minTiltPct != null && p.minTiltPct + 0.1 < 1) {
      // 千分位取整挡浮点尘埃(0.7+0.1=0.7999…):阈值是人类参数,不是计算结果。
      const v = Math.round((p.minTiltPct + 0.1) * 1000) / 1000;
      push(
        "minTiltPct",
        { kind: "minTiltPct", min: v },
        `倾斜下限 ≥${Math.round(v * 100)}%(+10pp)`,
      );
    }
  } else {
    // lone_wolf / early_winner
    scaled("minNetUsd", p.minNetUsd, "minNetUsd", "净买下限");
  }
  return out;
}

/** 全格 = 入场变体 × {全部,仅体育,仅非体育} × {hold,九退出规则}。 */
export function buildGrid(p: StrategyParams): WfCell[] {
  const cells: WfCell[] = [];
  for (const entry of buildEntryVariants(p)) {
    for (const category of ["all", "sports", "nonsports"] as const) {
      for (const exitRule of WF_EXIT_RULES) {
        cells.push({
          key: `${entry.entryKey}|${category}|${exitRule}`,
          entry,
          category,
          exitRule,
        });
      }
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// 子集过滤(实现计划 §0.2/0.3):一笔仓对一个格 = 进 / 出 / 缺事实三态。
// 缺事实(该维度的落库起点晚于这笔仓、或点查失败)一律剔除并计数 —— 不猜值,
// 猜值就是在编造「假如当时记录了」的世界,可观测锥红线。

export interface WfPosition {
  id: number;
  /** 聚类键(市场)。 */
  conditionId: string;
  /** 随机化的对边耦合用(二元市场同 condition 的两个 outcome 完全互补)。 */
  outcome: string;
  formationTs: number;
  entryTs: number;
  /** 记账基准价 = 隐含概率 q(BUY)。宇宙已保证 ∈ (0,1)。 */
  entryPrice: number;
  formationPrice: number | null;
  shares: number;
  /** 宇宙已剔除 null(fee 不可定价的仓);0 = 确知免费。 */
  feeUsd: number;
  realizedPnl: number;
  /** event_category 口径(categoriesFor);null = 未知。 */
  category: string | null;
  /** strategy_signals 关联(2026-08-15 起);null = 关联缺失。 */
  walletCount: number | null;
  totalNetUsd: number | null;
  /** market_tilt_history atOrBefore(formation_ts, ≤1h);null = 无可用快照。 */
  tiltPct: number | null;
  /** position_exit_sims 九规则行;null = 未回填/墓碑。 */
  exitSims: Record<string, { exited: number; pnl: number }> | null;
}

/** true=进子集,false=被阈值筛出,null=缺该维事实(剔除并计数)。 */
export function entryMatches(
  spec: EntrySpec,
  p: WfPosition,
): boolean | null {
  switch (spec.kind) {
    case "base":
      return true;
    case "minFillUsd":
    case "minNetUsd":
      return p.totalNetUsd == null ? null : p.totalNetUsd >= spec.min;
    case "maxPrice":
      // 引擎护栏原样(lib/follow.ts:entry > maxPrice 才拦):恰好等于上限的进。
      return p.entryPrice <= spec.max;
    case "maxDevCents":
      return p.formationPrice == null
        ? null
        : Math.abs(p.entryPrice - p.formationPrice) * 100 <= spec.max;
    case "minWallets":
      return p.walletCount == null ? null : p.walletCount >= spec.min;
    case "minAvgPerWalletUsd":
      return p.walletCount == null || p.totalNetUsd == null || p.walletCount <= 0
        ? null
        : p.totalNetUsd / p.walletCount >= spec.min;
    case "maxStalenessSec":
      return p.entryTs - p.formationTs <= spec.max;
    case "minTiltPct":
      return p.tiltPct == null ? null : p.tiltPct >= spec.min;
  }
}

/** 赛道三态:未知分类(null)不冒充「非体育」,受限子集里它是缺事实。 */
export function categoryMatches(
  cat: WfCategory,
  p: WfPosition,
): boolean | null {
  if (cat === "all") return true;
  if (p.category == null) return null;
  return cat === "sports"
    ? p.category === "Sports"
    : p.category !== "Sports";
}

export interface WfSubset {
  included: WfPosition[];
  /** 因缺事实被剔除的仓数(阈值筛出的不算 —— 那是过滤器的本职)。 */
  droppedMissing: number;
}

/** 一个格的子集:入场谓词 ∧ 赛道 ∧(退出≠hold 时 sims 在场)。 */
export function subsetOf(positions: WfPosition[], cell: WfCell): WfSubset {
  const included: WfPosition[] = [];
  let droppedMissing = 0;
  for (const p of positions) {
    const e = entryMatches(cell.entry.spec, p);
    const c = categoryMatches(cell.category, p);
    if (e === null || c === null) {
      droppedMissing++;
      continue;
    }
    if (!e || !c) continue;
    if (cell.exitRule !== "hold" && p.exitSims == null) {
      droppedMissing++;
      continue;
    }
    included.push(p);
  }
  return { included, droppedMissing };
}
