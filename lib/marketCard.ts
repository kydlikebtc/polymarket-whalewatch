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
import { buildPulse, type PulseBoardTag } from "./marketPulse";
import { fetchWithRetry } from "./fetchWithRetry";
import { consensusFoldKey } from "./outcomeStats";

/**
 * 市场脉搏视角。纯本地 market_daily,零上游。
 *
 * 榜单成员身份走 buildPulse 而不是就地重算门槛:异常分里的量能异动在自身基线
 * 不足 3 天时要退化成**当日横截面分位**,洗量/无鲸也各有门槛 —— 任何一份独立
 * 实现都会漂移,而漂移的表现是脉搏页和信号卡对同一个市场给出不同判定,两边都
 * 不报错。代价是每次建卡多扫一次当日 market_daily(近日 ~769 行的单次带索引
 * 查询 + 内存打分),相对本卡的 gamma + 多页 /trades + 钱包年龄探测可以忽略。
 *
 * 分类单独查:市场可能今天没交易(不在脉搏日的行里),但分类是稳定属性,取它
 * 最近一条即可 —— 否则一个昨天上过榜的市场今天连品类标签都会消失。
 */
export function buildMarketCardPulse(
  db: DB,
  conditionId: string,
): MarketCardPulse | null {
  const row = db
    .prepare(
      `SELECT day, category, subcategory FROM market_daily
        WHERE condition_id = ? ORDER BY day DESC LIMIT 1`,
    )
    .get(conditionId) as
    | { day: string; category: string | null; subcategory: string | null }
    | undefined;
  if (row == null) return null;

  const pulse = buildPulse(db);
  if (pulse.latestDay == null) return null;

  const boards: PulseBoardTag[] = [];
  const hit = pulse.top.find((m) => m.conditionId === conditionId);
  if (hit) boards.push("anomaly");
  if (pulse.divergences.some((d) => d.conditionId === conditionId)) {
    boards.push("divergence");
  }
  if (pulse.ghosts.some((g) => g.conditionId === conditionId)) {
    boards.push("ghost");
  }
  if (pulse.washTop.some((w) => w.conditionId === conditionId)) {
    boards.push("wash");
  }

  // 空串是 gamma 派生里「取到了但没有标签」的已知取值(gamma.ts §tags),
  // 与 null 一样都是「不知道」,在这里归一,免得 UI 渲染出一个空标签。
  const norm = (s: string | null): string | null =>
    s == null || s === "" ? null : s;

  return {
    day: pulse.latestDay,
    category: norm(row.category),
    subcategory: norm(row.subcategory),
    boards,
    anomalyScore: hit?.score ?? null,
  };
}

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

/**
 * 市场脉搏视角(2026-08-31)。两类标签,分工是重点:
 *   category/subcategory = Polymarket 对市场的分类,「这是什么市场」;
 *   boards               = 本站在脉搏日榜上给它的评价,「我们发现它怎么了」。
 *
 * 全部来自本地 market_daily,**零上游调用** —— 卡片本身已经是全站最贵的读
 * (gamma + 多页 /trades + 钱包年龄探测),这一段不能再往那个预算上加东西。
 *
 * ⚠️ 时间口径与卡片其余部分不同,不要混读:卡片的其余字段是**此刻**的窗口,
 * 而 boards 是 `day` 那个**已收盘的完整 UTC 日**的判定。今天盘中刚异动起来
 * 的市场,今天还不会有 boards。
 */
export interface MarketCardPulse {
  /** 榜单判定覆盖的 UTC 日(脉搏底座的最新完整日)。 */
  day: string;
  /** market_daily 最近一条上的分类;空串与缺失都归一成 null。 */
  category: string | null;
  subcategory: string | null;
  /** 该日它上了哪些市场级榜单;空数组 = 一个都没上(不是「没数据」)。 */
  boards: PulseBoardTag[];
  /**
   * 异常分 0-100。仅当它进了当日异常日榜**前 10** 才有值 —— 榜在数据层就
   * 封了 10 条,第 11 名不是「不异常」而是「我们没算到那么远」。
   */
  anomalyScore: number | null;
}

export interface MarketCard {
  conditionId: string;
  identity: { title: string; slug: string; eventSlug: string } | null;
  meta: MarketMeta | null;
  brief: MarketBrief;
  freshFlow: FreshFlowRow[];
  history: CardHistoryRow[];
  window: { trades: number; truncated: boolean; hours: number };
  /** null = market_daily 里没有这个市场的任何一天(底座还没覆盖到它)。 */
  pulse: MarketCardPulse | null;
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
    pulse: buildMarketCardPulse(db, conditionId),
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
