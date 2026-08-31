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

// --- 市场级去重 ------------------------------------------------------------
//
// 为什么不按告警 id 去重(2026-08-31 线上实测的教训):
// @PolyWhaleFeedHQ 14 小时 56 条帖里约两成是近似重复 —— 同一市场 71¢ 上
// 五分钟内发了 $284K/$121K/$107K 三条,文案除金额外逐字相同。X 的重复内容
// 判定不要求逐字一致,模板化近似文本就够;而读者视角这三条本就是同一个
// 事件。去重锚点因此从「告警 id」上移到「市场 + 方向 + 价格档 + 小时桶」。
//
// 为什么是"桶"而不是"滑动窗口":滑窗对持续有大单流的市场会永远压着不发
// (每次检查都落在窗口内);按小时分桶则给出可预期的节奏 —— 同一市场同一
// 方向同一价格档,每小时至多一条。
export const MARKET_DEDUP_BUCKET_SEC = 3600;
// 价格档宽(¢)。71¢ 与 72¢ 对读者是同一个信号;40¢ 与 71¢ 不是。
export const MARKET_DEDUP_PRICE_BAND_CENTS = 5;

export interface MarketDedupInput {
  conditionId: unknown;
  outcome: string;
  /** 成交价/共识均价(¢)。取不到传 null —— 仍按市场+方向去重。 */
  priceCents: number | null;
  /** 大单方向;共识组恒为买入。 */
  side: "BUY" | "SELL";
  nowSec: number;
}

/**
 * 市场级去重键。返回 null = 数据不足以安全归并(payload 没有 conditionId),
 * 调用方退回按告警去重 —— **宁可多发一条,也不能因为脏数据把不相干的两个
 * 市场压成一条**。
 */
export function marketDedupKey(i: MarketDedupInput): string | null {
  if (typeof i.conditionId !== "string" || i.conditionId === "") return null;
  const band =
    i.priceCents != null && Number.isFinite(i.priceCents)
      ? String(Math.round(i.priceCents / MARKET_DEDUP_PRICE_BAND_CENTS))
      : "na";
  const bucket = Math.floor(i.nowSec / MARKET_DEDUP_BUCKET_SEC);
  return `mkt:${i.conditionId}:${i.side}:${i.outcome}:${band}:${bucket}`;
}

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
  /**
   * 日上限覆盖(/manage 可配,lib/xParams):省略 = 出厂默认
   * (whale 20 / consensus 不限,见 xQuota.DAILY_CAP);null = 明确不限。
   */
  whaleDailyCap?: number | null;
  consensusDailyCap?: number | null;
  /** 日/周花费上限($,/manage 可配):省略/null = 不限。 */
  dailySpendCapUsd?: number | null;
  weeklySpendCapUsd?: number | null;
  /** 巨鲸 🚨 抬头分档线覆盖($,/manage 可配)。 */
  whaleSirenUsd?: number;
  /** 自定义文案模板(/manage 可配):null/省略 = 内置文案。 */
  templates?: { whale?: string | null; consensus?: string | null };
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
  /**
   * 台账去重键:市场级(marketDedupKey)优先,数据不足时退 `alert:${id}`。
   * 抢占失败 = 同市场本小时已有帖 或 另一进程先到 —— 两种都该落 skipped。
   */
  dedup: string;
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

// 解析期选项:金额闸 + 承诺行闸门 + 文案参数(全部来自 /manage 可配的
// deps,一次打包传进解析链,免得每加一个参数就改三层签名)。
interface ParseOpts {
  minTradeUsd: number;
  settledOn: boolean;
  sirenUsd?: number;
  whaleTemplate?: string | null;
  consensusTemplate?: string | null;
  /** 市场级去重的小时桶取自本轮时刻(见 marketDedupKey)。 */
  nowSec: number;
}

// 共识告警 → 候选。payload = 完整 ConsensusGroup;老告警行缺的字段
// (均价/回执/时间跨度)传 null/空,模板缺哪段就省哪段。
function parseConsensusCandidate(
  db: DB,
  row: AlertRow,
  p: Record<string, unknown>,
  opts: ParseOpts,
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
  const priceCents =
    typeof avg === "number" && avg > 0 ? Math.round(avg * 100) : null;
  return {
    alertId: row.id,
    kind: "consensus",
    usd: totalUsd,
    // 共识组恒为买入方向(见 xSettled 同款注释)。
    dedup:
      marketDedupKey({
        conditionId: p.conditionId,
        outcome,
        priceCents,
        side: "BUY",
        nowSec: opts.nowSec,
      }) ?? `alert:${row.id}`,
    text: composeConsensusPost({
      walletCount,
      outcome,
      title,
      totalUsd,
      priceCents,
      wallets: walletReceipts(p.wallets),
      spanSec,
      template: opts.consensusTemplate,
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
  opts: ParseOpts,
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
  if (usd < opts.minTradeUsd) return "below_floor";
  const ctx = (p.marketCtx ?? null) as WhaleMarketCtx | null;
  const hoursToEnd = ctx?.hoursToEnd ?? null;
  const priceCents = Math.round(price * 100);
  return {
    alertId: row.id,
    kind: "whale",
    usd,
    dedup:
      marketDedupKey({
        conditionId: p.conditionId,
        outcome,
        priceCents,
        side,
        nowSec: opts.nowSec,
      }) ?? `alert:${row.id}`,
    text: composeWhalePost({
      usd,
      side,
      outcome,
      title,
      priceCents,
      // impact24h 是比值(tradeUsd/24h量),模板要的是百分数。
      pct24h: ctx?.impact24h != null ? ctx.impact24h * 100 : null,
      liquidityUsd: ctx?.liquidity ?? null,
      hoursToEnd,
      smart: smartCredential(db, row.type, p),
      // 承诺行双闸门:settled 功能开着 × 结算足够近(否则承诺必然落空)。
      promiseSettled:
        opts.settledOn &&
        hoursToEnd != null &&
        hoursToEnd <= SETTLE_PROMISE_MAX_H,
      sirenUsd: opts.sirenUsd,
      template: opts.whaleTemplate,
      // 赛道标签走 event_category(见 taxonomyOf 上方注释);Trade 的
      // eventSlug 缺失时退到 market slug,两者都没有就只出根标签。
      ...taxonomyOf(db, p.eventSlug ?? p.slug),
    }),
  };
}

// 容错解析一行告警 → 候选。返回 null = 结构不可用(记 skipped,原因进日志)。
function parseCandidate(
  db: DB,
  row: AlertRow,
  opts: ParseOpts,
): Candidate | null | "below_floor" {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  return row.type === "consensus"
    ? parseConsensusCandidate(db, row, p, opts)
    : parseWhaleCandidate(db, row, p, opts);
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
  const parseOpts: ParseOpts = {
    minTradeUsd: d.minTradeUsd,
    // settledOn:结算战报功能是否开着(承诺行双闸门之一,见 SETTLE_PROMISE_MAX_H)。
    settledOn: d.kinds?.settled === true,
    sirenUsd: d.whaleSirenUsd,
    whaleTemplate: d.templates?.whale,
    consensusTemplate: d.templates?.consensus,
    nowSec,
  };
  for (const row of rows) {
    const c = parseCandidate(d.db, row, parseOpts);
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
    const dedup = c.dedup;
    const decision = quotaDecision(d.db, {
      kind: c.kind,
      hasLink: false,
      budgetUsd: d.budgetUsd,
      nowSec,
      dailyCap: c.kind === "whale" ? d.whaleDailyCap : d.consensusDailyCap,
      dailySpendCapUsd: d.dailySpendCapUsd,
      weeklySpendCapUsd: d.weeklySpendCapUsd,
    });
    // 台账行的键分工:claim 行用市场级键(它就是去重锁),skipped 行一律
    // 用 `alert:${id}`。混用会出事 —— 一条被配额拒掉的 skipped 行若占着
    // 市场键,同市场后来那条合格的帖就再也抢不到锁了。
    const alertKey = `alert:${c.alertId}`;
    if (!decision.ok) {
      skip.run(c.kind, alertKey, c.alertId, c.text, nowSec);
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
      // 市场级键被占 = 同市场同方向同价格档本小时已有帖(或另一进程先到)。
      // 两种情形都要落台账,否则这条告警会在 30 分钟窗口内每轮重扫。
      skip.run(c.kind, alertKey, c.alertId, c.text, nowSec);
      skipped++;
      console.log(
        `[xBroadcast] skip alert=${c.alertId} kind=${c.kind}: dedup '${dedup}' already claimed (same market this hour, or another process)`,
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
