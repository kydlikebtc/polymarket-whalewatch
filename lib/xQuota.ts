// X 发帖预算台账 —— 本地 fail-closed 熔断(平台侧 spending cap 是第二道保险)。
//
// 计费事实(2026-02 X 按量付费):无链接帖 $0.015/条,带链接帖 $0.20/条。
// 台账口径:status IN ('claimed','posted') 都计入 —— claim 后进程崩溃留下的
// 孤儿行宁可虚占预算,也不能让熔断放水(安全方向永远选"少发")。skipped/
// failed 不计:skipped 从未发出,failed 是 4xx 被拒(X 不对被拒请求计费;
// 若这个假设错了,X 端 spending cap 兜底)。
import type { DB } from "./db";
import { utcWeekStart } from "./followAnalysis";

export const COST_TEXT_USD = 0.015;
export const COST_LINK_USD = 0.2;

// 每日帖数上限的**出厂默认**,按 kind。无键 = 不限(consensus 天然稀有、
// weekly 每周一条,由各自 dedup 约束)。whale 20 给赛前/共识留出席位:
// $15/月 ≈ 33 帖/天,大单流最容易把配额打光,cap 在 kind 层比在优先级层
// 实现简单得多。运营者可在 /manage 覆盖(lib/xParams),调用方经
// QuotaInput.dailyCap 传入;这里只在没人传时兜底。
export const DAILY_CAP: Record<string, number> = {
  whale: 20,
  pregame: 3,
  // 战报量天然受"发过多少信号"约束,但开关刚打开时会有历史积压,
  // 加个日 cap 防止一次性刷屏。
  settled: 5,
};

export function costOf(hasLink: boolean): number {
  return hasLink ? COST_LINK_USD : COST_TEXT_USD;
}

function utcMonthBounds(nowSec: number): { from: number; to: number } {
  const d = new Date(nowSec * 1000);
  const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  const to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  return { from, to };
}

// 三个窗口共用一条 SQL:台账口径完全一致(claimed+posted),只有窗口边界不同。
function spentUsdBetween(db: DB, from: number, to: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(est_cost_usd), 0) AS s FROM x_posts
        WHERE status IN ('claimed','posted') AND created_at >= ? AND created_at < ?`,
    )
    .get(from, to) as { s: number };
  return row.s;
}

export function spentUsdInUtcMonth(db: DB, nowSec: number): number {
  const { from, to } = utcMonthBounds(nowSec);
  return spentUsdBetween(db, from, to);
}

export function spentUsdInUtcDay(db: DB, nowSec: number): number {
  const from = Math.floor(nowSec / 86400) * 86400;
  return spentUsdBetween(db, from, from + 86400);
}

/** UTC 周(周一起,与 xWeekly 的 utcWeekStart 同一口径)。 */
export function spentUsdInUtcWeek(db: DB, nowSec: number): number {
  const from = utcWeekStart(nowSec);
  return spentUsdBetween(db, from, from + 7 * 86400);
}

export function postedTodayCount(db: DB, kind: string, nowSec: number): number {
  const dayStart = Math.floor(nowSec / 86400) * 86400;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM x_posts
        WHERE kind = ? AND status IN ('claimed','posted')
          AND created_at >= ? AND created_at < ?`,
    )
    .get(kind, dayStart, dayStart + 86400) as { n: number };
  return row.n;
}

export interface QuotaInput {
  kind: string;
  hasLink: boolean;
  budgetUsd: number;
  nowSec: number;
  /**
   * 日上限覆盖(/manage 可配,见 lib/xParams):undefined = 用出厂
   * DAILY_CAP;null = 明确不限;数字 = 该 kind 当日至多 N 条。
   */
  dailyCap?: number | null;
  /**
   * 日/周花费上限($,/manage 可配):null/undefined = 不限。月上限
   * (budgetUsd)是必填的硬熔断,这两个是它之下的细分闸 —— 台账口径与
   * 月度完全一致(claimed+posted)。
   */
  dailySpendCapUsd?: number | null;
  weeklySpendCapUsd?: number | null;
}

/**
 * 发帖前的配额判定。拒绝时带 reason(进日志,调试者要能从日志直接看出
 * "为什么这条没发":是月预算熔断还是日 cap)。
 */
export function quotaDecision(
  db: DB,
  i: QuotaInput,
): { ok: true } | { ok: false; reason: string } {
  const cost = costOf(i.hasLink);
  const spent = spentUsdInUtcMonth(db, i.nowSec);
  if (spent + cost > i.budgetUsd) {
    return {
      ok: false,
      reason: `monthly budget: spent $${spent.toFixed(3)} + $${cost} > $${i.budgetUsd}`,
    };
  }
  // 周/日花费闸(月之下的细分,从大窗口到小窗口依次判):不设即跳过。
  if (i.weeklySpendCapUsd != null) {
    const w = spentUsdInUtcWeek(db, i.nowSec);
    if (w + cost > i.weeklySpendCapUsd) {
      return {
        ok: false,
        reason: `weekly spend cap: spent $${w.toFixed(3)} + $${cost} > $${i.weeklySpendCapUsd}`,
      };
    }
  }
  if (i.dailySpendCapUsd != null) {
    const d = spentUsdInUtcDay(db, i.nowSec);
    if (d + cost > i.dailySpendCapUsd) {
      return {
        ok: false,
        reason: `daily spend cap: spent $${d.toFixed(3)} + $${cost} > $${i.dailySpendCapUsd}`,
      };
    }
  }
  const cap = i.dailyCap === undefined ? DAILY_CAP[i.kind] : i.dailyCap;
  if (cap != null) {
    const today = postedTodayCount(db, i.kind, i.nowSec);
    if (today >= cap) {
      return { ok: false, reason: `daily cap: ${i.kind} ${today}/${cap}` };
    }
  }
  return { ok: true };
}
