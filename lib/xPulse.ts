// 市场脉搏日帖(日榜 + 分歧)—— 内容引擎的 X 出口,时间驱动,模式照抄
// xWeekly:时刻闸 → 数据就绪闸 → 台账 dedup → 配额 → claim/post/settle。
//
// 与 /pulse 页同源同口径(buildPulse,零上游):帖子只是页面头名的推文形态。
// 两条纪律:
//  · 数据就绪闸:只发「昨天」—— buildPulse().latestDay 必须恰好是昨日。
//    聚合迟到就等下一 tick;漏了一天(latestDay 更旧)则永不补发旧闻。
//  · 无分歧的日子静默:分歧线天然稀疏,「今天没有」是事实不是故障。
import type { DB } from "./db";
import type { XClient } from "./xPublisher";
import { isPermanentXError } from "./xPublisher";
import { buildPulse } from "./marketPulse";
import { composeDivergencePost, composePulsePost } from "./xComposer";
import { costOf, quotaDecision } from "./xQuota";

// 14:00 UTC ≈ 美东早 10 点/欧洲下午 —— 与周报同一受众高峰哲学;数据凌晨
// 就绪后压到这个时刻发,不在时间线死区烧预算。/manage 可配(lib/xParams)。
export const PULSE_POST_UTC_HOUR = 14;

export interface PulseCycleDeps {
  db: DB;
  client: XClient;
  budgetUsd: number;
  /** 两类各自的开关(/manage,默认全关)。 */
  kinds: { pulse: boolean; divergence: boolean };
  /** 发帖时刻(每日 UTC 整点):省略 = 出厂 14:00。 */
  postUtcHour?: number;
  /** 日/周花费上限($):省略/null = 不限。 */
  dailySpendCapUsd?: number | null;
  weeklySpendCapUsd?: number | null;
  /** 自定义文案模板:null/省略 = 内置文案。 */
  templates?: { pulse?: string | null; divergence?: string | null };
  nowSec?: number;
}

function utcDayStr(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

/** 单帖发布(claim → post → settle),失败语义与 xWeekly 逐字一致。 */
async function postOnce(
  d: PulseCycleDeps,
  kind: "pulse" | "divergence",
  dedup: string,
  text: string,
  nowSec: number,
): Promise<boolean> {
  const decision = quotaDecision(d.db, {
    kind,
    hasLink: false,
    budgetUsd: d.budgetUsd,
    nowSec,
    dailySpendCapUsd: d.dailySpendCapUsd,
    weeklySpendCapUsd: d.weeklySpendCapUsd,
  });
  if (!decision.ok) {
    console.log(`[xPulse] quota rejected ${kind}: ${decision.reason}`);
    return false;
  }
  const claimed = d.db
    .prepare(
      `INSERT OR IGNORE INTO x_posts (kind, dedup_key, text, has_link, est_cost_usd, status, created_at)
       VALUES (?, ?, ?, 0, ?, 'claimed', ?)`,
    )
    .run(kind, dedup, text, costOf(false), nowSec);
  if (claimed.changes === 0) {
    console.log(`[xPulse] skip ${kind}: claimed by another process`);
    return false;
  }
  const settle = d.db.prepare(
    "UPDATE x_posts SET status = ?, x_post_id = ? WHERE kind = ? AND dedup_key = ?",
  );
  try {
    const xPostId = await d.client.postText(text);
    settle.run("posted", xPostId, kind, dedup);
    console.log(`[xPulse] ${kind} posted (${dedup})`);
    return true;
  } catch (e) {
    if (isPermanentXError(e)) {
      settle.run("failed", null, kind, dedup);
      console.error(`[xPulse] permanent ${kind} failure — marked failed:`, e);
      return false;
    }
    d.db
      .prepare(
        "DELETE FROM x_posts WHERE kind = ? AND dedup_key = ? AND status = 'claimed'",
      )
      .run(kind, dedup);
    throw e;
  }
}

/**
 * 每日至多各一帖(日榜/分歧)。返回本轮发出的帖数。
 * 瞬态发帖错误 rethrow(调用方 catch 记日志,下轮自然重试)。
 */
export async function runPulseCycle(d: PulseCycleDeps): Promise<number> {
  if (!d.kinds.pulse && !d.kinds.divergence) return 0;
  const nowSec = d.nowSec ?? Math.floor(Date.now() / 1000);
  const postHour = d.postUtcHour ?? PULSE_POST_UTC_HOUR;
  if (new Date(nowSec * 1000).getUTCHours() < postHour) return 0;

  const yesterday = utcDayStr(nowSec - 86_400);
  // dedup 先查再算:buildPulse 虽然便宜,也不该每分钟白算一遍。
  const already = (kind: string) =>
    d.db
      .prepare("SELECT 1 FROM x_posts WHERE kind = ? AND dedup_key = ?")
      .get(kind, `${kind}:${yesterday}`) != null;
  const wantPulse = d.kinds.pulse && !already("pulse");
  const wantDivergence = d.kinds.divergence && !already("divergence");
  if (!wantPulse && !wantDivergence) return 0;

  const report = buildPulse(d.db);
  // 数据就绪闸:只发昨天。聚合迟到就等下一 tick;更旧的日子永不补发。
  if (report.latestDay !== yesterday) {
    return 0;
  }

  let posted = 0;
  if (wantPulse && report.top.length > 0) {
    const top = report.top[0];
    const text = composePulsePost({
      day: report.latestDay,
      title: top.title ?? top.conditionId,
      score: top.score,
      volRatio: top.volRatio,
      oneSidedPct: top.components.oneSided * 100,
      whaleSharePct: top.components.whaleShare * 100,
      runners: report.top
        .slice(1, 3)
        .map((r) => ({ title: r.title ?? r.conditionId, score: r.score })),
      category: top.category,
      subcategory: top.subcategory,
      template: d.templates?.pulse,
    });
    if (await postOnce(d, "pulse", `pulse:${yesterday}`, text, nowSec)) {
      posted++;
    }
  }
  if (wantDivergence && report.divergences.length > 0) {
    const top = report.divergences[0];
    const text = composeDivergencePost({
      title: top.title ?? top.conditionId,
      smallOutcome: top.smallTopOutcome,
      smallNetUsd: top.smallNetUsd,
      whaleOutcome: top.whaleTopOutcome,
      whaleNetUsd: top.whaleNetUsd,
      category: top.category,
      subcategory: top.subcategory,
      template: d.templates?.divergence,
    });
    if (
      await postOnce(d, "divergence", `divergence:${yesterday}`, text, nowSec)
    ) {
      posted++;
    }
  }
  return posted;
}
