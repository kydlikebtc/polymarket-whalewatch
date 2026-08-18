// X 播报消费循环 —— alerts 表即队列。
//
// 架构立场:大单/共识告警已由主链路完整落库(payload 含 Trade+marketCtx /
// 共识组),X 侧做纯消费者,对 runAlertCycle/runConsensusCycle 零改动 ——
// X API 故障与 Telegram 主链路物理隔离,这是设计文档的第一红线。
//
// 每条候选的生命周期(镜像 alertEngine 的 claim-then-send):
//   LEFT JOIN 无台账行 → 配额判定
//     拒 → 记 'skipped'(有行才不会每轮重扫;大单时效性决定跳过即永弃)
//     过 → INSERT OR IGNORE 'claimed'(跨进程抢占锁) → 发帖
//       成功 → 'posted' + x_post_id
//       永久错误(4xx≠429) → 'failed' 保 claim,毒帖不堵队列
//       瞬态(429/5xx/网络) → DELETE claim + rethrow,本轮终止下轮重试
//         (at-least-once;崩溃在 claim 与发帖之间会留下占预算的孤儿 claim,
//         方向是"少发",可接受 —— 见 xQuota 台账口径)
import type { DB } from "./db";
import type { XClient } from "./xPublisher";
import { isPermanentXError } from "./xPublisher";
import {
  composeConsensusPost,
  composeWhalePost,
  type WhalePostInput,
} from "./xComposer";
import { readEventCategories } from "./gamma";
import { costOf, quotaDecision } from "./xQuota";
import { notionalUsd } from "./trades";
import { getSmartTags } from "./smartWallets";

// 新鲜度窗口:宕机重启后不补发陈旧大单(读者视角一条 30 分钟前的大单
// 已是旧闻,补发只烧预算)—— 与引擎 BACKFILL_CAP_SEC 同一哲学。
export const X_POST_MAX_AGE_SEC = 1800;

// 承诺行的时效闸门:xSettled 只补发 7 天内的原帖(SETTLED_MAX_AGE_SEC),
// 留 1 天缓冲 —— 更远的结算写承诺就是可被抓包的空头支票。
export const SETTLE_PROMISE_MAX_H = 144;

export interface XBroadcastDeps {
  db: DB;
  client: XClient;
  budgetUsd: number;
  minTradeUsd: number;
  /**
   * 内容类型开关(/manage 可改)。省略 = 两类都发,保持首版行为 ——
   * 关掉的类型在解析阶段就落 'skipped' 台账行,既不重复扫描也不烧预算。
   *
   * settled 在这里**不是发帖开关**(战报由 xSettled 自己消费),而是承诺行
   * 闸门的输入 —— settled 功能关着时「Result posted at settlement」会落空,
   * 所以不印。
   */
  kinds?: { whale?: boolean; consensus?: boolean; settled?: boolean };
  nowSec?: number;
}

interface AlertRow {
  id: number;
  type: string;
  dedup_key: string;
  payload: string;
  created_at: number;
}

interface Candidate {
  alertId: number;
  kind: "whale" | "consensus";
  text: string;
  usd: number;
}

// 赛道标签的唯一来源:本地 event_category 表(只读,绝不触发上游请求)。
// 早期版本取 marketCtx.category,但 gamma /markets 的 category 字段实测
// 恒为空(本地 745 个市场无一有值)—— 于是 buildTags 的「二级优先」设计
// 从未生效,线上每条帖子都只有 #Polymarket。
function taxonomyOf(db: DB, slug: unknown) {
  if (typeof slug !== "string" || !slug) return {};
  const t = readEventCategories(db, [slug])[slug];
  return {
    category: t?.category ?? null,
    subcategory: t?.subcategory ?? null,
  };
}

// 共识回执管道:payload.wallets = 完整 ConsensusGroup 的钱包数组,零新增
// 查询。容错解析 —— 老告警行没有这个字段,脏项直接滤掉。只取前 3:与模板层
// 同口径(前 3),模板层作为公开纯函数自带防御性截断。
function walletReceipts(raw: unknown) {
  return (Array.isArray(raw) ? raw : [])
    .filter(
      (w): w is Record<string, unknown> => typeof w === "object" && w !== null,
    )
    .map((w) => ({
      netUsd: typeof w.netUsd === "number" ? w.netUsd : NaN,
      avgBuyPrice: typeof w.avgBuyPrice === "number" ? w.avgBuyPrice : NaN,
      winRate: typeof w.winRate === "number" ? w.winRate : null,
    }))
    .filter((w) => Number.isFinite(w.netUsd) && w.avgBuyPrice > 0)
    .slice(0, 3)
    .map((w) => ({
      netUsd: w.netUsd,
      avgPriceCents: Math.round(w.avgBuyPrice * 100),
      winRate: w.winRate,
    }));
}

// 共识告警 → 候选。payload = 完整 ConsensusGroup;老告警行缺的字段
// (均价/回执/时间跨度)传 null/空,模板缺哪段就省哪段。
function parseConsensusCandidate(
  db: DB,
  row: AlertRow,
  p: Record<string, unknown>,
): Candidate | null {
  const walletCount = p.walletCount;
  const outcome = p.outcome;
  const title = p.title;
  const totalUsd = p.totalNetUsd;
  if (
    typeof walletCount !== "number" ||
    typeof outcome !== "string" ||
    typeof title !== "string" ||
    typeof totalUsd !== "number"
  ) {
    return null;
  }
  // 均价:老告警行没有这个字段 → 传 null,模板整段省略而不是显示 0¢。
  const avg = p.avgBuyPrice;
  const spanSec =
    typeof p.firstTs === "number" &&
    typeof p.lastTs === "number" &&
    p.lastTs >= p.firstTs
      ? p.lastTs - p.firstTs
      : null;
  return {
    alertId: row.id,
    kind: "consensus",
    usd: totalUsd,
    text: composeConsensusPost({
      walletCount,
      outcome,
      title,
      totalUsd,
      priceCents:
        typeof avg === "number" && avg > 0 ? Math.round(avg * 100) : null,
      wallets: walletReceipts(p.wallets),
      spanSec,
      ...taxonomyOf(db, p.eventSlug),
    }),
  };
}

// 凭证:仅 type='smart' 查(type='large' 当初就没被判定为聪明钱,此刻回头
// 查会前后不一致)。getSmartTags 是纯本地 SQLite,零上游请求。🏆 是告警
// 时刻的事实(type='smart' 本身):payload 缺 proxyWallet(脏行)或钱包已
// 出池,都只降到「无凭证行」({}),绝不降级成 🐳 匿名大单。
function smartCredential(
  db: DB,
  rowType: string,
  p: Record<string, unknown>,
): WhalePostInput["smart"] {
  if (rowType !== "smart") return null;
  const w = typeof p.proxyWallet === "string" ? p.proxyWallet : null;
  const tag = w ? getSmartTags(db, [w])[w.toLowerCase()] : undefined;
  return tag ? { winRate: tag.winRate, netPnl: tag.netPnl } : {};
}

// alertEngine 富化进 payload 的市场上下文(可能整个缺失)。
interface WhaleMarketCtx {
  impact24h?: number | null;
  liquidity?: number | null;
  hoursToEnd?: number | null;
  category?: string | null;
}

// 大单/聪明钱告警 → 候选。payload = {...Trade, marketCtx?, params}。
function parseWhaleCandidate(
  db: DB,
  row: AlertRow,
  p: Record<string, unknown>,
  minTradeUsd: number,
  settledOn: boolean,
): Candidate | null | "below_floor" {
  const size = p.size;
  const price = p.price;
  const side = p.side;
  const outcome = p.outcome;
  const title = p.title;
  if (
    typeof size !== "number" ||
    typeof price !== "number" ||
    (side !== "BUY" && side !== "SELL") ||
    typeof outcome !== "string" ||
    typeof title !== "string"
  ) {
    return null;
  }
  const usd = notionalUsd({ size, price });
  if (usd < minTradeUsd) return "below_floor";
  const ctx = (p.marketCtx ?? null) as WhaleMarketCtx | null;
  const hoursToEnd = ctx?.hoursToEnd ?? null;
  return {
    alertId: row.id,
    kind: "whale",
    usd,
    text: composeWhalePost({
      usd,
      side,
      outcome,
      title,
      priceCents: Math.round(price * 100),
      // impact24h 是比值(tradeUsd/24h量),模板要的是百分数。
      pct24h: ctx?.impact24h != null ? ctx.impact24h * 100 : null,
      liquidityUsd: ctx?.liquidity ?? null,
      hoursToEnd,
      smart: smartCredential(db, row.type, p),
      // 承诺行双闸门:settled 功能开着 × 结算足够近(否则承诺必然落空)。
      promiseSettled:
        settledOn && hoursToEnd != null && hoursToEnd <= SETTLE_PROMISE_MAX_H,
      // 赛道标签走 event_category(见 taxonomyOf 上方注释);Trade 的
      // eventSlug 缺失时退到 market slug,两者都没有就只出根标签。
      ...taxonomyOf(db, p.eventSlug ?? p.slug),
    }),
  };
}

// 容错解析一行告警 → 候选。返回 null = 结构不可用(记 skipped,原因进日志)。
// settledOn:结算战报功能是否开着(承诺行双闸门之一,见 SETTLE_PROMISE_MAX_H)。
function parseCandidate(
  db: DB,
  row: AlertRow,
  minTradeUsd: number,
  settledOn: boolean,
): Candidate | null | "below_floor" {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  return row.type === "consensus"
    ? parseConsensusCandidate(db, row, p)
    : parseWhaleCandidate(db, row, p, minTradeUsd, settledOn);
}

/**
 * 一轮消费。返回成功发帖数。瞬态发帖错误会 rethrow(调用方 catch 记日志,
 * 下轮自然重试)—— 与 runAlertCycle 的失败语义一致。
 */
export async function runXBroadcastCycle(d: XBroadcastDeps): Promise<number> {
  const nowSec = d.nowSec ?? Math.floor(Date.now() / 1000);
  const rows = d.db
    .prepare(
      `SELECT a.id, a.type, a.dedup_key, a.payload, a.created_at
         FROM alerts a
         LEFT JOIN x_posts x ON x.alert_id = a.id
        WHERE x.id IS NULL
          AND a.type IN ('large','smart','consensus')
          AND a.created_at >= ?
        ORDER BY a.created_at ASC`,
    )
    .all(nowSec - X_POST_MAX_AGE_SEC) as AlertRow[];
  if (rows.length === 0) return 0;

  const skip = d.db.prepare(
    `INSERT OR IGNORE INTO x_posts (kind, dedup_key, alert_id, text, has_link, est_cost_usd, status, created_at)
     VALUES (?, ?, ?, ?, 0, 0, 'skipped', ?)`,
  );
  const claim = d.db.prepare(
    `INSERT OR IGNORE INTO x_posts (kind, dedup_key, alert_id, text, has_link, est_cost_usd, status, created_at)
     VALUES (?, ?, ?, ?, 0, ?, 'claimed', ?)`,
  );
  const settle = d.db.prepare(
    "UPDATE x_posts SET status = ?, x_post_id = ? WHERE kind = ? AND dedup_key = ?",
  );
  const unclaim = d.db.prepare(
    "DELETE FROM x_posts WHERE kind = ? AND dedup_key = ? AND status = 'claimed'",
  );

  // 解析并排序:consensus 独家信号优先,再按金额降序 —— 配额吃紧时大新闻先走。
  const candidates: Candidate[] = [];
  let skipped = 0;
  for (const row of rows) {
    const c = parseCandidate(
      d.db,
      row,
      d.minTradeUsd,
      d.kinds?.settled === true,
    );
    const dedup = `alert:${row.id}`;
    if (c === null) {
      skip.run(
        row.type === "consensus" ? "consensus" : "whale",
        dedup,
        row.id,
        "",
        nowSec,
      );
      skipped++;
      console.warn(
        `[xBroadcast] unparseable alert payload id=${row.id} type=${row.type} — skipped`,
      );
      continue;
    }
    if (c === "below_floor") {
      skip.run("whale", dedup, row.id, "", nowSec);
      skipped++;
      continue;
    }
    // 该类型被运营者关掉:同样落台账(status='skipped'),否则每轮都会
    // 重新解析这批告警,且重新开启后会突然补发一堆旧内容。
    if (d.kinds && d.kinds[c.kind] === false) {
      skip.run(c.kind, dedup, row.id, "", nowSec);
      skipped++;
      continue;
    }
    candidates.push(c);
  }
  candidates.sort((a, b) =>
    a.kind === b.kind ? b.usd - a.usd : a.kind === "consensus" ? -1 : 1,
  );

  let posted = 0;
  for (const c of candidates) {
    const dedup = `alert:${c.alertId}`;
    const decision = quotaDecision(d.db, {
      kind: c.kind,
      hasLink: false,
      budgetUsd: d.budgetUsd,
      nowSec,
    });
    if (!decision.ok) {
      skip.run(c.kind, dedup, c.alertId, c.text, nowSec);
      skipped++;
      console.log(
        `[xBroadcast] quota rejected alert=${c.alertId} kind=${c.kind}: ${decision.reason}`,
      );
      continue;
    }
    if (
      claim.run(c.kind, dedup, c.alertId, c.text, costOf(false), nowSec)
        .changes === 0
    ) {
      console.log(
        `[xBroadcast] skip alert=${c.alertId}: claimed by another process`,
      );
      continue;
    }
    try {
      const xPostId = await d.client.postText(c.text);
      settle.run("posted", xPostId, c.kind, dedup);
      posted++;
    } catch (e) {
      if (isPermanentXError(e)) {
        settle.run("failed", null, c.kind, dedup);
        console.error(
          `[xBroadcast] permanent post failure alert=${c.alertId} — marked failed, queue moves on:`,
          e,
        );
      } else {
        unclaim.run(c.kind, dedup);
        throw e;
      }
    }
  }
  if (posted > 0 || skipped > 0) {
    console.log(
      `[xBroadcast] cycle: posted ${posted}, skipped ${skipped} (candidates ${candidates.length})`,
    );
  }
  return posted;
}
