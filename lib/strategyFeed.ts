import type { DB } from "./db";
import type { SignalRecord } from "./signalRecord";
import { strategyCode } from "./strategyCodes";
import { strategyRecord30d } from "./strategySignals";
import { buildSignalEvent, type SignalEventV1 } from "./webhookDelivery";

// 对外信号批次 2:/api/signals 的 strategies 段。
// 契约纪律与 buildSignalFeed 相同:全部字段来自已持久化状态(strategy_signals
// + follow_strategies + event_category),零上游调用,突发流量永远挤不占引擎的
// data-api 预算。
//
// nowSec 全参数化是延迟分层的实现基础:tier='delayed' 的 key 传入
// nowSec - delaySec,得到的整段数据就是「delaySec 前的世界」—— 之后发生的
// 信号不可见、之后落地的结算仍显示为 active。免费版不阉割字段,只晚到。

/** active 段的信号窗口:超过它的未结算信号不再是「行动项」,只出现在战绩里。 */
export const STRATEGY_ACTIVE_WINDOW_HOURS = 48;
/** settled(认账)段的回看天数,对齐 signalFeed.SETTLED_DAYS。 */
const SETTLED_DAYS = 3;
const SETTLED_LIMIT = 20;

export interface StrategyFeedSignal {
  id: number;
  /** `code` = 跨部署稳定的档位码(lib/strategyCodes);`id` 只在本部署内有效。 */
  strategy: {
    id: number;
    code: string | null;
    name: string;
    source: string;
  };
  conditionId: string;
  title: string;
  slug: string;
  eventSlug: string;
  category: string | null;
  subcategory: string | null;
  outcome: string;
  outcomeIndex: number | null;
  asset: string | null;
  formationTs: number;
  referencePrice: number | null;
  walletCount: number | null;
  totalNetUsd: number | null;
  entryPrice: number | null;
  sizeUsd: number | null;
  emittedAt: number;
}

export interface StrategyFeedSettled {
  id: number;
  strategyId: number;
  strategyCode: string | null;
  strategyName: string;
  conditionId: string;
  title: string;
  outcome: string;
  entryPrice: number | null;
  exitPrice: number | null;
  won: boolean | null;
  realizedPnl: number | null;
  settledAt: number;
}

export interface StrategyFeed {
  active: StrategyFeedSignal[];
  settled: StrategyFeedSettled[];
  /**
   * 动作流(2026-08-31):webhook SignalEventV1 的拉取镜像,买入(entry)与
   * 兑现(settle)同为一等事件 —— 只轮询不挂 webhook 的订阅方在此前只能
   * 看见买入(active[] 在结算后把行撤走,settled[] 是 3d/20 条的战绩视图,
   * 不是动作)。entry 按 emitted_at、settle 按 settled_ts 各取近 48h,
   * 同一信号结算后出两条;逐条与 webhook POST body 同构(同一
   * buildSignalEvent 产出),幂等键同为 (id, event),一套解析器吃两个通道。
   */
  events: SignalEventV1[];
  /** strategy_id(字符串键,JSON 对象)→ 档位码 + 档位名 + source + 30d 战绩。 */
  recordByStrategy: Record<
    string,
    { code: string | null; name: string; source: string; record: SignalRecord }
  >;
}

interface SignalRow {
  id: number;
  strategy_id: number;
  condition_id: string;
  outcome: string;
  outcome_index: number | null;
  asset: string | null;
  title: string | null;
  slug: string | null;
  event_slug: string | null;
  formation_ts: number;
  reference_price: number | null;
  wallet_count: number | null;
  total_net_usd: number | null;
  entry_price: number | null;
  size_usd: number | null;
  emitted_at: number;
  settled: number;
  settled_ts: number | null;
  exit_price: number | null;
  won: number | null;
  realized_pnl: number | null;
}

/** params_json 里的 source(缺失 = 既有两档的 "consensus" 兼容语义)。 */
export function sourceOf(paramsJson: string | null): string {
  if (!paramsJson) return "consensus";
  try {
    const p = JSON.parse(paramsJson) as { source?: unknown };
    return typeof p.source === "string" ? p.source : "consensus";
  } catch {
    return "consensus";
  }
}

function categoriesFor(
  db: DB,
  slugs: string[],
): Record<string, { category: string | null; subcategory: string | null }> {
  const out: Record<
    string,
    { category: string | null; subcategory: string | null }
  > = {};
  const uniq = [...new Set(slugs.filter(Boolean))];
  if (uniq.length === 0) return out;
  const placeholders = uniq.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT event_slug, category, subcategory FROM event_category WHERE event_slug IN (${placeholders})`,
    )
    .all(...uniq) as {
    event_slug: string;
    category: string | null;
    subcategory: string | null;
  }[];
  for (const r of rows) {
    out[r.event_slug] = {
      category: r.category || null,
      subcategory: r.subcategory || null,
    };
  }
  return out;
}

export function buildStrategyFeed(
  db: DB,
  opts: { nowSec?: number } = {},
): StrategyFeed {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const strategies = db
    .prepare(
      "SELECT id, name, params_json, push_enabled FROM follow_strategies WHERE push_enabled = 1",
    )
    .all() as {
    id: number;
    name: string;
    params_json: string | null;
    push_enabled: number;
  }[];
  const nameOf = new Map(strategies.map((s) => [s.id, s.name]));
  const srcOf = new Map(strategies.map((s) => [s.id, sourceOf(s.params_json)]));
  // 未登记档位码的档(运营手工建的)取 null —— 不回退成档名,理由见
  // lib/strategyCodes.ts 的 strategyCode 注释。
  const codeOf = new Map(strategies.map((s) => [s.id, strategyCode(s.name)]));
  if (strategies.length === 0) {
    return { active: [], settled: [], events: [], recordByStrategy: {} };
  }
  const ids = strategies.map((s) => s.id);
  const placeholders = ids.map(() => "?").join(",");

  // 时移口径:emitted_at <= nowSec(之后的信号在这个世界里还不存在);
  // settled_ts > nowSec 的结算同样"尚未发生" —— 该信号仍算 active。
  const activeRows = db
    .prepare(
      `SELECT * FROM strategy_signals
       WHERE strategy_id IN (${placeholders})
         AND emitted_at <= ? AND emitted_at >= ?
         AND (settled = 0 OR settled_ts > ?)
       ORDER BY emitted_at DESC`,
    )
    .all(
      ...ids,
      nowSec,
      nowSec - STRATEGY_ACTIVE_WINDOW_HOURS * 3600,
      nowSec,
    ) as SignalRow[];
  // 动作流的两种事件行。entry 与 active[] 的差别只有一处:不排除已结算 ——
  // 买入这个动作在结算后依然发生过(操作历史语义),active[] 是「还能行动」
  // 的状态视图,两个口径都对,各管各的。settle 窗口同 48h(按 settled_ts),
  // 与 settled[] 的 3d/LIMIT 20 战绩视图无关。均无 LIMIT:窗口即上限,
  // 不引入静默截断。
  const entryEvRows = db
    .prepare(
      `SELECT * FROM strategy_signals
       WHERE strategy_id IN (${placeholders})
         AND emitted_at <= ? AND emitted_at >= ?
       ORDER BY emitted_at DESC`,
    )
    .all(
      ...ids,
      nowSec,
      nowSec - STRATEGY_ACTIVE_WINDOW_HOURS * 3600,
    ) as SignalRow[];
  const settleEvRows = db
    .prepare(
      `SELECT * FROM strategy_signals
       WHERE strategy_id IN (${placeholders})
         AND settled = 1 AND settled_ts <= ? AND settled_ts >= ?
       ORDER BY settled_ts DESC`,
    )
    .all(
      ...ids,
      nowSec,
      nowSec - STRATEGY_ACTIVE_WINDOW_HOURS * 3600,
    ) as SignalRow[];

  const cats = categoriesFor(db, [
    ...activeRows.map((r) => r.event_slug ?? ""),
    ...entryEvRows.map((r) => r.event_slug ?? ""),
    ...settleEvRows.map((r) => r.event_slug ?? ""),
  ]);
  const active: StrategyFeedSignal[] = activeRows.map((r) => ({
    id: r.id,
    strategy: {
      id: r.strategy_id,
      code: codeOf.get(r.strategy_id) ?? null,
      name: nameOf.get(r.strategy_id) ?? `#${r.strategy_id}`,
      source: srcOf.get(r.strategy_id) ?? "consensus",
    },
    conditionId: r.condition_id,
    title: r.title ?? "",
    slug: r.slug ?? "",
    eventSlug: r.event_slug ?? "",
    category: cats[r.event_slug ?? ""]?.category ?? null,
    subcategory: cats[r.event_slug ?? ""]?.subcategory ?? null,
    outcome: r.outcome,
    outcomeIndex: r.outcome_index,
    asset: r.asset,
    formationTs: r.formation_ts,
    referencePrice: r.reference_price,
    walletCount: r.wallet_count,
    totalNetUsd: r.total_net_usd,
    entryPrice: r.entry_price,
    sizeUsd: r.size_usd,
    emittedAt: r.emitted_at,
  }));

  const settledRows = db
    .prepare(
      `SELECT * FROM strategy_signals
       WHERE strategy_id IN (${placeholders})
         AND settled = 1 AND settled_ts <= ? AND settled_ts >= ?
       ORDER BY settled_ts DESC LIMIT ${SETTLED_LIMIT}`,
    )
    .all(...ids, nowSec, nowSec - SETTLED_DAYS * 86_400) as SignalRow[];
  const settled: StrategyFeedSettled[] = settledRows.map((r) => ({
    id: r.id,
    strategyId: r.strategy_id,
    strategyCode: codeOf.get(r.strategy_id) ?? null,
    strategyName: nameOf.get(r.strategy_id) ?? `#${r.strategy_id}`,
    conditionId: r.condition_id,
    title: r.title ?? "",
    outcome: r.outcome,
    entryPrice: r.entry_price,
    exitPrice: r.exit_price,
    won: r.won === 1 ? true : r.won === 0 ? false : null,
    realizedPnl: r.realized_pnl,
    settledAt: r.settled_ts ?? 0,
  }));

  const recordByStrategy: StrategyFeed["recordByStrategy"] = {};
  for (const s of strategies) {
    recordByStrategy[String(s.id)] = {
      code: strategyCode(s.name),
      name: s.name,
      source: srcOf.get(s.id) ?? "consensus",
      record: strategyRecord30d(db, s.id, nowSec),
    };
  }

  // 动作流:同一 buildSignalEvent(webhook 投递用的那个)—— 拉/推同构靠
  // 复用构造器保证,不靠两份代码互相追赶。record/分类与投递时同源:30d
  // 战绩就是 recordByStrategy 里那份对象,分类同 event_category 查询。
  const toEvent = (r: SignalRow, event: "entry" | "settle"): SignalEventV1 =>
    buildSignalEvent(r, event, {
      strategyName: nameOf.get(r.strategy_id) ?? `#${r.strategy_id}`,
      source: srcOf.get(r.strategy_id) ?? "consensus",
      record: recordByStrategy[String(r.strategy_id)]?.record ?? null,
      category: cats[r.event_slug ?? ""]?.category ?? null,
      subcategory: cats[r.event_slug ?? ""]?.subcategory ?? null,
    });
  const events: SignalEventV1[] = [
    ...entryEvRows.map((r) => ({
      ev: toEvent(r, "entry" as const),
      ts: r.emitted_at,
      rank: 0,
    })),
    ...settleEvRows.map((r) => ({
      ev: toEvent(r, "settle" as const),
      ts: r.settled_ts ?? 0,
      rank: 1,
    })),
  ]
    // 事件自身时刻倒序;同刻 settle 在 entry 前(对齐 /follow 操作历史
    // 「同刻兑现在上」的时间线语义);再按 id 倒序,全序确定、可 diff。
    .sort((a, b) => b.ts - a.ts || b.rank - a.rank || b.ev.id - a.ev.id)
    .map((x) => x.ev);

  return { active, settled, events, recordByStrategy };
}
