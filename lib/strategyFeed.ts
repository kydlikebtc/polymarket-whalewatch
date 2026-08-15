import type { DB } from "./db";
import type { SignalRecord } from "./signalRecord";
import { strategyRecord30d } from "./strategySignals";

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
  strategy: { id: number; name: string; source: string };
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
  /** strategy_id(字符串键,JSON 对象)→ 档位名 + source + 30d 战绩。 */
  recordByStrategy: Record<
    string,
    { name: string; source: string; record: SignalRecord }
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
function sourceOf(paramsJson: string | null): string {
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
  if (strategies.length === 0) {
    return { active: [], settled: [], recordByStrategy: {} };
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
  const cats = categoriesFor(
    db,
    activeRows.map((r) => r.event_slug ?? ""),
  );
  const active: StrategyFeedSignal[] = activeRows.map((r) => ({
    id: r.id,
    strategy: {
      id: r.strategy_id,
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
      name: s.name,
      source: srcOf.get(s.id) ?? "consensus",
      record: strategyRecord30d(db, s.id, nowSec),
    };
  }

  return { active, settled, recordByStrategy };
}
