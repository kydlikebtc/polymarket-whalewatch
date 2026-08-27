import type { DB } from "./db";
import { clusteredInterval } from "./outcomeStats";

// 市场校准研究(docs/plans/2026-08-27-content-engine-design.md §3)。
// 这**不是**我们的战绩页:样本 = (alert 时点的市场隐含概率, 最终结算),
// 回答「Polymarket 的价格本身准不准」。BUY 观察贡献 q=price、SELL 贡献
// q=1−price —— 与 settleWon/gradeRows 同一方向约定,won 已按该方向判定,
// 于是每条观察就是一次「市场说概率 q 的事件,最后发生了吗」。
//
// 选择偏差是本模块的可信度底线,页面必须原文展示:观察时点不是随机抽样
// (是鲸鱼活动触发 alert 的时刻),市场范围是本站覆盖过的市场 —— 结论只
// 主张到这个样本。CI 按市场数聚簇(clusteredInterval):同市场多条 alert
// 是同一次随机事件的复制品,8-18 订正的教训直接复用。

export interface CalibrationBand {
  /** 展示名,如 "40–50¢"。 */
  band: string;
  lo: number;
  hi: number;
  n: number;
  /** 去重市场数 —— 聚簇 CI 的有效样本。 */
  markets: number;
  wins: number;
  /** 实际胜率 wins/n。 */
  observed: number;
  /** 带内隐含概率均值 —— 市场自己的预期。 */
  implied: number;
  /** observed − implied。正 = 该价位系统性便宜。 */
  gap: number;
  ciLo: number;
  ciHi: number;
}

export interface CalibrationGroup {
  key: string;
  n: number;
  markets: number;
  bands: CalibrationBand[];
}

export interface CalibrationReport {
  updatedAt: number;
  totalN: number;
  totalMarkets: number;
  overall: CalibrationGroup;
  /** 样本 ≥ CATEGORY_MIN_N 的一级分类,按样本量降序。 */
  byCategory: CalibrationGroup[];
}

export const CATEGORY_MIN_N = 30;
const BANDS = 10;

interface Obs {
  q: number;
  won: boolean;
  cid: string;
  category: string | null;
}

function groupOf(key: string, obs: Obs[]): CalibrationGroup {
  const byBand: Obs[][] = Array.from({ length: BANDS }, () => []);
  for (const o of obs) {
    byBand[Math.min(BANDS - 1, Math.floor(o.q * BANDS))].push(o);
  }
  const bands: CalibrationBand[] = byBand.map((list, i) => {
    const lo = i / BANDS;
    const hi = (i + 1) / BANDS;
    const n = list.length;
    const wins = list.filter((o) => o.won).length;
    const markets = new Set(list.map((o) => o.cid)).size;
    const implied = n > 0 ? list.reduce((s, o) => s + o.q, 0) / n : 0;
    const observed = n > 0 ? wins / n : 0;
    const ci = n > 0 ? clusteredInterval(wins, n, markets) : { lo: 0, hi: 1 };
    return {
      band: `${Math.round(lo * 100)}–${Math.round(hi * 100)}¢`,
      lo,
      hi,
      n,
      markets,
      wins,
      observed,
      implied,
      gap: observed - implied,
      ciLo: ci.lo,
      ciHi: ci.hi,
    };
  });
  return {
    key,
    n: obs.length,
    markets: new Set(obs.map((o) => o.cid)).size,
    bands,
  };
}

export function buildCalibration(
  db: DB,
  opts: { nowSec?: number } = {},
): CalibrationReport {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(
      `SELECT
         COALESCE(json_extract(a.payload,'$.price'),
                  json_extract(a.payload,'$.avgBuyPrice')) AS price,
         COALESCE(json_extract(a.payload,'$.side'), 'BUY') AS side,
         json_extract(a.payload,'$.conditionId') AS cid,
         json_extract(a.payload,'$.eventSlug') AS eventSlug,
         ao.won AS won
       FROM alerts a JOIN alert_outcomes ao ON ao.alert_id = a.id
       WHERE ao.won IS NOT NULL AND a.type IN ('large','smart','consensus')`,
    )
    .all() as {
    price: number | null;
    side: string;
    cid: string | null;
    eventSlug: string | null;
    won: number;
  }[];

  // 分类走本地 event_category 一次 IN 查询 —— 与全站同一实现口径。
  const slugs = [
    ...new Set(rows.map((r) => r.eventSlug).filter((s): s is string => !!s)),
  ];
  const cats = new Map<string, string | null>();
  if (slugs.length > 0) {
    const placeholders = slugs.map(() => "?").join(",");
    for (const c of db
      .prepare(
        `SELECT event_slug, category FROM event_category WHERE event_slug IN (${placeholders})`,
      )
      .all(...slugs) as { event_slug: string; category: string | null }[]) {
      cats.set(c.event_slug, c.category);
    }
  }

  const obs: Obs[] = [];
  for (const r of rows) {
    if (r.price == null || r.cid == null) continue;
    if (r.price <= 0 || r.price >= 1) continue;
    const q = r.side === "SELL" ? 1 - r.price : r.price;
    obs.push({
      q,
      won: r.won === 1,
      cid: r.cid,
      category: r.eventSlug ? (cats.get(r.eventSlug) ?? null) : null,
    });
  }

  const byCat = new Map<string, Obs[]>();
  for (const o of obs) {
    if (o.category == null) continue;
    const list = byCat.get(o.category) ?? [];
    list.push(o);
    byCat.set(o.category, list);
  }
  const byCategory = [...byCat.entries()]
    .filter(([, list]) => list.length >= CATEGORY_MIN_N)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, list]) => groupOf(key, list));

  const overall = groupOf("overall", obs);
  return {
    updatedAt: nowSec,
    totalN: obs.length,
    totalMarkets: overall.markets,
    overall,
    byCategory,
  };
}
