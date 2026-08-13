import {
  BUCKET_LOW_SAMPLE_N,
  DURATION_BOUNDS,
  ODDS_BOUNDS,
  type AnalysisPosition,
} from "./followAnalysis";

// 赛道 × 策略优势矩阵 + 分段缺陷诊断(2026-08-13,设计见
// docs/plans/2026-08-13-edge-matrix-diagnosis-design.md)。两者共用同一套
// 「分段统计」底座:把已结算仓按维度切段,每段 n/胜负/胜率/隐含/edge/落袋。
// client-safe 纯函数(followCardView/followAnalysis 同一先例);lib 层只出
// EN 原文与数字,「体育·NBA」中文合成留给 UI(catLabelFine)。
//
// 口径与 followAnalysis 逐字一致:已结算纸面、push 进 n 不进胜率分母、
// edge = 实际胜率 − 段内均入场价;赔率带/时长桶定义 import 自
// followAnalysis(唯一事实源,诊断段必须与面板图表的桶完全对齐)。

/** 一个分段的完整读数(矩阵格子与诊断段共用)。 */
export interface SegmentStat {
  n: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number | null;
  avgEntry: number | null;
  edge: number | null;
  realized: number;
}

/** 细赛道键:一级 + 二级组合。无二级的仓自成「该一级·未细分」段。 */
export interface TrackKey {
  category: string | null;
  subcategory: string | null;
}

export interface EdgeMatrix {
  /**
   * 列:数据里实际出现的细赛道,按全体样本数降序(选题池视角:样本多的
   * 排前),同 n 按一级、二级字典序稳定。key = `${category}|${subcategory}`
   * (null 记作 "")。
   */
  tracks: (TrackKey & { key: string; totalN: number })[];
  /** 行:与入参 strategies 同序;cells 与 tracks 一一对齐,该赛道零仓 → null。 */
  rows: { id: number; name: string; cells: (SegmentStat | null)[] }[];
}

// ---- 分段累计器(与 followAnalysis 的 CatAcc 同构,独立声明保持解耦) ----
interface Acc {
  n: number;
  wins: number;
  losses: number;
  pushes: number;
  entrySum: number;
  realized: number;
}

const newAcc = (): Acc => ({
  n: 0,
  wins: 0,
  losses: 0,
  pushes: 0,
  entrySum: 0,
  realized: 0,
});

function feed(acc: Acc, p: AnalysisPosition): void {
  acc.n++;
  acc.entrySum += p.entry_price;
  const v = p.realized_pnl ?? 0;
  acc.realized += v;
  if (v > 0) acc.wins++;
  else if (v < 0) acc.losses++;
  else acc.pushes++;
}

function finalize(acc: Acc): SegmentStat {
  const denom = acc.wins + acc.losses;
  const winRate = denom > 0 ? acc.wins / denom : null;
  const avgEntry = acc.n > 0 ? acc.entrySum / acc.n : null;
  return {
    n: acc.n,
    wins: acc.wins,
    losses: acc.losses,
    pushes: acc.pushes,
    winRate,
    avgEntry,
    edge: winRate != null && avgEntry != null ? winRate - avgEntry : null,
    realized: acc.realized,
  };
}

const trackKeyOf = (p: AnalysisPosition): string =>
  `${p.category ?? ""}|${p.subcategory ?? ""}`;

/**
 * 赛道 × 策略透视。strategies 行序保留(调用方可把「全部(聚合)」当第一个
 * 伪策略传入 —— 是否聚合、聚合的重复下注口径声明都是调用方的事,这里只做
 * 纯 pivot)。open 仓不进任何格。
 */
export function buildEdgeMatrix(
  strategies: { id: number; name: string; positions: AnalysisPosition[] }[],
): EdgeMatrix {
  // 全体列集合与 totalN(列序依据),同时逐策略累计格子。
  const trackMeta = new Map<string, TrackKey & { totalN: number }>();
  const perStrategy = strategies.map((s) => {
    const cells = new Map<string, Acc>();
    for (const p of s.positions) {
      if (p.status !== "settled") continue;
      const key = trackKeyOf(p);
      const meta = trackMeta.get(key) ?? {
        category: p.category ?? null,
        subcategory: p.subcategory ?? null,
        totalN: 0,
      };
      meta.totalN++;
      trackMeta.set(key, meta);
      const acc = cells.get(key) ?? newAcc();
      feed(acc, p);
      cells.set(key, acc);
    }
    return { id: s.id, name: s.name, cells };
  });

  const tracks = [...trackMeta.entries()]
    .map(([key, m]) => ({ key, ...m }))
    .sort(
      (a, b) =>
        b.totalN - a.totalN ||
        (a.category ?? "").localeCompare(b.category ?? "") ||
        (a.subcategory ?? "").localeCompare(b.subcategory ?? ""),
    );

  return {
    tracks,
    rows: perStrategy.map((s) => ({
      id: s.id,
      name: s.name,
      cells: tracks.map((t) => {
        const acc = s.cells.get(t.key);
        return acc ? finalize(acc) : null;
      }),
    })),
  };
}

/* ------------------------------------------------------------ diagnosis */

export type DiagnosisDimension = "track" | "duration" | "odds";

/** 诊断出的一个特征段(缺陷或最强)。 */
export interface DiagnosedSegment extends SegmentStat {
  dimension: DiagnosisDimension;
  /** duration/odds 的桶 label;track 段为 "",由 UI 用下面两个字段合成。 */
  label: string;
  category: string | null;
  subcategory: string | null;
  /**
   * 反事实:剔除该段后的总净盈亏 = totalRealized − 段落袋。固定 $/仓 +
   * 仓位独立 ⇒ 精确回放值非估计(与账户推演同一论证)。⚠️ 各段互有重叠
   * (一仓可同时属「足球」与「>7 天」),不同段的剔除数字不可相加。
   */
  totalWithout: number;
}

export interface SegmentDiagnosis {
  totalRealized: number;
  /**
   * 亏损特征段:n ≥ BUCKET_LOW_SAMPLE_N 且落袋 < 0,按落袋升序(最亏在
   * 前),cap 5。刻意不要求 edge<0 —— 亏钱是要抓的事实;edge≥0 的段由
   * UI 标注「或为波动」防过度反应(统计诚实,见设计 §3)。
   */
  weaknesses: DiagnosedSegment[];
  /** 最强特征:n ≥ 阈值且落袋 > 0 且 edge > 0,取落袋最大;无 → null。 */
  strongest: DiagnosedSegment | null;
}

const WEAKNESS_CAP = 5;

// 并列时的维度偏好:赛道段最可执行(直接对应未来的赛道过滤参数),
// 时长次之,赔率带最后。只影响并列排序,不影响入选。
const DIMENSION_ORDER: Record<DiagnosisDimension, number> = {
  track: 0,
  duration: 1,
  odds: 2,
};

/**
 * 三维度分段扫描:细赛道 / 持有时长桶(快慢市场)/ 赔率带。输入一批仓位
 * (单策略或跨策略聚合皆可 —— 聚合口径声明是调用方 UI 的事)。
 */
export function diagnoseSegments(
  positions: AnalysisPosition[],
): SegmentDiagnosis {
  const settled = positions.filter((p) => p.status === "settled");
  const totalRealized = settled.reduce((s, p) => s + (p.realized_pnl ?? 0), 0);

  // 段签名 → {维度元信息, acc}。三个维度一遍扫完。
  const segs = new Map<
    string,
    {
      dimension: DiagnosisDimension;
      label: string;
      category: string | null;
      subcategory: string | null;
      acc: Acc;
    }
  >();
  const feedSeg = (
    sig: string,
    dimension: DiagnosisDimension,
    label: string,
    category: string | null,
    subcategory: string | null,
    p: AnalysisPosition,
  ) => {
    const seg = segs.get(sig) ?? {
      dimension,
      label,
      category,
      subcategory,
      acc: newAcc(),
    };
    feed(seg.acc, p);
    segs.set(sig, seg);
  };
  for (const p of settled) {
    feedSeg(
      `t:${trackKeyOf(p)}`,
      "track",
      "",
      p.category ?? null,
      p.subcategory ?? null,
      p,
    );
    // 时长桶:与 analyzeBets 完全同式(exit 缺失按 entry 兜底、下闭上开)。
    const hold = Math.max(0, (p.exit_ts ?? p.entry_ts) - p.entry_ts);
    const durIdx = DURATION_BOUNDS.findIndex((b) => hold < b.maxSec);
    const dur =
      DURATION_BOUNDS[durIdx === -1 ? DURATION_BOUNDS.length - 1 : durIdx];
    feedSeg(`d:${dur.label}`, "duration", dur.label, null, null, p);
    // 赔率带:与 analyzeBets 完全同式(20¢ 等宽,1.0 并入末桶,脏数据夹回)。
    const oddsIdx = Math.min(
      ODDS_BOUNDS.length - 1,
      Math.max(0, Math.floor(p.entry_price / 0.2)),
    );
    const odds = ODDS_BOUNDS[oddsIdx];
    feedSeg(`o:${odds.label}`, "odds", odds.label, null, null, p);
  }

  const all: DiagnosedSegment[] = [...segs.values()].map((s) => ({
    dimension: s.dimension,
    label: s.label,
    category: s.category,
    subcategory: s.subcategory,
    ...finalize(s.acc),
    totalWithout: totalRealized - s.acc.realized,
  }));

  const weaknesses = all
    .filter((s) => s.n >= BUCKET_LOW_SAMPLE_N && s.realized < 0)
    .sort(
      (a, b) =>
        a.realized - b.realized ||
        DIMENSION_ORDER[a.dimension] - DIMENSION_ORDER[b.dimension] ||
        a.label.localeCompare(b.label) ||
        (a.category ?? "").localeCompare(b.category ?? ""),
    )
    .slice(0, WEAKNESS_CAP);

  const strongest =
    all
      .filter(
        (s) =>
          s.n >= BUCKET_LOW_SAMPLE_N &&
          s.realized > 0 &&
          s.edge != null &&
          s.edge > 0,
      )
      .sort(
        (a, b) =>
          b.realized - a.realized ||
          DIMENSION_ORDER[a.dimension] - DIMENSION_ORDER[b.dimension],
      )[0] ?? null;

  return { totalRealized, weaknesses, strongest };
}
