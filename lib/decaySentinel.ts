// 衰变哨兵(第一梯队五件套,2026-08-28):把「这档策略还灵吗」从年度体检变成
// 每次 /api/follow 响应都现算的序贯监控。深度分析面板的前半/后半对比是二分
// 快照,要等人看图;这里用单侧 CUSUM 盯下行漂移,偏离即亮牌。
//
// 口径:逐仓贡献 = (realized_pnl − fee_usd)/shares,概率点 —— 与
// lib/walkforward.ts contribOf 的 hold 规则同族(记账基准 entry_price,
// 二元结算下恰为 won − q − 每股费)。两处刻意分歧,各有论证:
//  1. fee 缺失按 0 计而非整仓剔除(walk-forward 剔除):哨兵要的是不断流的
//     观察序列,老仓剔掉会把监控段掏空;费用 ~1-2¢ 对衰变判定是二阶项。
//  2. 同市场多仓折成均值一个观察点(walk-forward 不折、只做聚类方差):
//     CUSUM 消费的是准独立观察流,同市场 N 仓共享同一次结算,不折等于把
//     一次随机事件当 N 次证据。折均值不需要「挑方向」—— 它平均的是该策略
//     自己在这个市场的净立场,walk-forward 反对的「整簇挑边」不在此发生。
//
// 基线 = 前 max(10, 40%) 个市场点的均值与样本标准差(相对自己的历史,而非
// walk-forward 报告 —— 报告只覆盖进网格的档且随重推刷新,哨兵要的是 19 档
// 全覆盖的稳定参照;两口径靠同一 contrib 公式保持可对话)。
// 红线:纯展示,不触发任何自动停用/参数修改 —— 与「生产参数永不自动改」同源。

export type DecayState = "insufficient" | "ok" | "watch" | "degraded";

export interface DecayVerdict {
  state: DecayState;
  /** 市场级观察点总数(不是仓数 —— 同市场多仓只算一点)。 */
  marketPoints: number;
  baselinePoints: number;
  /** 基线均值 μ0(概率点);insufficient 时 null。 */
  baselinePoint: number | null;
  /** 监控段近端均值(最后 ≤10 个市场点)。 */
  recentPoint: number | null;
  /** 当前 CUSUM 值(σ 单位);insufficient 时 null。 */
  cusum: number | null;
  /** 监控段 CUSUM 峰值(σ 单位)。 */
  cusumPeak: number | null;
  /** 首次触及 4σ 报警线的市场时刻;从未触及为 null。 */
  crossedAtTs: number | null;
}

/** 基线最少市场点数(不足这个数连 μ0/σ 都不可信)。 */
export const DECAY_BASE_MIN = 10;
/** 监控段最少市场点数(CUSUM 一两个点说明不了漂移)。 */
export const DECAY_MONITOR_MIN = 5;
const BASE_FRAC = 0.4;
/** CUSUM 松弛系数:小于 0.5σ 的抖动不计入漂移证据。 */
const K_SLACK = 0.5;
const H_DEGRADED = 4;
const H_WATCH = 2.5;
/**
 * σ 下限(概率点):小样本下基线可能碰巧全同值(σ=0,任何偏离都秒触发)。
 * 半个 nickel 的概率点是本仓刻度里最小的有意义变化量。
 */
const MIN_SIGMA = 0.05;
const RECENT_N = 10;

/** decayVerdict 消费的最小仓位形状(FollowPositionRow 的子集,便于注入夹具)。 */
export interface DecayPosition {
  condition_id: string;
  status: string;
  exit_ts: number | null;
  realized_pnl: number | null;
  fee_usd: number | null;
  shares: number;
}

export interface MarketPoint {
  ts: number;
  point: number;
}

/**
 * 已结算仓 → 市场级观察点(升序)。同市场多仓折均值;时间戳取该市场最后
 * 结算时刻(市场的「事件时刻」= 它的结算,而非某一仓的入场)。
 * 剔除:未结算 / realized_pnl 缺失 / shares ≤ 0(badShares,同 walk-forward)。
 */
export function clusterMarketPoints(positions: DecayPosition[]): MarketPoint[] {
  const byMarket = new Map<string, { ts: number; sum: number; n: number }>();
  for (const p of positions) {
    if (p.status !== "settled") continue;
    if (p.realized_pnl == null || p.exit_ts == null) continue;
    if (!(p.shares > 0)) continue;
    const contrib = (p.realized_pnl - (p.fee_usd ?? 0)) / p.shares;
    if (!Number.isFinite(contrib)) continue;
    const m = byMarket.get(p.condition_id) ?? { ts: 0, sum: 0, n: 0 };
    m.ts = Math.max(m.ts, p.exit_ts);
    m.sum += contrib;
    m.n += 1;
    byMarket.set(p.condition_id, m);
  }
  return [...byMarket.values()]
    .map((m) => ({ ts: m.ts, point: m.sum / m.n }))
    .sort((a, b) => a.ts - b.ts);
}

export function decayVerdict(positions: DecayPosition[]): DecayVerdict {
  const points = clusterMarketPoints(positions);
  const n = points.length;
  const nBase = Math.max(DECAY_BASE_MIN, Math.ceil(n * BASE_FRAC));
  if (n < nBase + DECAY_MONITOR_MIN) {
    return {
      state: "insufficient",
      marketPoints: n,
      baselinePoints: 0,
      baselinePoint: null,
      recentPoint: null,
      cusum: null,
      cusumPeak: null,
      crossedAtTs: null,
    };
  }

  const base = points.slice(0, nBase);
  const mon = points.slice(nBase);
  const mu0 = base.reduce((s, p) => s + p.point, 0) / base.length;
  const ss = base.reduce((s, p) => s + (p.point - mu0) ** 2, 0);
  const sigma = Math.max(Math.sqrt(ss / (base.length - 1)), MIN_SIGMA);

  // 单侧 CUSUM(下行):S ← max(0, S + (μ0 − x − k·σ))。σ 单位对外。
  let s = 0;
  let peak = 0;
  let crossedAtTs: number | null = null;
  for (const p of mon) {
    s = Math.max(0, s + (mu0 - p.point - K_SLACK * sigma));
    peak = Math.max(peak, s);
    if (crossedAtTs == null && s / sigma >= H_DEGRADED) crossedAtTs = p.ts;
  }
  const sSigma = s / sigma;
  const state: DecayState =
    sSigma >= H_DEGRADED ? "degraded" : sSigma >= H_WATCH ? "watch" : "ok";

  const recent = mon.slice(-RECENT_N);
  const recentPoint = recent.reduce((v, p) => v + p.point, 0) / recent.length;

  return {
    state,
    marketPoints: n,
    baselinePoints: base.length,
    baselinePoint: mu0,
    recentPoint,
    cusum: sSigma,
    cusumPeak: peak / sigma,
    crossedAtTs,
  };
}
