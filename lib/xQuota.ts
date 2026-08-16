// X 发帖预算台账 —— 本地 fail-closed 熔断(平台侧 spending cap 是第二道保险)。
//
// 计费事实(2026-02 X 按量付费):无链接帖 $0.015/条,带链接帖 $0.20/条。
// 台账口径:status IN ('claimed','posted') 都计入 —— claim 后进程崩溃留下的
// 孤儿行宁可虚占预算,也不能让熔断放水(安全方向永远选"少发")。skipped/
// failed 不计:skipped 从未发出,failed 是 4xx 被拒(X 不对被拒请求计费;
// 若这个假设错了,X 端 spending cap 兜底)。
import type { DB } from "./db";

export const COST_TEXT_USD = 0.015;
export const COST_LINK_USD = 0.2;

// 每日帖数上限,按 kind。无键 = 不限(consensus 天然稀有、weekly 每周一条,
// 由各自 dedup 约束)。whale 20 给赛前/共识留出席位:$15/月 ≈ 33 帖/天,
// 大单流最容易把配额打光,cap 在 kind 层比在优先级层实现简单得多。
export const DAILY_CAP: Record<string, number> = { whale: 20, pregame: 3 };

export function costOf(hasLink: boolean): number {
  return hasLink ? COST_LINK_USD : COST_TEXT_USD;
}

function utcMonthBounds(nowSec: number): { from: number; to: number } {
  const d = new Date(nowSec * 1000);
  const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  const to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  return { from, to };
}

export function spentUsdInUtcMonth(db: DB, nowSec: number): number {
  const { from, to } = utcMonthBounds(nowSec);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(est_cost_usd), 0) AS s FROM x_posts
        WHERE status IN ('claimed','posted') AND created_at >= ? AND created_at < ?`,
    )
    .get(from, to) as { s: number };
  return row.s;
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
  const cap = DAILY_CAP[i.kind];
  if (cap != null) {
    const today = postedTodayCount(db, i.kind, i.nowSec);
    if (today >= cap) {
      return { ok: false, reason: `daily cap: ${i.kind} ${today}/${cap}` };
    }
  }
  return { ok: true };
}
