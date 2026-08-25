// 周报成绩单 —— 数据聚合(buildWeeklyReport,供 OG 图卡路由与帖文共用)
// 与周一发帖 tick(maybeWeeklyPost)。
//
// 发帖是全家桶里唯一带链接的 $0.20 帖:图卡引流量,链接接住流量。
// 副作用顺序刻意设计成"先取图后 claim":图卡 fetch 失败时零副作用返回,
// 周一剩余时段的每个 tick 都会重试;claim 之后才可能发生的失败走与
// xBroadcast 相同的永久/瞬态分叉。
import type { DB } from "./db";
import type { XClient } from "./xPublisher";
import { isPermanentXError } from "./xPublisher";
import { composeWeeklyPost, strategyEn } from "./xComposer";
import { costOf, quotaDecision } from "./xQuota";
import { utcWeekStart } from "./followAnalysis";

const WEEK_SEC = 7 * 86400;
// 周一 13:00 UTC ≈ 美东早 9 点/欧洲下午 —— 英文受众的高峰时段前沿。
export const WEEKLY_POST_UTC_HOUR = 13;

export interface WeeklyRow {
  name: string;
  nameEn: string;
  settled: number;
  pnlUsd: number;
  roiPct: number | null;
}

export interface WeeklyReport {
  weekLabel: string;
  settled: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  pnlUsd: number;
  rows: WeeklyRow[];
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function dayLabel(sec: number): string {
  const d = new Date(sec * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * 近 7 天已结算仓位按策略聚合。胜率口径与全站一致:realized_pnl===0 视作
 * 平局(push),不进胜率分母;ROI = pnl / 投入本金(size_usd 合计)。
 */
export function buildWeeklyReport(db: DB, nowSec: number): WeeklyReport {
  const from = nowSec - WEEK_SEC;
  const rows = db
    .prepare(
      `SELECT s.name AS name,
              COUNT(*) AS n,
              SUM(CASE WHEN p.realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN p.realized_pnl < 0 THEN 1 ELSE 0 END) AS losses,
              COALESCE(SUM(p.realized_pnl), 0) AS pnl,
              COALESCE(SUM(p.size_usd), 0) AS staked
         FROM follow_positions p
         JOIN follow_strategies s ON s.id = p.strategy_id
        WHERE p.status = 'settled' AND p.exit_ts >= ? AND p.exit_ts < ?
        GROUP BY p.strategy_id
        ORDER BY pnl DESC`,
    )
    .all(from, nowSec) as {
    name: string;
    n: number;
    wins: number;
    losses: number;
    pnl: number;
    staked: number;
  }[];
  const settled = rows.reduce((a, r) => a + r.n, 0);
  const wins = rows.reduce((a, r) => a + r.wins, 0);
  const losses = rows.reduce((a, r) => a + r.losses, 0);
  return {
    weekLabel: `${dayLabel(from)}–${dayLabel(nowSec)}`,
    settled,
    wins,
    losses,
    winRatePct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : null,
    pnlUsd: rows.reduce((a, r) => a + r.pnl, 0),
    rows: rows.map((r) => ({
      name: r.name,
      nameEn: strategyEn(r.name),
      settled: r.n,
      pnlUsd: r.pnl,
      roiPct: r.staked > 0 ? (r.pnl / r.staked) * 100 : null,
    })),
  };
}

export interface WeeklyPostDeps {
  db: DB;
  client: XClient;
  /** worker 自取图卡的内网地址(config.xOgOrigin)。 */
  ogOrigin: string;
  publicUrl: string;
  budgetUsd: number;
  /** 发帖时刻覆盖(周一的 UTC 整点,/manage 可配):省略 = 出厂 13:00。 */
  postUtcHour?: number;
  /** 日/周花费上限($,/manage 可配):省略/null = 不限。 */
  dailySpendCapUsd?: number | null;
  weeklySpendCapUsd?: number | null;
  /** 自定义文案模板(/manage 可配):null/省略 = 内置文案。 */
  template?: string | null;
  nowSec?: number;
  fetchImpl?: typeof fetch;
}

/** 周一 ≥13:00 UTC 发一次周报(图卡 + 链接)。返回是否发出。 */
export async function maybeWeeklyPost(d: WeeklyPostDeps): Promise<boolean> {
  const nowSec = d.nowSec ?? Math.floor(Date.now() / 1000);
  const fetchImpl = d.fetchImpl ?? fetch;
  const now = new Date(nowSec * 1000);
  const postHour = d.postUtcHour ?? WEEKLY_POST_UTC_HOUR;
  if (now.getUTCDay() !== 1 || now.getUTCHours() < postHour) {
    return false;
  }
  const dedup = `week:${utcWeekStart(nowSec)}`;
  if (
    d.db
      .prepare("SELECT 1 FROM x_posts WHERE kind = 'weekly' AND dedup_key = ?")
      .get(dedup)
  ) {
    return false;
  }

  const report = buildWeeklyReport(d.db, nowSec);
  // 空周不发:「Settled 0 positions」的成绩单比沉默更伤可信度。
  if (report.settled === 0 || report.rows.length === 0) {
    console.log("[xWeekly] empty week (0 settled) — skipping the report post");
    return false;
  }

  const decision = quotaDecision(d.db, {
    kind: "weekly",
    hasLink: true,
    budgetUsd: d.budgetUsd,
    nowSec,
    dailySpendCapUsd: d.dailySpendCapUsd,
    weeklySpendCapUsd: d.weeklySpendCapUsd,
  });
  if (!decision.ok) {
    console.log(`[xWeekly] quota rejected: ${decision.reason}`);
    return false;
  }

  // 先取图,失败零副作用(见文件头)。
  let png: Buffer;
  try {
    const res = await fetchImpl(`${d.ogOrigin}/api/og/weekly`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`og fetch ${res.status}`);
    png = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.error(
      `[xWeekly] weekly card fetch failed (${d.ogOrigin}/api/og/weekly) — will retry this tick loop:`,
      e,
    );
    return false;
  }

  // rows 按周 PnL 降序,"Best" 取 ROI 最高的档(样本≥1 已由 settled>0 保证)。
  const best = [...report.rows].sort(
    (a, b) => (b.roiPct ?? -Infinity) - (a.roiPct ?? -Infinity),
  )[0];
  const text = composeWeeklyPost({
    weekLabel: report.weekLabel,
    settled: report.settled,
    winRatePct: report.winRatePct,
    pnlUsd: report.pnlUsd,
    bestName: best.name,
    bestRoiPct: best.roiPct ?? 0,
    url: `${d.publicUrl}/follow?utm_source=x`,
    template: d.template,
  });

  const claimed = d.db
    .prepare(
      `INSERT OR IGNORE INTO x_posts (kind, dedup_key, text, has_link, est_cost_usd, status, created_at)
       VALUES ('weekly', ?, ?, 1, ?, 'claimed', ?)`,
    )
    .run(dedup, text, costOf(true), nowSec);
  if (claimed.changes === 0) {
    console.log("[xWeekly] skip: claimed by another process");
    return false;
  }
  const settle = d.db.prepare(
    "UPDATE x_posts SET status = ?, x_post_id = ? WHERE kind = 'weekly' AND dedup_key = ?",
  );
  try {
    const xPostId = await d.client.postWithPng(text, png);
    settle.run("posted", xPostId, dedup);
    console.log(
      `[xWeekly] weekly report posted (${report.weekLabel}, ${report.settled} settled)`,
    );
    return true;
  } catch (e) {
    if (isPermanentXError(e)) {
      settle.run("failed", null, dedup);
      console.error("[xWeekly] permanent post failure — marked failed:", e);
      return false;
    }
    d.db
      .prepare(
        "DELETE FROM x_posts WHERE kind = 'weekly' AND dedup_key = ? AND status = 'claimed'",
      )
      .run(dedup);
    throw e;
  }
}
