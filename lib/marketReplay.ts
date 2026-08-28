import type { DB } from "./db";

// 时光机 · 市场复盘(第二梯队八件套,2026-08-28,设计
// docs/plans/2026-08-28-tier2-octet-design.md §六):重建「价格曲线 ×
// 本站告警标记 × 结算」时间线。本模块只管可测的纯逻辑(标记提取/区间规则);
// 曲线抓取(fetchPriceSeries,本批唯一按需上游)在路由层,**点击才拉**。
//
// 坐标统一到 outcomeIndex 0:二元市场 index 1 按 1−p 精确等价映射
// (标记 mappedFromOtherSide 供 UI 提示);多结果市场没有该等价,只保留
// index 0 并由页面声明局限 —— 不硬造坐标。

export interface ReplayMarker {
  ts: number;
  type: string;
  side: "BUY" | "SELL";
  /** 已映射到 index 0 坐标的价格。 */
  price: number;
  usd: number;
  outcome: string | null;
  mappedFromOtherSide: boolean;
}

const WINDOW_DAYS = 90;
const MARKER_CAP = 200;
const PAD_BEFORE_SEC = 4 * 3600;
const EMPTY_LOOKBACK_SEC = 48 * 3600;
const AFTER_CLOSE_SEC = 2 * 3600;

/**
 * 该市场 90 天内的本站告警 → 复盘标记(升序)。LIKE + created_at 下界,
 * 走 created_at 索引(alertHits 同款理由)。
 */
export function collectReplayMarkers(
  db: DB,
  conditionId: string,
  opts: { nowSec?: number; outcomeCount?: number } = {},
): ReplayMarker[] {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const outcomeCount = opts.outcomeCount ?? 2;
  const rows = db
    .prepare(
      `SELECT type, payload, created_at FROM alerts
        WHERE created_at >= ? AND payload LIKE ?
        ORDER BY created_at ASC LIMIT ?`,
    )
    .all(nowSec - WINDOW_DAYS * 86_400, `%${conditionId}%`, MARKER_CAP) as {
    type: string | null;
    payload: string | null;
    created_at: number | null;
  }[];
  const out: ReplayMarker[] = [];
  for (const r of rows) {
    if (!r.payload) continue;
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (p.conditionId !== conditionId) continue; // LIKE 是粗筛,这里精配
    const idx = typeof p.outcomeIndex === "number" ? p.outcomeIndex : 0;
    const grouped = r.type === "consensus" || r.type === "cohort";
    const rawPrice = grouped
      ? typeof p.avgBuyPrice === "number"
        ? p.avgBuyPrice
        : null
      : typeof p.price === "number"
        ? p.price
        : null;
    if (rawPrice == null || !(rawPrice > 0 && rawPrice < 1)) continue;
    let price = rawPrice;
    let mapped = false;
    if (idx !== 0) {
      if (outcomeCount === 2 && idx === 1) {
        price = 1 - rawPrice;
        mapped = true;
      } else {
        continue; // 多结果市场的其它边:无等价映射,不硬造
      }
    }
    const ts = grouped
      ? typeof p.lastTs === "number"
        ? p.lastTs
        : (r.created_at ?? 0)
      : typeof p.timestamp === "number"
        ? p.timestamp
        : (r.created_at ?? 0);
    const usd = grouped
      ? typeof p.totalNetUsd === "number"
        ? p.totalNetUsd
        : 0
      : typeof p.size === "number" && typeof p.price === "number"
        ? p.size * p.price
        : 0;
    out.push({
      ts,
      type: r.type ?? "large",
      side: p.side === "SELL" ? "SELL" : "BUY",
      price,
      usd,
      outcome: typeof p.outcome === "string" ? p.outcome : null,
      mappedFromOtherSide: mapped,
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** 曲线区间:有告警从首告警前推 4h,无告警回看 48h;收盘截到结算后 2h。 */
export function replayRange(
  markers: { ts: number }[],
  nowSec: number,
  meta: { closed: boolean; endDateSec: number | null },
): { startTs: number; endTs: number } {
  const startTs =
    markers.length > 0
      ? Math.min(...markers.map((m) => m.ts)) - PAD_BEFORE_SEC
      : nowSec - EMPTY_LOOKBACK_SEC;
  const endTs =
    meta.closed && meta.endDateSec != null
      ? Math.min(nowSec, meta.endDateSec + AFTER_CLOSE_SEC)
      : nowSec;
  return { startTs, endTs: Math.max(endTs, startTs + 3600) };
}
