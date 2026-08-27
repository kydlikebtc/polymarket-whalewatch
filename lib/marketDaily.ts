import type { DB } from "./db";
import type { Trade } from "./types";
import { dedupKey, notionalUsd } from "./trades";
import { categoriesFor } from "./eventCategory";

// 内容引擎共享底座:每日市场聚合(docs/plans/2026-08-27-content-engine-design.md §0)。
// UTC 午夜后把昨天的 24h 深窗口一次性拉取、按 dedupKey 去重、逐市场聚合落
// `market_daily`。刻意不挂在 5 分钟共识循环上累加 —— 重叠窗口逐轮累加必须
// 跨轮去重,进程一重启内存去重集就双计;每日一次性重建天然幂等。

/** 小单桶(单笔名义额,含下限不含上限)。floor 之下的真散户不可见 ——
 * 一切文案写「小单」,不写「散户全量」。 */
export const SMALL_MIN_USD = 2_000;
export const SMALL_MAX_USD = 10_000;
/** 鲸鱼桶下限 —— 与 lib/signalFeed 的 HEAVY_MIN_USD 同值同义(有测试钉死),
 * 不直接 import 是为了不让日聚合背上 feed 模块的依赖面。 */
export const WHALE_MIN_USD = 50_000;

export const MARKET_DAILY_LAST_DAY_KEY = "market_daily_last_day";

export interface MarketDayRow {
  day: string;
  conditionId: string;
  title: string | null;
  slug: string | null;
  eventSlug: string | null;
  trades: number;
  volumeUsd: number;
  walletCount: number;
  /** 毛量最大的结果 —— 首末价与单边度都锚定它。 */
  topOutcome: string | null;
  /** 顶结果 |净流| ÷ 总量,0..1。 */
  oneSided: number;
  smallUsd: number;
  smallNetUsd: number;
  /** 小单桶净买最多的结果;桶内无净买方向(max 净 ≤ 0)= null。 */
  smallTopOutcome: string | null;
  whaleUsd: number;
  whaleNetUsd: number;
  whaleTopOutcome: string | null;
  priceFirst: number | null;
  priceLast: number | null;
  coveredFromSec: number;
  truncated: boolean;
}

interface OutcomeAcc {
  gross: number;
  net: number;
}

/** 昨日窗口 → 逐市场聚合行。纯函数:时间过滤、去重、分桶全在这里。 */
export function aggregateMarketDay(
  trades: Trade[],
  opts: {
    dayStart: number;
    dayEnd: number;
    coveredFromSec: number;
    truncated: boolean;
  },
): MarketDayRow[] {
  const day = new Date(opts.dayStart * 1000).toISOString().slice(0, 10);
  const seen = new Set<string>();
  const byMarket = new Map<
    string,
    {
      title: string | null;
      slug: string | null;
      eventSlug: string | null;
      trades: number;
      volume: number;
      wallets: Set<string>;
      outcomes: Map<string, OutcomeAcc>;
      small: { gross: number; byOutcome: Map<string, number> };
      whale: { gross: number; byOutcome: Map<string, number> };
      fills: { ts: number; outcome: string; price: number }[];
    }
  >();

  for (const t of trades) {
    if (t.timestamp < opts.dayStart || t.timestamp >= opts.dayEnd) continue;
    const dk = dedupKey(t);
    if (seen.has(dk)) continue;
    seen.add(dk);
    const usd = notionalUsd(t);
    const m = byMarket.get(t.conditionId) ?? {
      title: t.title ?? null,
      slug: t.slug ?? null,
      eventSlug: t.eventSlug ?? null,
      trades: 0,
      volume: 0,
      wallets: new Set<string>(),
      outcomes: new Map<string, OutcomeAcc>(),
      small: { gross: 0, byOutcome: new Map<string, number>() },
      whale: { gross: 0, byOutcome: new Map<string, number>() },
      fills: [],
    };
    byMarket.set(t.conditionId, m);
    m.trades++;
    m.volume += usd;
    m.wallets.add(t.proxyWallet);
    const signed = t.side === "BUY" ? usd : -usd;
    const acc = m.outcomes.get(t.outcome) ?? { gross: 0, net: 0 };
    acc.gross += usd;
    acc.net += signed;
    m.outcomes.set(t.outcome, acc);
    if (usd >= SMALL_MIN_USD && usd < SMALL_MAX_USD) {
      m.small.gross += usd;
      m.small.byOutcome.set(
        t.outcome,
        (m.small.byOutcome.get(t.outcome) ?? 0) + signed,
      );
    } else if (usd >= WHALE_MIN_USD) {
      m.whale.gross += usd;
      m.whale.byOutcome.set(
        t.outcome,
        (m.whale.byOutcome.get(t.outcome) ?? 0) + signed,
      );
    }
    m.fills.push({ ts: t.timestamp, outcome: t.outcome, price: t.price });
  }

  const topOf = (
    byOutcome: Map<string, number>,
  ): { outcome: string; net: number } | null => {
    let best: { outcome: string; net: number } | null = null;
    for (const [o, n] of byOutcome) {
      if (best == null || n > best.net) best = { outcome: o, net: n };
    }
    // 桶内没有净买方向(全在卖)就是 null —— 不拿「卖得最少」冒充「在买」。
    return best != null && best.net > 0 ? best : null;
  };

  const out: MarketDayRow[] = [];
  for (const [conditionId, m] of byMarket) {
    let topOutcome: string | null = null;
    let topGross = -1;
    let topNet = 0;
    for (const [o, acc] of m.outcomes) {
      if (acc.gross > topGross) {
        topGross = acc.gross;
        topOutcome = o;
        topNet = acc.net;
      }
    }
    const topFills = m.fills
      .filter((f) => f.outcome === topOutcome)
      .sort((a, b) => a.ts - b.ts);
    const small = topOf(m.small.byOutcome);
    const whale = topOf(m.whale.byOutcome);
    out.push({
      day,
      conditionId,
      title: m.title,
      slug: m.slug,
      eventSlug: m.eventSlug,
      trades: m.trades,
      volumeUsd: m.volume,
      walletCount: m.wallets.size,
      topOutcome,
      oneSided: m.volume > 0 ? Math.abs(topNet) / m.volume : 0,
      smallUsd: m.small.gross,
      smallNetUsd: small?.net ?? 0,
      smallTopOutcome: small?.outcome ?? null,
      whaleUsd: m.whale.gross,
      whaleNetUsd: whale?.net ?? 0,
      whaleTopOutcome: whale?.outcome ?? null,
      priceFirst: topFills[0]?.price ?? null,
      priceLast: topFills[topFills.length - 1]?.price ?? null,
      coveredFromSec: opts.coveredFromSec,
      truncated: opts.truncated,
    });
  }
  return out;
}

export interface MarketDailyDeps {
  /** 24h 深窗口抓取(worker 绑定 getTradesWindowDeep;测试注入夹具)。 */
  fetchWindow: (sinceSec: number) => Promise<{
    trades: Trade[];
    truncated: boolean;
    effectiveSinceSec: number | null;
  }>;
  nowSec?: number;
}

/**
 * 每日一轮:昨天没聚合过就拉窗口聚合落库,做过了直接跳过。
 * 成功后才写日标记(与 Telegram 的 claim-first 相反 —— 这里没有重复投递
 * 危害,失败后下轮重试比「失败即永久跳过这一天」重要)。
 */
export async function runMarketDailyCycle(
  db: DB,
  deps: MarketDailyDeps,
): Promise<{ ran: boolean; day?: string; markets?: number }> {
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000);
  const todayStart = nowSec - (nowSec % 86_400);
  const dayStart = todayStart - 86_400;
  const day = new Date(dayStart * 1000).toISOString().slice(0, 10);
  const done = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(MARKET_DAILY_LAST_DAY_KEY) as { value: string | null } | undefined;
  if (done?.value === day) return { ran: false };

  const win = await deps.fetchWindow(dayStart);
  const coveredFromSec = Math.max(win.effectiveSinceSec ?? dayStart, dayStart);
  const rows = aggregateMarketDay(win.trades, {
    dayStart,
    dayEnd: todayStart,
    coveredFromSec,
    truncated: win.truncated,
  });
  const cats = categoriesFor(
    db,
    rows.map((r) => r.eventSlug),
  );

  const ins = db.prepare(
    `INSERT OR REPLACE INTO market_daily
       (day, condition_id, title, slug, event_slug, category, subcategory,
        trades, volume_usd, wallet_count, top_outcome, one_sided,
        small_usd, small_net_usd, small_top_outcome,
        whale_usd, whale_net_usd, whale_top_outcome,
        price_first, price_last, covered_from_sec, truncated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const writeAll = db.transaction((list: MarketDayRow[]) => {
    for (const r of list) {
      const cat = r.eventSlug ? cats[r.eventSlug] : undefined;
      ins.run(
        r.day,
        r.conditionId,
        r.title,
        r.slug,
        r.eventSlug,
        cat?.category ?? null,
        cat?.subcategory ?? null,
        r.trades,
        r.volumeUsd,
        r.walletCount,
        r.topOutcome,
        r.oneSided,
        r.smallUsd,
        r.smallNetUsd,
        r.smallTopOutcome,
        r.whaleUsd,
        r.whaleNetUsd,
        r.whaleTopOutcome,
        r.priceFirst,
        r.priceLast,
        r.coveredFromSec,
        r.truncated ? 1 : 0,
      );
    }
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
      MARKET_DAILY_LAST_DAY_KEY,
      day,
    );
  });
  writeAll(rows);
  console.log(
    `[marketDaily] aggregated ${day}: ${rows.length} market(s) from ${win.trades.length} rows${win.truncated ? " (window truncated)" : ""}`,
  );
  return { ran: true, day, markets: rows.length };
}
