import type { WalkforwardReport, WfTierReport } from "./walkforward";

// 重推日历化(第一梯队五件套,2026-08-28):walk-forward 从「一次性大事」变成
// 月度例行。两件纯逻辑:①due 口径(距上次报告满 30 天 —— 与 /manage 使用
// 说明「节律:月度,validate 折按完整 UTC 周自然长出」同源;第三轮脑暴设计稿
// 写的 90 天季度在实现期修正为产品自述的月度);②两份报告的结构性翻案 diff。
//
// 翻案的定义刻意窄:存活集合/观察名单/薄档判定的变化才算 —— point 每次重跑
// 都会漂一点,把漂移算翻案等于天天狼来了,diff 就没人看了。point 差只作为
// changed 档的上下文带出。红线不变:diff 只呈现,不自动改任何档参数。

export const WF_DUE_DAYS = 30;

export interface WfDueInfo {
  hasRun: boolean;
  lastCreatedAt: number | null;
  dueAtSec: number | null;
  daysSinceLast: number | null;
  /** 距 due 还有几天;负数 = 已到期 N 天。从未跑过为 null(due 恒真)。 */
  daysLeft: number | null;
  due: boolean;
}

export function wfDueInfo(
  lastCreatedAtSec: number | null,
  nowSec: number,
): WfDueInfo {
  if (lastCreatedAtSec == null) {
    return {
      hasRun: false,
      lastCreatedAt: null,
      dueAtSec: null,
      daysSinceLast: null,
      daysLeft: null,
      due: true,
    };
  }
  const dueAtSec = lastCreatedAtSec + WF_DUE_DAYS * 86_400;
  const daysSinceLast = Math.floor((nowSec - lastCreatedAtSec) / 86_400);
  const daysLeft = Math.ceil((dueAtSec - nowSec) / 86_400);
  return {
    hasRun: true,
    lastCreatedAt: lastCreatedAtSec,
    dueAtSec,
    daysSinceLast,
    daysLeft,
    due: nowSec >= dueAtSec,
  };
}

export interface WfTierDiff {
  strategyId: number;
  name: string;
  /** 新入/移出存活集合的变体(展示用 label,对齐用 key)。 */
  survivorAdded: string[];
  survivorRemoved: string[];
  watchAdded: string[];
  watchRemoved: string[];
  /** 薄档判定翻转:nowThin = 变薄(折退化),nowThick = 转厚(数据长出来了)。 */
  thinFlipped: "nowThin" | "nowThick" | null;
  /** currentStat.point 差(curr − prev,概率点);任一侧缺失为 null。仅上下文。 */
  pointDelta: number | null;
}

export interface WfReportDiff {
  prevCreatedAt: number;
  currCreatedAt: number;
  /** 只在旧/新一侧出现的档名(档集合本身的变化,先于逐档对比点名)。 */
  tiersOnlyInPrev: string[];
  tiersOnlyInCurr: string[];
  changed: WfTierDiff[];
  unchangedTiers: number;
}

/** 变体 key → 展示 label(candidates 里查;查不到退回 key 本身,绝不吞条目)。 */
function labelOf(t: WfTierReport, key: string): string {
  return t.candidates.find((c) => c.key === key)?.label ?? key;
}

function setDiff(a: string[], b: string[]): string[] {
  const bs = new Set(b);
  return a.filter((x) => !bs.has(x));
}

export function diffWalkforwardReports(
  prev: { createdAt: number; report: WalkforwardReport },
  curr: { createdAt: number; report: WalkforwardReport },
): WfReportDiff {
  const prevBy = new Map(prev.report.tiers.map((t) => [t.strategyId, t]));
  const currBy = new Map(curr.report.tiers.map((t) => [t.strategyId, t]));

  const tiersOnlyInPrev = prev.report.tiers
    .filter((t) => !currBy.has(t.strategyId))
    .map((t) => t.name);
  const tiersOnlyInCurr = curr.report.tiers
    .filter((t) => !prevBy.has(t.strategyId))
    .map((t) => t.name);

  const changed: WfTierDiff[] = [];
  let unchangedTiers = 0;
  for (const ct of curr.report.tiers) {
    const pt = prevBy.get(ct.strategyId);
    if (!pt) continue; // 新档没有「上次」,已在 tiersOnlyInCurr 点名
    const survivorAdded = setDiff(ct.survivors, pt.survivors).map((k) =>
      labelOf(ct, k),
    );
    const survivorRemoved = setDiff(pt.survivors, ct.survivors).map((k) =>
      labelOf(pt, k),
    );
    const cw = ct.watchlist.map((w) => w.key);
    const pw = pt.watchlist.map((w) => w.key);
    const watchAdded = setDiff(cw, pw).map(
      (k) => ct.watchlist.find((w) => w.key === k)?.label ?? k,
    );
    const watchRemoved = setDiff(pw, cw).map(
      (k) => pt.watchlist.find((w) => w.key === k)?.label ?? k,
    );
    const thinFlipped =
      pt.thin === ct.thin ? null : ct.thin ? "nowThin" : "nowThick";
    const structural =
      survivorAdded.length > 0 ||
      survivorRemoved.length > 0 ||
      watchAdded.length > 0 ||
      watchRemoved.length > 0 ||
      thinFlipped != null;
    if (!structural) {
      unchangedTiers++;
      continue;
    }
    const pointDelta =
      pt.currentStat != null && ct.currentStat != null
        ? ct.currentStat.point - pt.currentStat.point
        : null;
    changed.push({
      strategyId: ct.strategyId,
      name: ct.name,
      survivorAdded,
      survivorRemoved,
      watchAdded,
      watchRemoved,
      thinFlipped,
      pointDelta,
    });
  }

  return {
    prevCreatedAt: prev.createdAt,
    currCreatedAt: curr.createdAt,
    tiersOnlyInPrev,
    tiersOnlyInCurr,
    changed,
    unchangedTiers,
  };
}
