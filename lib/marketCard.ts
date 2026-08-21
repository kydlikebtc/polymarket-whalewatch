import type { DB } from "./db";
import {
  getMarketMeta,
  isSettled,
  type fetchMarketMeta,
  type MarketMeta,
} from "./gamma";
import { getAllSmartTags } from "./smartWallets";
import { getWalletAges } from "./walletAge";
import {
  composeMarketBrief,
  fetchMarketWindow,
  parseMarketInput,
  type MarketBrief,
} from "./marketBrief";
import { parseAlertHit, type AlertHit, type AlertHitRow } from "./alertHits";
import { fetchWithRetry } from "./fetchWithRetry";
import { consensusFoldKey } from "./outcomeStats";

// Shared single-market card composition — ONE implementation feeding both the
// dashboard API (/api/market/[cid]) and the Telegram bot's 🎯 query reply, so
// the two surfaces can never drift apart on thresholds or shapes.

export const CARD_WINDOW_SEC = 24 * 3600;
const FRESH_MIN_FILL_USD = 5000;
const FRESH_MAX_AGE_DAYS = 7;
const FRESH_AGE_LOOKUPS = 12;
const HISTORY_LIMIT = 20;
const HISTORY_WINDOW_DAYS = 90;

export interface FreshFlowRow {
  wallet: string;
  ageDays: number;
  usd: number;
  price: number;
  outcome: string;
  ts: number;
}

export interface CardHistoryRow extends AlertHit {
  won: number | null;
  price1h: number | null;
  price24h: number | null;
  resolved: boolean;
  /**
   * Escalation fold key (consensus only, null elsewhere). The history LIST
   * still shows every row — a reader looking at the timeline should see the
   * group grow. Only the aggregate 战绩 line folds, so one consensus counts
   * once there, matching the push footer and the dashboard strip.
   */
  foldKey: string | null;
}

export interface MarketCard {
  conditionId: string;
  identity: { title: string; slug: string; eventSlug: string } | null;
  meta: MarketMeta | null;
  brief: MarketBrief;
  freshFlow: FreshFlowRow[];
  history: CardHistoryRow[];
  window: { trades: number; truncated: boolean; hours: number };
}

export interface MarketCardDeps {
  nowSec?: number;
  fetchWindow?: typeof fetchMarketWindow;
  agesFetcher?: typeof getWalletAges;
  /**
   * 元信息抓取。可注入有两个理由:单元测试不该打网络;以及**降级路径必须零上游**
   * —— 预算耗尽时用陈旧窗口重算卡片,若这里偷偷捅一次 gamma,「零上游」这个契约
   * 就是假的(哪怕 gamma 与 data-api 是不同 host)。见 lib/marketCardService。
   */
  metaFetcher?: typeof fetchMarketMeta;
}

export async function buildMarketCard(
  db: DB,
  conditionId: string,
  deps: MarketCardDeps = {},
): Promise<MarketCard> {
  const {
    nowSec = Math.floor(Date.now() / 1000),
    fetchWindow = fetchMarketWindow,
    agesFetcher = getWalletAges,
    metaFetcher,
  } = deps;
  const [metaMap, window] = await Promise.all([
    getMarketMeta(
      db,
      [conditionId],
      metaFetcher ? { fetcher: metaFetcher } : {},
    ),
    fetchWindow(conditionId, { sinceSec: nowSec - CARD_WINDOW_SEC }),
  ]);
  const meta = metaMap[conditionId] ?? null;
  const smart = getAllSmartTags(db);
  // 结算事实注入 brief:市场已终局 → 留存敞口归零(赎回不走 /trades,靠成交
  // 流水永远推不出来)。meta 拿不到时 isSettled 返回 false —— 未知不归零。
  const brief = composeMarketBrief(window.trades, smart, conditionId, {
    settled: isSettled(meta),
  });

  // Market identity comes off the freshest trade row (gamma meta carries no
  // title); an empty window degrades to null and callers show the cid.
  const head = window.trades[0] ?? null;
  const identity = head
    ? { title: head.title, slug: head.slug, eventSlug: head.eventSlug }
    : null;

  // Fresh-wallet unusual flow: biggest single non-pool BUY fills, ages from
  // the permanent cache (missing = lookup failed, skipped), lookups capped.
  const fills = window.trades
    .filter(
      (t) =>
        t.side === "BUY" &&
        t.size * t.price >= FRESH_MIN_FILL_USD &&
        !smart.has(t.proxyWallet.toLowerCase()),
    )
    .sort((a, b) => b.size * b.price - a.size * a.price)
    .slice(0, FRESH_AGE_LOOKUPS);
  const ages = await agesFetcher(db, [
    ...new Set(fills.map((t) => t.proxyWallet.toLowerCase())),
  ]);
  const freshFlow: FreshFlowRow[] = fills.flatMap((t) => {
    const firstTs = ages[t.proxyWallet.toLowerCase()];
    if (typeof firstTs !== "number") return [];
    const ageDays = (nowSec - firstTs) / 86_400;
    if (ageDays > FRESH_MAX_AGE_DAYS) return [];
    return [
      {
        wallet: t.proxyWallet.toLowerCase(),
        ageDays,
        usd: t.size * t.price,
        price: t.price,
        outcome: t.outcome,
        ts: t.timestamp,
      },
    ];
  });

  // The tool's own alert history for this market + validation verdicts.
  const hitRows = db
    .prepare(
      `SELECT a.type, a.payload, a.created_at, a.dedup_key,
              ao.won, ao.price_1h, ao.price_24h, ao.resolved
       FROM alerts a
       LEFT JOIN alert_outcomes ao ON ao.alert_id = a.id
       WHERE a.created_at > ? AND a.payload LIKE ?
       ORDER BY a.created_at DESC LIMIT ?`,
    )
    .all(
      nowSec - HISTORY_WINDOW_DAYS * 86_400,
      `%${conditionId}%`,
      HISTORY_LIMIT,
    ) as (AlertHitRow & {
    dedup_key: string | null;
    won: number | null;
    price_1h: number | null;
    price_24h: number | null;
    resolved: number | null;
  })[];
  const history: CardHistoryRow[] = hitRows.flatMap((r) => {
    const hit = parseAlertHit(r);
    if (!hit) return [];
    return [
      {
        ...hit,
        won: r.won,
        price1h: r.price_1h,
        price24h: r.price_24h,
        resolved: r.resolved === 1,
        foldKey: r.type === "consensus" ? consensusFoldKey(r.dedup_key) : null,
      },
    ];
  });

  return {
    conditionId,
    identity,
    meta,
    brief,
    freshFlow,
    history,
    window: {
      trades: window.trades.length,
      truncated: window.truncated,
      hours: CARD_WINDOW_SEC / 3600,
    },
  };
}

// ---------------------------------------------------------------------------
// Input resolution (shared by /api/market/resolve and the bot): conditionId /
// market slug / pasted Polymarket URL → conditionId, or an event's markets as
// candidates (an event holds many markets; guessing would show the wrong one).
// ---------------------------------------------------------------------------

const GAMMA = "https://gamma-api.polymarket.com";

type GammaMarket = { conditionId?: string; question?: string };

export type ResolveResult =
  | { kind: "cid"; conditionId: string }
  | {
      kind: "candidates";
      candidates: { conditionId: string; question: string }[];
    }
  | { kind: "error"; message: string };

export async function resolveMarketInput(
  input: string,
  fetchJson: (url: string) => Promise<unknown> = async (url) => {
    const res = await fetchWithRetry(url, {
      timeoutMs: 10_000,
      label: "resolveMarket",
    });
    if (!res.ok) throw new Error(`gamma ${res.status}`);
    return res.json();
  },
): Promise<ResolveResult> {
  const parsed = parseMarketInput(input);
  if (!parsed) return { kind: "error", message: "empty input" };
  if (parsed.kind === "cid") return { kind: "cid", conditionId: parsed.value };
  try {
    // MARKET slug first (exact identity), closed markets included.
    for (const extra of ["", "&closed=true"]) {
      const rows = (await fetchJson(
        `${GAMMA}/markets?slug=${encodeURIComponent(parsed.value)}${extra}`,
      )) as GammaMarket[];
      const cid = Array.isArray(rows) ? rows[0]?.conditionId : undefined;
      if (cid) return { kind: "cid", conditionId: cid };
    }
    // EVENT slug: surface its markets as candidates.
    const events = (await fetchJson(
      `${GAMMA}/events?slug=${encodeURIComponent(parsed.value)}`,
    )) as { markets?: GammaMarket[] }[];
    const markets = Array.isArray(events) ? (events[0]?.markets ?? []) : [];
    const candidates = markets
      .filter((m) => m.conditionId)
      .map((m) => ({
        conditionId: m.conditionId as string,
        question: m.question ?? "",
      }));
    if (candidates.length === 1) {
      return { kind: "cid", conditionId: candidates[0].conditionId };
    }
    if (candidates.length > 1) return { kind: "candidates", candidates };
    return {
      kind: "error",
      message:
        "未找到该市场——请发送 Polymarket 市场链接、market slug 或 conditionId",
    };
  } catch (e) {
    return {
      kind: "error",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
