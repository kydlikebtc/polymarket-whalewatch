// 结算战报循环 —— 对已经发过的信号帖,在其结算后 self-reply 补上结果。
//
// 为什么值得单独一类:大单播报是"人人都能做"的(成交数据公开),而"给自己
// 发过的每一条信号打分"是这个项目独有的能力(验证闭环已经在算 1h/24h 跟随
// 与最终结算)。一条 thread 里「3 天前说了什么 → 后来怎样」比任何自我宣传
// 都有说服力,而且它是原创内容、不涉及任何第三方账号。
//
// 红线(与 X 自动化规则对齐):
//   · **只回复自己的帖**。X 明令禁止「自动化 @/回复以触达未主动请求的
//     用户」,违者帖子被移出搜索甚至封号;而且 @ 别人根本不会把帖子推进
//     对方粉丝流 —— 违规且无效。这里的 in_reply_to 永远取 x_posts 里
//     自己发过的 post id。
//   · **赢输都发**。只发赢的是 cherry-picking,读者一对照原帖就露馅。
//   · 默认关(见 xSettings DEFAULT_X_KINDS)—— 新能力不该在运营者不知情时
//     就开始往时间线上发东西。
//
// 数据来源全部是本地表:x_posts(发过什么) × alerts(信号内容) ×
// alert_outcomes(验证闭环回填的结算结果)。零新增上游请求。
import type { DB } from "./db";
import type { XClient } from "./xPublisher";
import { isPermanentXError } from "./xPublisher";
import { composeSettlementPost } from "./xComposer";
import { readEventCategories } from "./gamma";
import { costOf, quotaDecision } from "./xQuota";

/**
 * 战报的时效窗口:原帖太老就不再补了。
 *
 * 一条两周前的信号现在才报结果,读者早已刷过去,thread 也不会再被翻出来;
 * 而每条战报都要花 $0.015。7 天是"还记得这回事"与"预算别浪费"的折中。
 */
export const SETTLED_MAX_AGE_SEC = 7 * 86400;

/** 单轮上限:避免积压的历史信号在开关刚打开时一次性刷屏。 */
export const SETTLED_PER_CYCLE = 3;

export interface XSettledDeps {
  db: DB;
  client: XClient;
  budgetUsd: number;
  /** 日上限覆盖(/manage 可配):省略 = 出厂 DAILY_CAP.settled(5);null = 不限。 */
  dailyCap?: number | null;
  /** 日/周花费上限($,/manage 可配):省略/null = 不限。 */
  dailySpendCapUsd?: number | null;
  weeklySpendCapUsd?: number | null;
  /** 自定义文案模板(/manage 可配):null/省略 = 内置文案。 */
  template?: string | null;
  nowSec?: number;
}

interface Row {
  alert_id: number;
  x_post_id: string;
  kind: string;
  payload: string;
  won: number;
  posted_at: number;
}

/** 一轮结算战报。返回成功发帖数;瞬态错误 rethrow(下轮重试)。 */
export async function runSettledCycle(d: XSettledDeps): Promise<number> {
  const nowSec = d.nowSec ?? Math.floor(Date.now() / 1000);
  // 已发过的信号帖 × 已结算 × 尚未发过战报。LEFT JOIN 自身表做"未回过"
  // 判定,与 xBroadcast 的台账语义一致。
  const rows = d.db
    .prepare(
      `SELECT x.alert_id, x.x_post_id, x.kind, a.payload, o.won, x.created_at AS posted_at
         FROM x_posts x
         JOIN alerts a          ON a.id = x.alert_id
         JOIN alert_outcomes o  ON o.alert_id = x.alert_id
         LEFT JOIN x_posts s    ON s.kind = 'settled' AND s.dedup_key = 'settled:' || x.alert_id
        WHERE x.status = 'posted'
          AND x.kind IN ('whale','consensus')
          AND x.x_post_id IS NOT NULL
          AND o.resolved = 1
          AND o.won IS NOT NULL
          AND s.id IS NULL
          AND x.created_at >= ?
        ORDER BY x.created_at DESC`,
    )
    .all(nowSec - SETTLED_MAX_AGE_SEC) as Row[];
  if (rows.length === 0) return 0;

  const skip = d.db.prepare(
    `INSERT OR IGNORE INTO x_posts (kind, dedup_key, alert_id, text, has_link, est_cost_usd, status, created_at)
     VALUES ('settled', ?, ?, ?, 0, 0, 'skipped', ?)`,
  );
  const claim = d.db.prepare(
    `INSERT OR IGNORE INTO x_posts (kind, dedup_key, alert_id, text, has_link, est_cost_usd, status, created_at)
     VALUES ('settled', ?, ?, ?, 0, ?, 'claimed', ?)`,
  );
  const settle = d.db.prepare(
    "UPDATE x_posts SET status = ?, x_post_id = ? WHERE kind = 'settled' AND dedup_key = ?",
  );
  const unclaim = d.db.prepare(
    "DELETE FROM x_posts WHERE kind = 'settled' AND dedup_key = ? AND status = 'claimed'",
  );

  let posted = 0;
  for (const r of rows.slice(0, SETTLED_PER_CYCLE)) {
    const dedup = `settled:${r.alert_id}`;
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      // 原帖 payload 坏了 → 落 skipped,别每轮重扫。
      skip.run(dedup, r.alert_id, "", nowSec);
      continue;
    }
    const outcome = typeof p.outcome === "string" ? p.outcome : null;
    const title = typeof p.title === "string" ? p.title : null;
    if (!outcome || !title) {
      skip.run(dedup, r.alert_id, "", nowSec);
      continue;
    }
    // 入场价:大单取成交价,共识取聚钱加权均价 —— 与各自原帖里公布的
    // 那个价格严格一致,否则读者对照 thread 会发现两个数对不上。
    const raw = r.kind === "consensus" ? p.avgBuyPrice : p.price;
    const entryCents =
      typeof raw === "number" && raw > 0 && raw < 1
        ? Math.round(raw * 100)
        : null;
    const slug = p.eventSlug ?? p.slug;
    const t =
      typeof slug === "string" && slug
        ? readEventCategories(d.db, [slug])[slug]
        : undefined;

    const text = composeSettlementPost({
      title,
      outcome,
      entryCents,
      // 共识组恒为买入方向;大单看 payload 的 side。方向传错会把「卖对了」
      // 写成「买赢了」(见 composeSettlementPost 注释)。
      side: r.kind === "consensus" ? "BUY" : p.side === "SELL" ? "SELL" : "BUY",
      won: r.won === 1,
      // r.kind 是 string,但 SQL WHERE 已限定 IN ('whale','consensus') ——
      // 三元只是类型收窄,不是业务分支。
      signalKind: r.kind === "consensus" ? "consensus" : "whale",
      // posted_at = 原帖 x_posts.created_at(SELECT 里本就带出,白拿)。
      postedAgoSec: nowSec - r.posted_at,
      category: t?.category ?? null,
      subcategory: t?.subcategory ?? null,
      template: d.template,
    });

    const decision = quotaDecision(d.db, {
      kind: "settled",
      hasLink: false,
      budgetUsd: d.budgetUsd,
      nowSec,
      dailyCap: d.dailyCap,
      dailySpendCapUsd: d.dailySpendCapUsd,
      weeklySpendCapUsd: d.weeklySpendCapUsd,
    });
    if (!decision.ok) {
      // 不落 skipped:配额是全局闸,不是这条信号的罪 —— 明天还该补发
      // (与 xPregame 的 quota 语义一致,区别于 xBroadcast 的时效性丢弃)。
      console.log(
        `[xSettled] quota rejected alert=${r.alert_id}: ${decision.reason}`,
      );
      continue;
    }
    if (
      claim.run(dedup, r.alert_id, text, costOf(false), nowSec).changes === 0
    ) {
      console.log(`[xSettled] skip alert=${r.alert_id}: claimed elsewhere`);
      continue;
    }
    try {
      const id = await d.client.replyText(text, r.x_post_id);
      settle.run("posted", id, dedup);
      posted++;
      console.log(
        `[xSettled] replied to ${r.x_post_id} (alert=${r.alert_id}, won=${r.won === 1})`,
      );
    } catch (e) {
      if (isPermanentXError(e)) {
        // 原帖被删/账号换了都会 4xx —— 标 failed 保住 claim,不再重试。
        settle.run("failed", null, dedup);
        console.error(`[xSettled] permanent failure alert=${r.alert_id}:`, e);
      } else {
        unclaim.run(dedup);
        throw e;
      }
    }
  }
  return posted;
}
