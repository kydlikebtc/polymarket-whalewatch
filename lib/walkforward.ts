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

// ---------------------------------------------------------------------------
// 主指标(实现计划 §0.1):逐仓贡献,单位=概率点。
// contrib = (rulePnl − fee) / shares。二元结算的 hold 恰好等于 won − q − 每股费
// (entry_price 就是隐含概率 q,赔率调整天然内建,与 gradeRows 的 excess 同族);
// 提前退出自然推广为 exit − entry − 每股费。记账基准 = entry_price(realized_pnl
// 与九规则 sims 共同的基准),绝不混入 exec_price —— 换基准等于让本报告与全站
// 已发布战绩打架。

/**
 * 一笔仓在某退出规则下的贡献;规则数据缺席(sims 未回填/缺行)返回 null,
 * 调用方剔除。fee 是入场侧协议费 —— 提前退出的退出侧盘口与费**没有**建模,
 * 报告固定段落带 exitCounterfactual 的红线原话(纸面对纸面/蜡烛盲区)。
 */
export function contribOf(p: WfPosition, exitRule: string): number | null {
  if (p.shares <= 0) return null;
  if (exitRule === "hold") return (p.realizedPnl - p.feeUsd) / p.shares;
  const sim = p.exitSims?.[exitRule];
  if (!sim) return null;
  return (sim.pnl - p.feeUsd) / p.shares;
}

// ---------------------------------------------------------------------------
// 聚类稳健统计(CRVE)。口径逐字移植 scripts/edge-audit.ts 的 stat():点估计
// 照旧用全部行(那是一句真话),只让方差反映簇内相关 —— 同簇残差先求和再平方,
// 簇内完全同向时方差不被行数稀释;完全对冲簇(对边各自入账)方差归零。绝不做
// 「把每簇折成一个观测」(那需要给整簇挑一个方向,点估计会被随机挑边带跑)。

export interface WfClusterStat {
  n: number;
  /** 有效样本量 = 去重簇(市场)数。 */
  nc: number;
  /** contrib 均值(概率点,0-1 量纲)。 */
  point: number;
  /** 聚类稳健标准误 —— 判定只看它。 */
  seC: number;
  /** 朴素标准误,仅作「被低估多少」的对照。 */
  seNaive: number;
}

export function clusterStat(
  rows: { contrib: number; cluster: string }[],
): WfClusterStat | null {
  const n = rows.length;
  if (n === 0) return null;
  const point = rows.reduce((s, r) => s + r.contrib, 0) / n;
  const clusterResid = new Map<string, number>();
  let ssNaive = 0;
  for (const r of rows) {
    const u = r.contrib - point;
    ssNaive += u * u;
    clusterResid.set(r.cluster, (clusterResid.get(r.cluster) ?? 0) + u);
  }
  const G = clusterResid.size;
  let ss = 0;
  for (const v of clusterResid.values()) ss += v * v;
  // G/(G−1) 小样本校正:簇数少时残差被过度收缩。单簇无从估方差 → Infinity。
  const varC = G > 1 ? (ss / (n * n)) * (G / (G - 1)) : Infinity;
  return {
    n,
    nc: G,
    point,
    seC: Math.sqrt(varC),
    seNaive: Math.sqrt(ssNaive / n / Math.max(n, 1)),
  };
}

/**
 * 标准正态分位数(Abramowitz & Stegun 26.2.23 有理近似,|ε| < 4.5e-4)。
 * 镜像自 scripts/edge-audit.ts —— lib 不该反向依赖脚本,8 行重复换单向依赖;
 * 两边的关键分位点由测试互相钉死。
 */
export function normalQuantile(p: number): number {
  const tail = p < 0.5 ? p : 1 - p;
  const t = Math.sqrt(-2 * Math.log(tail));
  const x = t - (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481));
  return p < 0.5 ? -x : x;
}

// ---------------------------------------------------------------------------
// 方向随机化(Gómez-Cram 方法,设计 §4.3 第三道闸):把每仓方向按市场隐含
// 概率重掷,变体真实超额在 null 分布中的分位即 p。**按市场抽签,不逐仓**:
// 同市场的仓共享同一次结算,逐仓独立重掷会把 null 分布做窄、p 虚小 ——
// 恰好重犯 clusteredInterval 修过的那个错。耦合方式:每市场一个均匀数 u,
// 与簇参考 outcome 同边的仓 won = u < q_i(共单调,各保边际 q_i),对边的仓
// won = u ≥ 1 − q_j(反相关 —— 二元市场对边完全互补)。

/** mulberry32:32 位种子 PRNG。确定性是报告可复现的根,lib 层禁 Math.random。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WfRandRow {
  conditionId: string;
  outcome: string;
  /** 隐含概率 = entry_price(BUY)。 */
  q: number;
  feePerShare: number;
}

/**
 * 单边 p 值:null 下「均值贡献 ≥ 实测」的频率,(1+k)/(1+N) 防报 0。
 * null 重掷的是**二元结算**(won ∈ {0,1});少数分数结算仓的实测贡献仍可比
 * (同一量纲),报告披露这层近似。
 */
export function randomizationP(
  rows: WfRandRow[],
  observed: number,
  draws: number,
  seed: number,
): number {
  if (rows.length === 0) return 1;
  const rng = mulberry32(seed);
  // 市场 → 成员行;参考边 = 该市场第一行的 outcome。
  const byMarket = new Map<string, WfRandRow[]>();
  for (const r of rows) {
    const g = byMarket.get(r.conditionId);
    if (g) g.push(r);
    else byMarket.set(r.conditionId, [r]);
  }
  let hits = 0;
  for (let i = 0; i < draws; i++) {
    let sum = 0;
    for (const members of byMarket.values()) {
      const ref = members[0].outcome;
      const u = rng();
      for (const r of members) {
        const won = r.outcome === ref ? u < r.q : u >= 1 - r.q;
        sum += (won ? 1 : 0) - r.q - r.feePerShare;
      }
    }
    if (sum / rows.length >= observed) hits++;
  }
  return (1 + hits) / (1 + draws);
}

// ---------------------------------------------------------------------------
// 全档评估管线(实现计划 §0.5/0.6)。两段式:先逐档收集「validate 被看过的格」
// 定死全局 G(Bonferroni 分母),再统一判闸 —— G 没定死之前判任何一格都是在
// 用未来信息。选择与评价严格分离:train 打平/落选的格连 validate 数字都不
// 发布(发布即烧 OOS)。

export interface WfOptions {
  /** 闸门起点(报告透传;lib 不持有日期常量)。 */
  gateStart: number;
  /** listValidateFolds 的输出。 */
  folds: number[];
  randDraws: number;
  seed: number;
  /** 折内最小 settled 数(train 与 validate 双侧同闸)。 */
  minFoldSettled: number;
  /** 折内最小去重市场数。 */
  minFoldMarkets: number;
  /** 变体最少可评折数,不足进观察名单。 */
  minValidFolds: number;
  alpha: number;
}

export interface WfTierInput {
  strategyId: number;
  name: string;
  code: string | null;
  params: StrategyParams;
  /** 宇宙过滤(§0.2)后的仓;原始 settled 总数另报以对表 /api/follow。 */
  positions: WfPosition[];
  settledRaw: number;
  universeDropped: { noFormation: number; noFee: number; badShares: number };
}

export interface WfFoldDetail {
  fold: number;
  trainN: number;
  trainMarkets: number;
  trainPoint: number | null;
  validateN: number;
  validateMarkets: number;
  validatePoint: number | null;
  evaluable: boolean;
  reason?: string;
}

export interface WfPooled {
  n: number;
  markets: number;
  point: number;
  seC: number;
}

export interface WfVariantReport {
  key: string;
  label: string;
  dim: string;
  category: WfCategory;
  exitRule: string;
  folds: WfFoldDetail[];
  pooled: WfPooled | null;
  /** point − zBonf·seC(闸 A 的判定量)。 */
  loBonf: number | null;
  randP: number | null;
  passClustered: boolean;
  passRand: boolean;
  survives: boolean;
}

export interface WfTierReport {
  strategyId: number;
  name: string;
  code: string | null;
  source: string;
  settledRaw: number;
  universeN: number;
  universeDropped: { noFormation: number; noFee: number; badShares: number };
  /** 基线可评折 < minValidFolds → 整档薄档:跳网格,只报现状。 */
  thin: boolean;
  /** 全样本 hold 现状(聚类口径),薄档的唯一读数,非薄档的对照。 */
  currentStat: WfClusterStat | null;
  baseline: WfVariantReport | null;
  candidates: WfVariantReport[];
  survivors: string[];
  watchlist: { key: string; label: string; validFolds: number }[];
  /** 可评折够但 train 未入选的格数(它们的 validate 从未被看过)。 */
  trainRejected: number;
  /** 可评折不足的格数(观察名单是其中 train 有戏的子集)。 */
  insufficient: number;
}

export interface WalkforwardReport {
  gateStart: number;
  folds: number[];
  /** 非薄档的网格格数合计(构造出来的);薄档整档跳过不计。 */
  gridTotal: number;
  /** Bonferroni 分母 G = 实际发布过 validate 成绩的格数(候选+非薄档基线)。 */
  scoredCells: number;
  zBonf: number;
  alpha: number;
  randDraws: number;
  seed: number;
  tiers: WfTierReport[];
  declarations: string[];
}

/** 报告固定诚实段落(设计 §7 + 实现计划 §0 的近似声明),脚本与管理页共用。 */
export const WF_DECLARATIONS: readonly string[] = [
  "幸存者宇宙:分析宇宙 = 在当前阈值下触发过的信号;对「从未触发过的世界」本报告一无所知。",
  "收紧外推禁令:一切变体只在收紧/平移方向成立,禁止外推到放松方向 —— 放松的唯一诚实做法是开更松的挑战者档从今天向前跑。",
  "score 维度不可回放:仓位未记录触发钱包与彼时评分,以 minNetUsd 平移代之;要网格化它需先向前落 wallet+score(v2)。",
  "minPerWalletUsd 为均值口径(total/count):是真逐钱包收紧子集的超集;胜出建挑战者档时配真 minPerWalletUsd,向前对照给出无偏读数。",
  "freshSec 以 entry_ts−formation_ts 近似检测时新鲜度;tiltPct 取 formation 前 ≤1h 的最近快照 —— 两者都是落库残影,非逐 tick 重放。",
  "退出规则为纸面对纸面反事实:~10min 蜡烛盲区使 SL 触发被系统性低估,读数是下界;推及实盘须另计退出侧盘口与费。退出格的方向随机化在其子集的 hold 基准上判(退出规则不产生方向技能)。",
  "方向随机化按市场抽签(同市场同抽,对边反相关),null 重掷的是二元结算;分数结算仓的实测贡献同量纲可比。",
  "fee_usd 为 null(不可定价)的仓整行出宇宙,绝不当 0;逐档披露剔除量。",
  "本报告不修改任何存量档参数,不输出买卖建议 —— 产出只有「参数变体在历史子集上的费用后超额」与手工挑战者档路径。",
];

interface CellEval {
  cell: WfCell;
  folds: WfFoldDetail[];
  validFolds: number[];
  /** 在每个可评折上 train 均值是否严格大于基线同折 train 均值。 */
  trainSelected: boolean;
  pooledRows: { p: WfPosition; contrib: number }[] | null;
}

function foldGate(
  n: number,
  markets: number,
  opts: WfOptions,
): string | null {
  if (n < opts.minFoldSettled) return `样本不足(${n} 仓)`;
  if (markets < opts.minFoldMarkets) return `市场不足(${markets} 个)`;
  return null;
}

function statOf(rows: { p: WfPosition; contrib: number }[]) {
  return clusterStat(
    rows.map((r) => ({ contrib: r.contrib, cluster: r.p.conditionId })),
  );
}

/** 一个格在全部折上的读数与入选判定(基线传 null 的 baselineTrain)。 */
function evalCell(
  cell: WfCell,
  positions: WfPosition[],
  opts: WfOptions,
  baselineTrainPoint: Map<number, number | null> | null,
): CellEval {
  const folds: WfFoldDetail[] = [];
  const validFolds: number[] = [];
  let trainSelected = true;
  const pooledRows: { p: WfPosition; contrib: number }[] = [];
  const rowsOf = (list: WfPosition[]) => {
    const out: { p: WfPosition; contrib: number }[] = [];
    for (const p of subsetOf(list, cell).included) {
      const c = contribOf(p, cell.exitRule);
      if (c != null) out.push({ p, contrib: c });
    }
    return out;
  };
  for (const fold of opts.folds) {
    const train = rowsOf(positions.filter((p) => p.formationTs < fold));
    const val = rowsOf(
      positions.filter((p) => foldOf(p.formationTs, [fold]) === fold),
    );
    const trainStat = statOf(train);
    const valStat = statOf(val);
    const trainWhy = foldGate(train.length, trainStat?.nc ?? 0, opts);
    const valWhy = foldGate(val.length, valStat?.nc ?? 0, opts);
    const evaluable = trainWhy == null && valWhy == null;
    folds.push({
      fold,
      trainN: train.length,
      trainMarkets: trainStat?.nc ?? 0,
      trainPoint: trainStat?.point ?? null,
      validateN: val.length,
      validateMarkets: valStat?.nc ?? 0,
      validatePoint: valStat?.point ?? null,
      evaluable,
      reason: evaluable
        ? undefined
        : trainWhy
          ? `train ${trainWhy}`
          : `validate ${valWhy}`,
    });
    if (!evaluable) continue;
    validFolds.push(fold);
    pooledRows.push(...val);
    if (baselineTrainPoint) {
      const base = baselineTrainPoint.get(fold);
      // 基线同折 train 缺失时不入选(候选的 train ⊆ 基线的 train,理论上
      // 不会发生 —— 防御,不猜)。
      if (base == null || !((trainStat?.point ?? -Infinity) > base)) {
        trainSelected = false;
      }
    }
  }
  return {
    cell,
    folds,
    validFolds,
    trainSelected,
    pooledRows: pooledRows.length > 0 ? pooledRows : null,
  };
}

function toVariantReport(ev: CellEval): WfVariantReport {
  const stat = ev.pooledRows ? statOf(ev.pooledRows) : null;
  return {
    key: ev.cell.key,
    label: `${ev.cell.entry.label}${
      ev.cell.category === "all"
        ? ""
        : ev.cell.category === "sports"
          ? " · 仅体育"
          : " · 仅非体育"
    }${ev.cell.exitRule === "hold" ? "" : ` · 退出 ${ev.cell.exitRule}`}`,
    dim: ev.cell.entry.dim,
    category: ev.cell.category,
    exitRule: ev.cell.exitRule,
    folds: ev.folds,
    pooled: stat
      ? { n: stat.n, markets: stat.nc, point: stat.point, seC: stat.seC }
      : null,
    loBonf: null,
    randP: null,
    passClustered: false,
    passRand: false,
    survives: false,
  };
}

export function runWalkforward(
  tiers: WfTierInput[],
  opts: WfOptions,
): WalkforwardReport {
  interface TierWork {
    input: WfTierInput;
    thin: boolean;
    baseline: CellEval | null;
    candidates: CellEval[];
    watchlist: { key: string; label: string; validFolds: number }[];
    trainRejected: number;
    insufficient: number;
    gridCells: number;
  }
  const works: TierWork[] = [];
  for (const tier of tiers) {
    const cells = buildGrid(tier.params);
    const baseCell = cells.find(
      (c) =>
        c.entry.dim === "base" && c.category === "all" && c.exitRule === "hold",
    )!;
    const baseEval = evalCell(baseCell, tier.positions, opts, null);
    const thin = baseEval.validFolds.length < opts.minValidFolds;
    if (thin) {
      works.push({
        input: tier,
        thin,
        baseline: baseEval,
        candidates: [],
        watchlist: [],
        trainRejected: 0,
        insufficient: 0,
        gridCells: 0,
      });
      continue;
    }
    const baseTrainByFold = new Map<number, number | null>(
      baseEval.folds.map((f) => [f.fold, f.trainPoint]),
    );
    const candidates: CellEval[] = [];
    const watchlist: TierWork["watchlist"] = [];
    let trainRejected = 0;
    let insufficient = 0;
    for (const cell of cells) {
      if (cell === baseCell) continue;
      const ev = evalCell(cell, tier.positions, opts, baseTrainByFold);
      if (ev.validFolds.length >= opts.minValidFolds) {
        if (ev.trainSelected) candidates.push(ev);
        else trainRejected++;
      } else {
        insufficient++;
        if (ev.validFolds.length >= 1 && ev.trainSelected) {
          watchlist.push({
            key: cell.key,
            label: toVariantReport(ev).label,
            validFolds: ev.validFolds.length,
          });
        }
      }
    }
    works.push({
      input: tier,
      thin,
      baseline: baseEval,
      candidates,
      watchlist,
      trainRejected,
      insufficient,
      gridCells: cells.length,
    });
  }

  // 全局 G 定死后才判闸。
  const scoredCells =
    works.reduce((s, w) => s + w.candidates.length, 0) +
    works.filter((w) => !w.thin).length;
  const alphaAdj = opts.alpha / Math.max(scoredCells, 1);
  const zBonf = normalQuantile(1 - alphaAdj / 2);

  const tiersOut: WfTierReport[] = works.map((w) => {
    const holdContribs = w.input.positions
      .map((p) => ({ p, contrib: contribOf(p, "hold") }))
      .filter((r): r is { p: WfPosition; contrib: number } => r.contrib != null);
    const currentStat = statOf(holdContribs);
    const baselineReport = w.baseline ? toVariantReport(w.baseline) : null;
    const survivors: string[] = [];
    const candidates = w.candidates.map((ev) => {
      const rep = toVariantReport(ev);
      const rows = ev.pooledRows!;
      rep.loBonf =
        rep.pooled == null ? null : rep.pooled.point - zBonf * rep.pooled.seC;
      rep.passClustered = rep.loBonf != null && rep.loBonf > 0;
      // 闸 B 永远在该格子集的 hold 基准上跑:观测量=同一批仓的 hold 贡献均值,
      // 同入场不同退出的格子集相同 → p 逐字相等(退出不产生方向技能)。
      const holdObserved =
        rows.reduce((s, r) => s + contribOf(r.p, "hold")!, 0) / rows.length;
      rep.randP = randomizationP(
        rows.map((r) => ({
          conditionId: r.p.conditionId,
          outcome: r.p.outcome,
          q: r.p.entryPrice,
          feePerShare: r.p.feeUsd / r.p.shares,
        })),
        holdObserved,
        opts.randDraws,
        opts.seed,
      );
      rep.passRand = rep.randP <= alphaAdj;
      rep.survives = rep.passClustered && rep.passRand;
      if (rep.survives) survivors.push(rep.key);
      return rep;
    });
    return {
      strategyId: w.input.strategyId,
      name: w.input.name,
      code: w.input.code,
      source: w.input.params.source,
      settledRaw: w.input.settledRaw,
      universeN: w.input.positions.length,
      universeDropped: w.input.universeDropped,
      thin: w.thin,
      currentStat,
      baseline: baselineReport,
      candidates,
      survivors,
      watchlist: w.watchlist,
      trainRejected: w.trainRejected,
      insufficient: w.insufficient,
    };
  });

  return {
    gateStart: opts.gateStart,
    folds: opts.folds,
    gridTotal: works.reduce((s, w) => s + w.gridCells, 0),
    scoredCells,
    zBonf,
    alpha: opts.alpha,
    randDraws: opts.randDraws,
    seed: opts.seed,
    tiers: tiersOut,
    declarations: [...WF_DECLARATIONS],
  };
}
