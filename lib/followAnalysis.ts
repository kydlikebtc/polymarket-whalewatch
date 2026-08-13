import { wilsonInterval } from "./outcomeStats";

// 策略中心「深度分析」面板的全部聚合计算。client-safe 纯函数(同
// lib/followCardView.ts 先例:无 node import、无 db,app/follow 直接引入),
// 设计见 docs/plans/2026-08-13-strategy-deep-analysis-design.md。
//
// 口径红线(与整页一致,面板头部也要向读者声明):
//  - 已结算口径:一切指标只看 status==='settled' 的落袋结果,不做浮盈;
//    open 仓只进 openCount 供头部说明。
//  - 纸面口径:不混入追价/协议费(成本分解 tab 的职责)。
//  - push 纪律:realized_pnl===0 视为平局 —— 不进任何胜率分母(与
//    computeStrategyMetrics 一致),但计入期望(它是真实发生的下注结果,
//    从期望里剔除会系统性美化均值)。
//  - 小样本诚实:样本不足的读数一律 null(由 UI 显示「—」),绝不硬算。

/**
 * 面板的最小输入契约:只声明本文件真正读取的字段。app/follow/page.tsx 的
 * 本地 FollowPositionRow(含更多归因列)结构性满足它,不需要 import 服务端
 * 类型;category 由 /api/follow 逐行附带(buildFollowView),旧响应缺失时
 * 按未分类处理。
 */
export interface AnalysisPosition {
  status: "open" | "settled";
  entry_price: number;
  size_usd: number;
  realized_pnl: number | null;
  entry_ts: number;
  exit_ts: number | null;
  category?: string | null;
  /** 二级分类(体育联盟/加密资产等,lib/gamma.ts 白名单派生;缺失=无)。 */
  subcategory?: string | null;
}

export interface QualityStats {
  settledCount: number;
  wins: number;
  losses: number;
  pushes: number;
  /** wins/(wins+losses);分母 0 → null。 */
  winRate: number | null;
  winRateCI: { lo: number; hi: number };
  /** 全部 settled(含 push)的单仓盈亏均值;无 settled → null。 */
  expectancyUsd: number | null;
  /**
   * 期望显著性 t 值 = mean/(sd/√n),sd 取样本标准差(n−1)。回答「均值离 0
   * 有几个标准误」—— Wilson 区间只覆盖胜率的不确定性,赔率不对称时盈亏均值
   * 的不确定性是另一回事。n<2 或 sd=0 → null。
   */
  expectancyT: number | null;
  /** 总盈/总亏;无亏损仓时 null(不给 Infinity,UI 明示「无亏损仓」)。 */
  profitFactor: number | null;
  grossProfit: number;
  /** 亏损合计的绝对值(正数)。 */
  grossLoss: number;
  avgWinUsd: number | null;
  /** 均亏损仓的绝对值(正数);无亏损仓 → null。 */
  avgLossUsd: number | null;
  /** avgWinUsd / avgLossUsd;任一缺失 → null。 */
  payoffRatio: number | null;
  bestPnl: number | null;
  worstPnl: number | null;
}

export interface OddsBucket {
  label: string;
  /** 下闭。 */
  lo: number;
  /** 上开(末桶把 1.0 一并收入)。 */
  hi: number;
  n: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number | null;
  /** 桶内均入场价 = 市场定价的隐含胜率(每仓等权,与固定 $/仓一致)。 */
  avgEntry: number | null;
  /** 实际胜率 − 隐含胜率;任一为 null → null。 */
  edge: number | null;
  realized: number;
}

export interface WeekPnl {
  /** UTC 周一 00:00 的秒时间戳。 */
  weekStartTs: number;
  realized: number;
  settled: number;
}

export interface StreakStats {
  maxWinStreak: number;
  maxLossStreak: number;
  /** 按结算时间的当前连续段:正=连赢中,负=连输中,0=无可延续段。 */
  current: number;
}

export interface ConcentrationStats {
  /** Top3 盈利仓合计 ÷ 总盈利;无盈利仓 → null。 */
  top3WinsShare: number | null;
  /** 总净额 − Top3 盈利合计(稳健性:几笔大的撑起来的吗);无盈利仓 → null。 */
  netWithoutTop3Wins: number | null;
  /** Top3 亏损仓合计(绝对值)÷ 总亏损;无亏损仓 → null。 */
  top3LossesShare: number | null;
}

export interface DurationBucket {
  label: string;
  /** 上开边界(秒);末桶 Infinity。 */
  maxSec: number;
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  realized: number;
}

/** 某一级赛道下按二级(联盟/资产)细分的子行。 */
export interface CategorySubStat {
  /** 二级标签 EN 原文(展示层译中)。 */
  subcategory: string;
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgEntry: number | null;
  realized: number;
}

/**
 * 一级赛道汇总 + 二级子行。一级行吃该赛道**全部**仓(含无二级的)——
 * 子行是细分视图而非再分配,subs 各 n 之和 ≤ 一级 n(差额 = 无二级的仓)。
 */
export interface CategoryGroup {
  category: string;
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgEntry: number | null;
  realized: number;
  /** 有二级的部分,n 降序、同 n 按落袋降序;全无二级 → []。 */
  subs: CategorySubStat[];
}

export interface HalfSplitStat {
  n: number;
  winRate: number | null;
  realized: number;
}

export interface HalfSplit {
  earlier: HalfSplitStat;
  later: HalfSplitStat;
}

export interface DeepAnalysis {
  quality: QualityStats;
  oddsBuckets: OddsBucket[];
  weekly: WeekPnl[];
  /** settled<6 时 null —— 三仓对三仓以下的对比没有解释力。 */
  halves: HalfSplit | null;
  streaks: StreakStats;
  concentration: ConcentrationStats;
  durationBuckets: DurationBucket[];
  /** 两级赛道:一级 n 降序,同 n 按落袋降序,再按名称字典序保证稳定。 */
  categories: CategoryGroup[];
  openCount: number;
}

/**
 * 分桶读数的小样本弱化阈值:桶内 settled < 5 时 UI 灰显该行读数。整体面板的
 * 小样本横幅沿用 followCardView.LOW_SAMPLE_THRESHOLD(10)—— 桶是整体的
 * 再切分,阈值取整体的一半量级;5 也是 Wilson 区间在 z=1.96 下宽到 ±40¢
 * 量级的分界,再小的桶给出的胜率读数纯属噪声。
 */
export const BUCKET_LOW_SAMPLE_N = 5;

/**
 * 周度补零上限(周数):补零是为了柱状图时间轴等距,跨度超过 ~14 个月说明
 * 数据里混进了异常时间戳(本产品 2026-07 才上线),补出上千根空柱只会撑爆
 * 渲染 —— 超限退化为只列非空周。
 */
export const WEEKLY_FILL_CAP = 60;

// 入场价 5 档:20¢ 等宽。冷门/热门的语义标注(「冷门票」「热门票」)留给 UI,
// lib 层只给中性区间标签。
// 导出供 lib/followInsights.ts(缺陷诊断)复用 —— 桶定义的唯一事实源,
// 诊断里的「赔率带/时长」段必须与面板校准/时长分布的桶逐字一致。
export const ODDS_BOUNDS: { label: string; lo: number; hi: number }[] = [
  { label: "<20¢", lo: 0, hi: 0.2 },
  { label: "20–40¢", lo: 0.2, hi: 0.4 },
  { label: "40–60¢", lo: 0.4, hi: 0.6 },
  { label: "60–80¢", lo: 0.6, hi: 0.8 },
  { label: "≥80¢", lo: 0.8, hi: 1 },
];

// 持有时长 5 档(下闭上开)。边界与告警/共识页无耦合,纯按市场节奏取整:
// in-play 体育盘(小时级)/隔夜盘/周内盘/长线盘。
export const DURATION_BOUNDS: { label: string; maxSec: number }[] = [
  { label: "<6 小时", maxSec: 6 * 3600 },
  { label: "6–24 小时", maxSec: 24 * 3600 },
  { label: "1–3 天", maxSec: 3 * 86400 },
  { label: "3–7 天", maxSec: 7 * 86400 },
  { label: "≥7 天", maxSec: Infinity },
];

const SECONDS_PER_WEEK = 7 * 86400;

/**
 * 秒时间戳 → 所在 UTC 周的周一 00:00 秒时间戳。纯整数运算,不经 Date 对象
 * (无时区依赖,测试可精确断言):1970-01-01 是周四,epoch 天数 +3 后对 7
 * 取模恰好让周一余 0。
 */
export function utcWeekStart(ts: number): number {
  const days = Math.floor(ts / 86400);
  const dow = (((days + 3) % 7) + 7) % 7; // 双取模防负时间戳(防御,生产不会有)
  return (days - dow) * 86400;
}

// 胜率:wins/(wins+losses),push 不进分母;分母 0 → null。
function rate(wins: number, losses: number): number | null {
  const denom = wins + losses;
  return denom > 0 ? wins / denom : null;
}

/**
 * 全维度一次算完。入参不被修改(内部排序均作用于副本);字段口径见各
 * interface 注释。
 */
export function analyzeBets(positions: AnalysisPosition[]): DeepAnalysis {
  const openCount = positions.filter((p) => p.status === "open").length;
  // 结算时间升序(streak/前后半的叙事顺序)。exit_ts 缺失(settled 却无
  // exit 属数据异常)与全页其它消费方同口径按 0 兜底沉底到最早。
  const settled = positions
    .filter((p) => p.status === "settled")
    .sort(
      (a, b) => (a.exit_ts ?? 0) - (b.exit_ts ?? 0) || a.entry_ts - b.entry_ts,
    );
  const pnls = settled.map((p) => p.realized_pnl ?? 0);

  // ---- 质量体检 ----
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const v of pnls) {
    if (v > 0) {
      wins++;
      grossProfit += v;
    } else if (v < 0) {
      losses++;
      grossLoss += -v;
    } else {
      pushes++;
    }
  }
  const n = settled.length;
  const total = pnls.reduce((s, v) => s + v, 0);
  const expectancyUsd = n > 0 ? total / n : null;
  let expectancyT: number | null = null;
  if (n >= 2 && expectancyUsd != null) {
    const variance =
      pnls.reduce((s, v) => s + (v - expectancyUsd) ** 2, 0) / (n - 1);
    const sd = Math.sqrt(variance);
    expectancyT = sd > 0 ? expectancyUsd / (sd / Math.sqrt(n)) : null;
  }
  const avgWinUsd = wins > 0 ? grossProfit / wins : null;
  const avgLossUsd = losses > 0 ? grossLoss / losses : null;
  const quality: QualityStats = {
    settledCount: n,
    wins,
    losses,
    pushes,
    winRate: rate(wins, losses),
    winRateCI: wilsonInterval(wins, wins + losses),
    expectancyUsd,
    expectancyT,
    profitFactor: losses > 0 ? grossProfit / grossLoss : null,
    grossProfit,
    grossLoss,
    avgWinUsd,
    avgLossUsd,
    payoffRatio:
      avgWinUsd != null && avgLossUsd != null && avgLossUsd > 0
        ? avgWinUsd / avgLossUsd
        : null,
    bestPnl: n > 0 ? Math.max(...pnls) : null,
    worstPnl: n > 0 ? Math.min(...pnls) : null,
  };

  // ---- 赔率带校准 ----
  const oddsAcc = ODDS_BOUNDS.map(() => ({
    n: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    entrySum: 0,
    realized: 0,
  }));
  for (const p of settled) {
    // 20¢ 等宽 → idx=floor(p/0.2);1.0 会算出 5,并进末桶(上界含 1)。
    // entry_price 开仓侧已保证 >0,负值/超界只在脏数据下出现,夹回有效桶。
    const idx = Math.min(
      ODDS_BOUNDS.length - 1,
      Math.max(0, Math.floor(p.entry_price / 0.2)),
    );
    const acc = oddsAcc[idx];
    acc.n++;
    acc.entrySum += p.entry_price;
    const v = p.realized_pnl ?? 0;
    acc.realized += v;
    if (v > 0) acc.wins++;
    else if (v < 0) acc.losses++;
    else acc.pushes++;
  }
  const oddsBuckets: OddsBucket[] = ODDS_BOUNDS.map((b, i) => {
    const acc = oddsAcc[i];
    const winRate = rate(acc.wins, acc.losses);
    const avgEntry = acc.n > 0 ? acc.entrySum / acc.n : null;
    return {
      label: b.label,
      lo: b.lo,
      hi: b.hi,
      n: acc.n,
      wins: acc.wins,
      losses: acc.losses,
      pushes: acc.pushes,
      winRate,
      avgEntry,
      edge: winRate != null && avgEntry != null ? winRate - avgEntry : null,
      realized: acc.realized,
    };
  });

  // ---- 周度盈亏 ----
  const byWeek = new Map<number, { realized: number; settled: number }>();
  for (const p of settled) {
    const wk = utcWeekStart(p.exit_ts ?? 0);
    const acc = byWeek.get(wk) ?? { realized: 0, settled: 0 };
    acc.realized += p.realized_pnl ?? 0;
    acc.settled++;
    byWeek.set(wk, acc);
  }
  const weekKeys = [...byWeek.keys()].sort((a, b) => a - b);
  let weekly: WeekPnl[] = [];
  if (weekKeys.length > 0) {
    const first = weekKeys[0];
    const last = weekKeys[weekKeys.length - 1];
    const span = (last - first) / SECONDS_PER_WEEK + 1;
    if (span <= WEEKLY_FILL_CAP) {
      for (let wk = first; wk <= last; wk += SECONDS_PER_WEEK) {
        const acc = byWeek.get(wk);
        weekly.push({
          weekStartTs: wk,
          realized: acc?.realized ?? 0,
          settled: acc?.settled ?? 0,
        });
      }
    } else {
      weekly = weekKeys.map((wk) => ({
        weekStartTs: wk,
        realized: byWeek.get(wk)!.realized,
        settled: byWeek.get(wk)!.settled,
      }));
    }
  }

  // ---- 前半 vs 后半(衰减检测) ----
  let halves: HalfSplit | null = null;
  if (n >= 6) {
    const mid = Math.floor(n / 2);
    const part = (rows: AnalysisPosition[]): HalfSplitStat => {
      let w = 0;
      let l = 0;
      let realized = 0;
      for (const p of rows) {
        const v = p.realized_pnl ?? 0;
        realized += v;
        if (v > 0) w++;
        else if (v < 0) l++;
      }
      return { n: rows.length, winRate: rate(w, l), realized };
    };
    halves = {
      earlier: part(settled.slice(0, mid)),
      later: part(settled.slice(mid)),
    };
  }

  // ---- 连胜连败(push 跳过、不打断) ----
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let run = 0; // 正在进行的连续段:正=赢、负=输
  for (const v of pnls) {
    if (v === 0) continue;
    if (v > 0) run = run > 0 ? run + 1 : 1;
    else run = run < 0 ? run - 1 : -1;
    if (run > maxWinStreak) maxWinStreak = run;
    if (-run > maxLossStreak) maxLossStreak = -run;
  }
  const streaks: StreakStats = { maxWinStreak, maxLossStreak, current: run };

  // ---- 盈利集中度 ----
  const winVals = pnls.filter((v) => v > 0).sort((a, b) => b - a);
  const lossVals = pnls.filter((v) => v < 0).sort((a, b) => a - b);
  const top3Wins = winVals.slice(0, 3).reduce((s, v) => s + v, 0);
  const top3Losses = lossVals.slice(0, 3).reduce((s, v) => s + -v, 0);
  const concentration: ConcentrationStats = {
    top3WinsShare: grossProfit > 0 ? top3Wins / grossProfit : null,
    netWithoutTop3Wins: winVals.length > 0 ? total - top3Wins : null,
    top3LossesShare: grossLoss > 0 ? top3Losses / grossLoss : null,
  };

  // ---- 持有时长分布 ----
  const durAcc = DURATION_BOUNDS.map(() => ({
    n: 0,
    wins: 0,
    losses: 0,
    realized: 0,
  }));
  for (const p of settled) {
    const hold = Math.max(0, (p.exit_ts ?? p.entry_ts) - p.entry_ts);
    const idx = DURATION_BOUNDS.findIndex((b) => hold < b.maxSec);
    const acc = durAcc[idx === -1 ? DURATION_BOUNDS.length - 1 : idx];
    acc.n++;
    const v = p.realized_pnl ?? 0;
    acc.realized += v;
    if (v > 0) acc.wins++;
    else if (v < 0) acc.losses++;
  }
  const durationBuckets: DurationBucket[] = DURATION_BOUNDS.map((b, i) => ({
    label: b.label,
    maxSec: b.maxSec,
    n: durAcc[i].n,
    wins: durAcc[i].wins,
    losses: durAcc[i].losses,
    winRate: rate(durAcc[i].wins, durAcc[i].losses),
    realized: durAcc[i].realized,
  }));

  // ---- 赛道细分(两级:一级汇总 + 二级子行,同一遍累计) ----
  interface CatAcc {
    n: number;
    wins: number;
    losses: number;
    entrySum: number;
    realized: number;
  }
  const newAcc = (): CatAcc => ({
    n: 0,
    wins: 0,
    losses: 0,
    entrySum: 0,
    realized: 0,
  });
  const feed = (acc: CatAcc, p: AnalysisPosition) => {
    acc.n++;
    acc.entrySum += p.entry_price;
    const v = p.realized_pnl ?? 0;
    acc.realized += v;
    if (v > 0) acc.wins++;
    else if (v < 0) acc.losses++;
  };
  const byCat = new Map<string, { top: CatAcc; subs: Map<string, CatAcc> }>();
  for (const p of settled) {
    const key = p.category ?? "未分类";
    const g = byCat.get(key) ?? { top: newAcc(), subs: new Map() };
    feed(g.top, p); // 一级吃全部仓 —— 子行是细分视图,不是再分配
    if (p.subcategory) {
      const sub = g.subs.get(p.subcategory) ?? newAcc();
      feed(sub, p);
      g.subs.set(p.subcategory, sub);
    }
    byCat.set(key, g);
  }
  const statOf = (acc: CatAcc) => ({
    n: acc.n,
    wins: acc.wins,
    losses: acc.losses,
    winRate: rate(acc.wins, acc.losses),
    avgEntry: acc.n > 0 ? acc.entrySum / acc.n : null,
    realized: acc.realized,
  });
  const bySample = (
    a: { n: number; realized: number },
    b: { n: number; realized: number },
  ) => b.n - a.n || b.realized - a.realized;
  const categories: CategoryGroup[] = [...byCat.entries()]
    .map(([category, g]) => ({
      category,
      ...statOf(g.top),
      subs: [...g.subs.entries()]
        .map(([subcategory, acc]) => ({ subcategory, ...statOf(acc) }))
        .sort(
          (a, b) =>
            bySample(a, b) || a.subcategory.localeCompare(b.subcategory),
        ),
    }))
    .sort((a, b) => bySample(a, b) || a.category.localeCompare(b.category));

  return {
    quality,
    oddsBuckets,
    weekly,
    halves,
    streaks,
    concentration,
    durationBuckets,
    categories,
    openCount,
  };
}
