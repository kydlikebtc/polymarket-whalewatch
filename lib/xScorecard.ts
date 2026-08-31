// 每日战报榜 —— 把一天的结算战果聚成一条**主帖**。
//
// 为什么单独一类(2026-08-31 线上实测的教训):
// 结算战报(lib/xSettled)走 self-reply,17 条合计只有 13 次浏览 —— 自回复
// 在 X 上没有独立分发,「赢输都报」这个账号简介里写着的卖点因此对时间线
// 完全不可见。两层分工:
//   · self-reply = **凭证层**。挂在原帖下,任何人点开 thread 都能对账。
//   · 本模块   = **分发层**。一天一条主帖,让那份记录被看见。
// 不是二选一 —— 去掉凭证层这条主帖就成了无法核验的自吹。
//
// 模式照抄 xPulse/xWeekly:时刻闸 → 数据就绪闸 → 台账 dedup → 配额 →
// claim/post/settle,永久/瞬态错误分叉逐字一致。
//
// 两条纪律:
//  · **只发昨天(完整 UTC 日)**。当天还在结算,半张卡不如不发;
//    alert_outcomes 的回填也有滞后,昨日这个窗口给足了缓冲。
//  · **0 结算的日子静默**。「0 settled」的成绩单比沉默更伤可信度
//    (与 xWeekly 空周不发同一条)。
import type { DB } from "./db";
import type { XClient } from "./xPublisher";
import { isPermanentXError } from "./xPublisher";
import {
  composeScorecardPost,
  utcDayLabel,
  type ScorecardRow,
} from "./xComposer";
import { costOf, quotaDecision } from "./xQuota";

// 14:00 UTC ≈ 美东早 10 点/欧洲下午 —— 与周报/日榜同一受众高峰哲学。
// /manage 可配(lib/xParams)。
export const SCORECARD_POST_UTC_HOUR = 14;

export interface ScorecardCycleDeps {
  db: DB;
  client: XClient;
  budgetUsd: number;
  /** 发帖时刻(每日 UTC 整点):省略 = 出厂 14:00。 */
  postUtcHour?: number;
  /** 日/周花费上限($):省略/null = 不限。 */
  dailySpendCapUsd?: number | null;
  weeklySpendCapUsd?: number | null;
  /** 自定义文案模板(/manage 可配):null/省略 = 内置文案。 */
  template?: string | null;
  nowSec?: number;
}

interface SettledRow {
  alert_id: number;
  kind: string;
  payload: string;
  won: number;
}

/**
 * 名义回报(%)—— 口径必须与 self-reply 那条(composeSettlementPost)**逐字
 * 同源**:同一笔在 thread 里和在日报榜上出现两个数字,读者一对照就穿帮。
 *
 * 因此这里照抄那边的三条:
 *   · 只有买入方向的赢单才有回报率(卖方是空头,预测市场没有统一的保证金
 *     基准 —— 与其编一个,不如不给);
 *   · 输单不给("-100%" 是废话,❌ 已经说尽);
 *   · 入场价越界(≤0 或 >100¢)按缺失处理。
 */
function nominalRoiPct(
  won: boolean,
  side: string | undefined,
  entryCents: number | null,
): number | null {
  if (!won || side === "SELL") return null;
  if (entryCents == null || !Number.isFinite(entryCents)) return null;
  if (entryCents <= 0 || entryCents > 100) return null;
  return Math.round((100 / entryCents - 1) * 100);
}

/**
 * 代表行选取:**先保证有输有赢**,再论幅度。
 *
 * 按幅度排序会让赢单天然霸榜(输单没有回报率),而一张只列赢单的卡正是
 * 「No screenshots. Just the record.」当场破产的样子。所以赢/输两列各自
 * 排好后交替取 —— 只要那天有输单,卡上一定看得见。
 */
export function pickScorecardRows(rows: ScorecardRow[]): ScorecardRow[] {
  const wins = rows
    .filter((r) => r.won)
    .sort((a, b) => (b.roiPct ?? -1) - (a.roiPct ?? -1));
  const losses = rows.filter((r) => !r.won);
  const out: ScorecardRow[] = [];
  for (let i = 0; i < Math.max(wins.length, losses.length); i++) {
    if (wins[i]) out.push(wins[i]);
    if (losses[i]) out.push(losses[i]);
  }
  return out;
}

/** 每日一次:到点后发昨天那张卡。返回是否发出。 */
export async function runScorecardCycle(
  d: ScorecardCycleDeps,
): Promise<boolean> {
  const nowSec = d.nowSec ?? Math.floor(Date.now() / 1000);
  const postHour = d.postUtcHour ?? SCORECARD_POST_UTC_HOUR;
  if (new Date(nowSec * 1000).getUTCHours() < postHour) return false;

  const todayStart = Math.floor(nowSec / 86400) * 86400;
  const dayStart = todayStart - 86400;
  const dedup = `card:${dayStart}`;
  if (
    d.db
      .prepare(
        "SELECT 1 FROM x_posts WHERE kind = 'scorecard' AND dedup_key = ?",
      )
      .get(dedup)
  ) {
    return false;
  }

  // 已发过的信号帖 × 昨日观测到的结算。checked_at 是验证闭环回填的时刻,
  // 也是我们唯一能诚实声称"这天结算了"的时间戳。
  const rows = d.db
    .prepare(
      `SELECT x.alert_id, x.kind, a.payload, o.won
         FROM x_posts x
         JOIN alerts a          ON a.id = x.alert_id
         JOIN alert_outcomes o  ON o.alert_id = x.alert_id
        WHERE x.status = 'posted'
          AND x.kind IN ('whale','consensus')
          AND o.resolved = 1
          AND o.won IS NOT NULL
          AND o.checked_at >= ? AND o.checked_at < ?
        ORDER BY o.checked_at ASC`,
    )
    .all(dayStart, dayStart + 86400) as SettledRow[];
  if (rows.length === 0) {
    console.log(
      `[xScorecard] no settlements on ${utcDayLabel(new Date(dayStart * 1000).toISOString().slice(0, 10))} — staying silent`,
    );
    return false;
  }

  const parsed: ScorecardRow[] = [];
  for (const r of rows) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      // payload 坏了只丢这一行的**展示**;它仍计入 settled/wins 统计,
      // 否则「12 settled」会因为一条脏行悄悄变成 11。
      continue;
    }
    const title = typeof p.title === "string" ? p.title : null;
    if (!title) continue;
    // 入场价:大单取成交价,共识取聚钱加权均价 —— 与原帖公布的那个价格
    // 严格一致(与 xSettled 同一口径)。
    const raw = r.kind === "consensus" ? p.avgBuyPrice : p.price;
    const entryCents =
      typeof raw === "number" && raw > 0 && raw < 1
        ? Math.round(raw * 100)
        : null;
    parsed.push({
      won: r.won === 1,
      title,
      roiPct: nominalRoiPct(
        r.won === 1,
        r.kind === "consensus" ? "BUY" : (p.side as string | undefined),
        entryCents,
      ),
    });
  }

  const settled = rows.length;
  const wins = rows.filter((r) => r.won === 1).length;
  const text = composeScorecardPost({
    dayLabel: utcDayLabel(new Date(dayStart * 1000).toISOString().slice(0, 10)),
    settled,
    wins,
    rows: pickScorecardRows(parsed),
    template: d.template,
  });

  const decision = quotaDecision(d.db, {
    kind: "scorecard",
    hasLink: false,
    budgetUsd: d.budgetUsd,
    nowSec,
    dailySpendCapUsd: d.dailySpendCapUsd,
    weeklySpendCapUsd: d.weeklySpendCapUsd,
  });
  if (!decision.ok) {
    console.log(`[xScorecard] quota rejected: ${decision.reason}`);
    return false;
  }

  const claimed = d.db
    .prepare(
      `INSERT OR IGNORE INTO x_posts (kind, dedup_key, text, has_link, est_cost_usd, status, created_at)
       VALUES ('scorecard', ?, ?, 0, ?, 'claimed', ?)`,
    )
    .run(dedup, text, costOf(false), nowSec);
  if (claimed.changes === 0) {
    console.log("[xScorecard] skip: claimed by another process");
    return false;
  }
  const settle = d.db.prepare(
    "UPDATE x_posts SET status = ?, x_post_id = ? WHERE kind = 'scorecard' AND dedup_key = ?",
  );
  try {
    const xPostId = await d.client.postText(text);
    settle.run("posted", xPostId, dedup);
    console.log(
      `[xScorecard] daily card posted (${dedup}, ${wins}/${settled} hit)`,
    );
    return true;
  } catch (e) {
    if (isPermanentXError(e)) {
      settle.run("failed", null, dedup);
      console.error("[xScorecard] permanent post failure — marked failed:", e);
      return false;
    }
    d.db
      .prepare(
        "DELETE FROM x_posts WHERE kind = 'scorecard' AND dedup_key = ? AND status = 'claimed'",
      )
      .run(dedup);
    throw e;
  }
}
