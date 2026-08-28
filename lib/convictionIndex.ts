import type { DB } from "./db";
import {
  DIVERGENCE_SMALL_MIN_USD,
  DIVERGENCE_WHALE_MIN_USD,
} from "./marketPulse";

// 确信指数(第一梯队五件套,2026-08-28):品类×日的「激辩度」0-100。
// 高 = 激辩/恐慌(阵营对峙 + 小单鲸鱼对立 + 价格动荡 + 量能异动),
// 低 = 确信(一边倒、平静)—— VIX 语义。四分量全部来自 market_daily 现成列;
// 簿面数据本仓不存在,故刻意没有「簿厚」分量(第三轮脑暴 §评估记录了这条
// 零上游约束下的不可能)。与 buildPulse 同纪律:读取侧现算、评分不落库
// (公式还会演化,落库就要背回填),分量逐项返回,UI 必须能展开「为什么高」。

export interface ConvictionComponents {
  /** 阵营对峙 0..1:量能加权 1−one_sided(one_sided 缺失的行不进该分量)。 */
  contest: number;
  /** 对立度 0..1:满足 pulse 同款分歧门槛的市场的量能占比。 */
  divergence: number;
  /** 价格动荡 0..1:量能加权 |末−首|÷20¢ 封顶(缺价行不进该分量)。 */
  priceMove: number;
  /** 量能异动 0..1:品类日量 vs 前 ≤14 日自身基线;<3 天基线用当日横截面分位。 */
  volSurge: number;
}

export interface ConvictionDay {
  day: string;
  score: number;
}

export interface ConvictionCategory {
  /** market_daily.category 原值;null 归 "" 桶,展示标签由 UI 决定。 */
  key: string;
  /** 最新日 0-100。 */
  score: number;
  components: ConvictionComponents;
  volumeUsd: number;
  markets: number;
  /** 最新日 volSurge 的自身基线天数(<3 = 用的横截面分位,诚实字段同 pulse)。 */
  volBaselineDays: number;
  /** 窗口内逐日分数,升序;低于门槛的日子缺席(不是 0 分)。 */
  series: ConvictionDay[];
}

export interface ConvictionReport {
  latestDay: string | null;
  /** 窗口内实有天数(≤ opts.days)。 */
  days: number;
  /** 最新日量能降序,≤ topN。 */
  categories: ConvictionCategory[];
}

/** 材料性门槛:品类日总量低于它不给分(1 笔小单的对峙度也是满分,纯噪声)。 */
export const CONVICTION_MIN_VOLUME_USD = 10_000;
const WINDOW_DAYS = 30;
const TOP_N = 8;
const BASELINE_DAYS = 14;
const MIN_BASELINE_DAYS = 3;
const WEIGHTS = {
  contest: 0.3,
  divergence: 0.3,
  priceMove: 0.2,
  volSurge: 0.2,
};

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

interface Row {
  day: string;
  category: string | null;
  volume_usd: number;
  one_sided: number | null;
  small_net_usd: number | null;
  small_top_outcome: string | null;
  whale_net_usd: number | null;
  whale_top_outcome: string | null;
  price_first: number | null;
  price_last: number | null;
}

/** 品类×日聚合桶:分量的分子分母分开攒 —— 缺材料的行不摊薄有材料的行。 */
interface Agg {
  vol: number;
  markets: number;
  contestNum: number;
  contestDen: number;
  divVol: number;
  moveNum: number;
  moveDen: number;
}

export function buildConvictionIndex(
  db: DB,
  opts: { days?: number; topN?: number } = {},
): ConvictionReport {
  const windowDays = opts.days ?? WINDOW_DAYS;
  const topN = opts.topN ?? TOP_N;
  // day 是 yyyy-mm-dd 文本,字典序即时间序(market_daily 既有裁决)。
  const daysDesc = (
    db
      .prepare(
        "SELECT DISTINCT day FROM market_daily ORDER BY day DESC LIMIT ?",
      )
      .all(windowDays) as { day: string }[]
  ).map((r) => r.day);
  if (daysDesc.length === 0) {
    return { latestDay: null, days: 0, categories: [] };
  }
  const daysAsc = [...daysDesc].reverse();
  const latestDay = daysDesc[0];

  const rows = db
    .prepare(
      `SELECT day, category, volume_usd, one_sided,
              small_net_usd, small_top_outcome, whale_net_usd, whale_top_outcome,
              price_first, price_last
         FROM market_daily WHERE day IN (${daysAsc.map(() => "?").join(",")})`,
    )
    .all(...daysAsc) as Row[];

  // (品类, 日) 聚合。品类 null 归 "" 桶 —— 不发明「未分类」字面量,标签是 UI 的事。
  const byCatDay = new Map<string, Map<string, Agg>>();
  for (const r of rows) {
    const key = r.category ?? "";
    const days = byCatDay.get(key) ?? new Map<string, Agg>();
    byCatDay.set(key, days);
    const a = days.get(r.day) ?? {
      vol: 0,
      markets: 0,
      contestNum: 0,
      contestDen: 0,
      divVol: 0,
      moveNum: 0,
      moveDen: 0,
    };
    days.set(r.day, a);
    const w = r.volume_usd;
    a.vol += w;
    a.markets += 1;
    if (r.one_sided != null) {
      a.contestNum += w * clamp01(1 - r.one_sided);
      a.contestDen += w;
    }
    if (
      r.small_top_outcome != null &&
      r.whale_top_outcome != null &&
      r.small_top_outcome !== r.whale_top_outcome &&
      (r.small_net_usd ?? 0) >= DIVERGENCE_SMALL_MIN_USD &&
      (r.whale_net_usd ?? 0) >= DIVERGENCE_WHALE_MIN_USD
    ) {
      a.divVol += w;
    }
    if (r.price_first != null && r.price_last != null) {
      a.moveNum += w * clamp01(Math.abs(r.price_last - r.price_first) / 0.2);
      a.moveDen += w;
    }
  }

  // 逐日给分。volSurge 基线 = 该品类窗口内、当日前 ≤14 天的日量均值(≥3 天才用);
  // 不足时退化为「当日各品类日量的横截面分位」(单类 0.5)—— 与 pulse 同款备胎。
  const dayCutoff = (day: string): string =>
    new Date(
      new Date(`${day}T00:00:00Z`).getTime() - BASELINE_DAYS * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
  const scoreOf = (
    a: Agg,
    volSurge: number,
  ): { score: number; components: ConvictionComponents } => {
    const contest = a.contestDen > 0 ? a.contestNum / a.contestDen : 0;
    const divergence = a.vol > 0 ? a.divVol / a.vol : 0;
    const priceMove = a.moveDen > 0 ? a.moveNum / a.moveDen : 0;
    const components = { contest, divergence, priceMove, volSurge };
    const score = Math.round(
      100 *
        (WEIGHTS.contest * contest +
          WEIGHTS.divergence * divergence +
          WEIGHTS.priceMove * priceMove +
          WEIGHTS.volSurge * volSurge),
    );
    return { score, components };
  };

  const categories: ConvictionCategory[] = [];
  for (const [key, days] of byCatDay) {
    const latest = days.get(latestDay);
    if (!latest || latest.vol < CONVICTION_MIN_VOLUME_USD) continue;

    const surgeOf = (day: string, vol: number): { v: number; n: number } => {
      const cutoff = dayCutoff(day);
      const prior: number[] = [];
      for (const [d, a] of days) {
        if (d < day && d >= cutoff) prior.push(a.vol);
      }
      if (prior.length >= MIN_BASELINE_DAYS) {
        const mean = prior.reduce((s, v) => s + v, 0) / prior.length;
        const ratio = mean > 0 ? vol / mean : 1;
        return { v: clamp01(Math.log10(Math.max(ratio, 1))), n: prior.length };
      }
      // 横截面分位:当日所有过门槛品类的日量排位。
      const vols: number[] = [];
      for (const d2 of byCatDay.values()) {
        const a2 = d2.get(day);
        if (a2 && a2.vol >= CONVICTION_MIN_VOLUME_USD) vols.push(a2.vol);
      }
      if (vols.length <= 1) return { v: 0.5, n: prior.length };
      let below = 0;
      for (const x of vols) if (x < vol) below++;
      return { v: below / (vols.length - 1), n: prior.length };
    };

    const series: ConvictionDay[] = [];
    for (const day of daysAsc) {
      const a = days.get(day);
      if (!a || a.vol < CONVICTION_MIN_VOLUME_USD) continue;
      series.push({ day, score: scoreOf(a, surgeOf(day, a.vol).v).score });
    }

    const latestSurge = surgeOf(latestDay, latest.vol);
    const { score, components } = scoreOf(latest, latestSurge.v);
    categories.push({
      key,
      score,
      components,
      volumeUsd: latest.vol,
      markets: latest.markets,
      volBaselineDays: latestSurge.n,
      series,
    });
  }

  categories.sort((a, b) => b.volumeUsd - a.volumeUsd);
  return {
    latestDay,
    days: daysAsc.length,
    categories: categories.slice(0, topN),
  };
}
