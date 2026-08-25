// 赛前聚合帖 —— 结算窗口内高热市场的聪明钱站位汇总。
//
// 事件峰值流量打法:大赛事/热点市场在结算前几小时是搜索与讨论峰值,
// 这时发一条"过去 24h 聪明钱在这个市场干了什么"的聚合帖,蹭的是读者
// 已经在找的话题。数据全部来自 alerts 表(近 24h)+ gamma 缓存 meta,
// 零新增上游调用。
//
// 与 whale 帖不同的跳过语义:quota 拒绝(日 cap/预算)时不落台账行 ——
// 落 skipped 会让该市场当日永久出局,而 cap 是"今天最多 N 条"不是
// "这 N 个市场以外都不配发";10 分钟后重试的成本只是一次内存聚合。
import type { DB } from "./db";
import type { MarketMeta } from "./gamma";
import { readEventCategories } from "./gamma";
import type { XClient } from "./xPublisher";
import { isPermanentXError } from "./xPublisher";
import { composePregamePost } from "./xComposer";
import { costOf, quotaDecision } from "./xQuota";
import { notionalUsd } from "./trades";

export const PREGAME_MIN_H = 1;
export const PREGAME_MAX_H = 6;
export const PREGAME_LOOKBACK_SEC = 86400;
// 单轮上限(日 cap 3 之下的再保险:一轮最多考虑前 3 名,避免一个体育大日
// 把 10 个市场全试一遍配额)。
export const PREGAME_PER_CYCLE = 3;

export interface PregameDeps {
  db: DB;
  client: XClient;
  getMeta: (cids: string[]) => Promise<Record<string, MarketMeta>>;
  budgetUsd: number;
  /** 日上限覆盖(/manage 可配):省略 = 出厂 DAILY_CAP.pregame(3);null = 不限。 */
  dailyCap?: number | null;
  /** 结算窗口覆盖(小时,/manage 可配):省略 = 出厂 PREGAME_MIN_H..MAX_H(1-6)。 */
  minH?: number;
  maxH?: number;
  /** 日/周花费上限($,/manage 可配):省略/null = 不限。 */
  dailySpendCapUsd?: number | null;
  weeklySpendCapUsd?: number | null;
  /** 自定义文案模板(/manage 可配):null/省略 = 内置文案。 */
  template?: string | null;
  nowSec?: number;
}

interface MarketAgg {
  conditionId: string;
  title: string;
  alertCount: number;
  totalUsd: number;
  buyUsdByOutcome: Map<string, number>;
  /**
   * 取自首条告警 payload —— 话题标签要靠它查 event_category。
   * MarketMeta 上没有这个字段(且其 category 实测恒为空),而告警 payload
   * 本来就带着,零额外成本。
   */
  eventSlug: string | null;
}

// 近 24h 告警按市场聚合(JS 侧聚合:payload 是 JSON,SQL 内算金额既慢又脆;
// 量级是"24h 内的告警数",内存聚合毫秒级)。
function aggregateRecentAlerts(db: DB, nowSec: number): Map<string, MarketAgg> {
  const rows = db
    .prepare(
      `SELECT type, payload FROM alerts
        WHERE type IN ('large','smart','consensus') AND created_at >= ?`,
    )
    .all(nowSec - PREGAME_LOOKBACK_SEC) as { type: string; payload: string }[];
  const byCid = new Map<string, MarketAgg>();
  for (const r of rows) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const cid = p.conditionId;
    const title = p.title;
    if (typeof cid !== "string" || typeof title !== "string") continue;
    let agg = byCid.get(cid);
    if (!agg) {
      agg = {
        conditionId: cid,
        title,
        alertCount: 0,
        totalUsd: 0,
        buyUsdByOutcome: new Map(),
        eventSlug:
          typeof p.eventSlug === "string" && p.eventSlug
            ? p.eventSlug
            : typeof p.slug === "string" && p.slug
              ? p.slug
              : null,
      };
      byCid.set(cid, agg);
    }
    if (r.type === "consensus") {
      const usd = typeof p.totalNetUsd === "number" ? p.totalNetUsd : 0;
      const outcome = typeof p.outcome === "string" ? p.outcome : null;
      agg.alertCount++;
      agg.totalUsd += usd;
      if (outcome) {
        agg.buyUsdByOutcome.set(
          outcome,
          (agg.buyUsdByOutcome.get(outcome) ?? 0) + usd,
        );
      }
    } else {
      const size = p.size;
      const price = p.price;
      if (typeof size !== "number" || typeof price !== "number") continue;
      const usd = notionalUsd({ size, price });
      agg.alertCount++;
      agg.totalUsd += usd;
      // SELL 是离场,计入热度但不计入"站哪边"。
      if (p.side === "BUY" && typeof p.outcome === "string") {
        agg.buyUsdByOutcome.set(
          p.outcome,
          (agg.buyUsdByOutcome.get(p.outcome) ?? 0) + usd,
        );
      }
    }
  }
  return byCid;
}

function utcDay(nowSec: number): number {
  return Math.floor(nowSec / 86400);
}

/** 一轮赛前扫描。返回成功发帖数;瞬态发帖错误 rethrow(下轮重试)。 */
export async function runPregameCycle(d: PregameDeps): Promise<number> {
  const nowSec = d.nowSec ?? Math.floor(Date.now() / 1000);
  const minH = d.minH ?? PREGAME_MIN_H;
  const maxH = d.maxH ?? PREGAME_MAX_H;
  const byCid = aggregateRecentAlerts(d.db, nowSec);
  if (byCid.size === 0) return 0;

  const metas = await d.getMeta([...byCid.keys()]);
  const candidates: (MarketAgg & { hoursToEnd: number; meta: MarketMeta })[] =
    [];
  for (const agg of byCid.values()) {
    const meta = metas[agg.conditionId];
    if (!meta || meta.closed || !meta.endDate) continue;
    const endMs = Date.parse(meta.endDate);
    if (!Number.isFinite(endMs)) continue;
    const hoursToEnd = (endMs / 1000 - nowSec) / 3600;
    if (hoursToEnd < minH || hoursToEnd > maxH) continue;
    candidates.push({ ...agg, hoursToEnd, meta });
  }
  candidates.sort(
    (a, b) => b.alertCount - a.alertCount || b.totalUsd - a.totalUsd,
  );

  const exists = d.db.prepare(
    "SELECT 1 FROM x_posts WHERE kind = 'pregame' AND dedup_key = ?",
  );
  const claim = d.db.prepare(
    `INSERT OR IGNORE INTO x_posts (kind, dedup_key, text, has_link, est_cost_usd, status, created_at)
     VALUES ('pregame', ?, ?, 0, ?, 'claimed', ?)`,
  );
  const settle = d.db.prepare(
    "UPDATE x_posts SET status = ?, x_post_id = ? WHERE kind = 'pregame' AND dedup_key = ?",
  );
  const unclaim = d.db.prepare(
    "DELETE FROM x_posts WHERE kind = 'pregame' AND dedup_key = ? AND status = 'claimed'",
  );

  let posted = 0;
  for (const c of candidates.slice(0, PREGAME_PER_CYCLE)) {
    const dedup = `${c.conditionId}:${utcDay(nowSec)}`;
    if (exists.get(dedup)) continue; // 今日已发过这个市场

    const decision = quotaDecision(d.db, {
      kind: "pregame",
      hasLink: false,
      budgetUsd: d.budgetUsd,
      nowSec,
      dailyCap: d.dailyCap,
      dailySpendCapUsd: d.dailySpendCapUsd,
      weeklySpendCapUsd: d.weeklySpendCapUsd,
    });
    if (!decision.ok) {
      // 不落行:cap/预算是全局闸,不是这个市场的罪(见文件头)。
      console.log(
        `[xPregame] quota rejected ${c.conditionId}: ${decision.reason}`,
      );
      continue;
    }

    // 双边站位:BUY 金额降序取前两名 —— composer 的三种局面(X-to-1 /
    // every-signal / SPLIT)全由这两个数字决定。SELL 在聚合层就不进
    // buyUsdByOutcome(离场≠站边),这里只做纯排序。
    const sides = [...c.buyUsdByOutcome.entries()]
      .map(([name, usd]) => ({ name, usd }))
      .filter((s) => s.usd > 0)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 2);
    let topSidePriceCents: number | null = null;
    if (sides.length > 0) {
      const idx = c.meta.outcomes.indexOf(sides[0].name);
      const price = idx >= 0 ? c.meta.outcomePrices[idx] : undefined;
      if (typeof price === "number" && Number.isFinite(price)) {
        topSidePriceCents = Math.round(price * 100);
      }
    }
    // 只读本地分类:拿不到就不加标签,绝不为它打一次 gamma。
    const t = c.eventSlug
      ? readEventCategories(d.db, [c.eventSlug])[c.eventSlug]
      : undefined;
    const taxonomy = {
      category: t?.category ?? null,
      subcategory: t?.subcategory ?? null,
    };
    const text = composePregamePost({
      title: c.title,
      hoursToEnd: c.hoursToEnd,
      alertCount: c.alertCount,
      sides,
      topSidePriceCents,
      template: d.template,
      // 赛道标签走本地 event_category(只读,零上游请求)。原先取
      // meta.category,但 gamma 的该字段实测恒为空(745/745),标签因此
      // 一直只有根标签 —— 与 xBroadcast 同一处修复。
      ...taxonomy,
    });

    if (claim.run(dedup, text, costOf(false), nowSec).changes === 0) {
      console.log(
        `[xPregame] skip ${c.conditionId}: claimed by another process`,
      );
      continue;
    }
    try {
      const xPostId = await d.client.postText(text);
      settle.run("posted", xPostId, dedup);
      posted++;
      console.log(
        `[xPregame] posted ${c.conditionId} (${c.alertCount} alerts / $${Math.round(c.totalUsd)} / T-${c.hoursToEnd.toFixed(1)}h)`,
      );
    } catch (e) {
      if (isPermanentXError(e)) {
        settle.run("failed", null, dedup);
        console.error(`[xPregame] permanent post failure ${c.conditionId}:`, e);
      } else {
        unclaim.run(dedup);
        throw e;
      }
    }
  }
  return posted;
}
