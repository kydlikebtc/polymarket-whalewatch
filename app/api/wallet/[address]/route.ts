import { openDb, type DB } from "../../../../lib/db";
import {
  ALERT_HITS_WINDOW_DAYS,
  parseAlertHit,
  queryAlertHitRows,
  type AlertHit,
} from "../../../../lib/alertHits";
import { getWalletAges } from "../../../../lib/walletAge";
import { getWalletStats } from "../../../../lib/walletStats";
import { guardExpensive } from "../../../../lib/apiGuard";
import { createBoundedCache } from "../../../../lib/boundedCache";
import { fetchPusdBalance } from "../../../../lib/pusdBalance";
import { getSmartTags } from "../../../../lib/smartWallets";
import { getWalletTags } from "../../../../lib/walletTags";
import { walletPriceImpact } from "../../../../lib/priceImpact";
import {
  getEventCategories,
  readEventCategories,
  type EventTaxonomy,
} from "../../../../lib/gamma";
import {
  analyzeTrades,
  fetchRecentTrades,
  type ActivityTrade,
  type WalletProfile,
} from "../../../../lib/walletProfile";
import {
  fetchCurrentHoldings,
  type HoldingsSummary,
} from "../../../../lib/holdings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

// The activity pull is 1-2 upstream requests; keep a short in-memory cache so
// tab refreshes / repeat visits don't refetch the same 2000 rows. (Bounding
// and eviction now live in lib/boundedCache.)
const PROFILE_TTL_MS = 10 * 60_000;

// Holdings get their OWN, much shorter TTL. They were previously bundled into
// the profile entry under one 10-minute TTL, which was backwards on both axes:
//   cost — the profile is a multi-page 2000-trade pull; holdings are ONE
//          /positions page for a typical wallet. Caching the cheap half for
//          ten minutes saves nothing.
//   volatility — holdings are the one number here that moves tick by tick.
//          Measured live 2026-08-21 on 0x6d20…a165 in an in-play Dota 2
//          market: 231,026 shares at 14:01 → 416,835 by 14:18. A ten-minute
//          snapshot of that reads as a data bug next to Polymarket's own page.
// 60s matches /api/positions so the market card and this dossier can no longer
// disagree about the same wallet.
const HOLDINGS_TTL_MS = 60_000;
const CACHE_MAX = 500;

const profileCache = createBoundedCache<{
  profile: WalletProfile;
  recent: ActivityTrade[];
}>(PROFILE_TTL_MS, CACHE_MAX);
const holdingsCache = createBoundedCache<HoldingsSummary>(
  HOLDINGS_TTL_MS,
  CACHE_MAX,
);

const EMPTY_HOLDINGS: HoldingsSummary = {
  holdings: [],
  totalValue: 0,
  totalCashPnl: 0,
  count: 0,
  truncated: false,
};

async function loadProfile(address: string) {
  const hit = profileCache.get(address);
  if (hit) {
    console.log(`[/api/wallet] profile HIT ${address}`);
    return hit;
  }
  const trades = await fetchRecentTrades(address);
  const entry = { profile: analyzeTrades(trades), recent: trades.slice(0, 20) };
  profileCache.set(address, entry);
  console.log(
    `[/api/wallet] profile MISS ${address} — fetched ${trades.length} trades (ttl ${PROFILE_TTL_MS / 1000}s)`,
  );
  return entry;
}

async function loadHoldings(address: string): Promise<HoldingsSummary> {
  const hit = holdingsCache.get(address);
  if (hit) {
    console.log(`[/api/wallet] holdings HIT ${address}`);
    return hit;
  }
  try {
    const holdings = await fetchCurrentHoldings(address);
    holdingsCache.set(address, holdings);
    // 持仓陈旧度是这个页面唯一会被用户拿去和 Polymarket 逐字对账的东西 ——
    // 出问题时必须能从日志直接读出「这一次到底是缓存还是新拉的、拉到了多少」。
    console.log(
      `[/api/wallet] holdings MISS ${address} — ${holdings.count} live positions, ` +
        `$${Math.round(holdings.totalValue)} total (ttl ${HOLDINGS_TTL_MS / 1000}s)`,
    );
    return holdings;
  } catch (e) {
    // Degrade to an empty book so the rest of the dossier still renders — but
    // do NOT cache the failure, or one upstream blip would pin the wallet to
    // "no holdings" for the whole TTL. Same discipline as lib/promiseCache.
    console.warn("[/api/wallet] holdings fetch failed:", e);
    return EMPTY_HOLDINGS;
  }
}

// Category focus via EVENT TAGS over the top markets — the market-level
// category field is null for most modern markets. Shared by the live and the
// degraded path (they differ only in WHERE the taxonomy comes from: live may
// backfill upstream, degraded reads the local cache only).
function decorateWithTaxonomy(
  profile: WalletProfile,
  eventCats: Record<string, EventTaxonomy>,
) {
  const catUsd = new Map<string, number>();
  const topMarkets = profile.topMarkets.map((m) => {
    const tax = eventCats[m.eventSlug];
    const category = tax?.category ?? null;
    // 类别集中度聚合保持一级口径(评分/画像的既有键不动,见二级分类
    // 设计文档 §2 红线);市场行额外带上二级,展示层合成「体育·NBA」。
    const subcategory = tax?.subcategory ?? null;
    if (category) {
      catUsd.set(category, (catUsd.get(category) ?? 0) + m.buyUsd + m.sellUsd);
    }
    return { ...m, category, subcategory };
  });
  const catTotal = [...catUsd.values()].reduce((s, v) => s + v, 0);
  const categories = [...catUsd.entries()]
    .map(([category, usd]) => ({
      category,
      usd,
      share: catTotal > 0 ? usd / catTotal : 0,
    }))
    .sort((a, b) => b.usd - a.usd);
  return { topMarkets, categories };
}

/**
 * 降级档案:**零上游请求**,只回本地/内存缓存里现成的东西。
 *
 * 「被限流」和「上游故障」都不等于「无数据」—— alerts 台账、战绩/年龄的
 * SQLite 缓存、smart 标签、以及可能还温着的 profile/holdings 内存缓存,
 * 全都不花任何上游预算。此前这些跟着 429/error 一起消失,整页只剩一条
 * 红字;现在客户端拿到 degraded 响应先渲染本地档案,再倒计时重试实时层。
 *
 * 纪律:此函数内**严禁触发上游**(与 SEO 层同一条红线)。stats/age 用
 * 抛错 fetcher + 超长 TTL 实现「只读缓存、绝不回源」:命中(哪怕过期)
 * 即返回,miss 时 fetcher 立刻拒绝 → null 且不污染缓存(两个模块对失败
 * 的既有语义都是 uncached,见 lib/walletStats / lib/walletAge)。
 */
// 价格影响持久性(2026-08-28 八件套):纯本地读,正常/降级两条路径都能算;
// 任何失败只降级 null(块整体省略),不拖垮档案。
function impactOf(db: DB, address: string) {
  try {
    return walletPriceImpact(db, address);
  } catch (e) {
    console.warn("[/api/wallet] priceImpact 现算失败,降级 null:", e);
    return null;
  }
}

async function localOnlyDossier(
  db: DB,
  address: string,
  degraded: "rate_limited" | "upstream_error",
  retryAfterSec: number,
) {
  const localOnly = () =>
    Promise.reject(new Error("degraded dossier reads local cache only"));
  const [ages, stats] = await Promise.all([
    getWalletAges(db, [address], { fetcher: localOnly }),
    getWalletStats(db, [address], {
      ttlSec: Number.MAX_SAFE_INTEGER,
      fetcher: localOnly,
    }),
  ]);
  const firstTs = ages[address] ?? null;
  const smart = getSmartTags(db, [address])[address] ?? null;
  const tags = getWalletTags(db, address);
  const alertHits = queryAlertHitRows(db, address)
    .map(parseAlertHit)
    .filter((h): h is AlertHit => h !== null);

  // 内存缓存还温着就白拿(profile 10min / holdings 60s TTL 内),分类装饰
  // 走只读的 readEventCategories —— 缓存里没有的 slug 只是缺标签,不回源。
  const warm = profileCache.get(address) ?? null;
  const holdings = holdingsCache.get(address) ?? EMPTY_HOLDINGS;
  const decorated = warm
    ? decorateWithTaxonomy(
        warm.profile,
        readEventCategories(
          db,
          warm.profile.topMarkets.map((m) => m.eventSlug),
        ),
      )
    : null;

  console.log(
    `[/api/wallet] degraded(${degraded}) ${address} — local-only dossier ` +
      `(stats ${stats[address] ? "cached" : "none"}, profile ${warm ? "warm" : "none"}, ${alertHits.length} alert hits)`,
  );
  return Response.json({
    address,
    firstTs,
    ageDays: firstTs != null ? (Date.now() / 1000 - firstTs) / 86400 : null,
    stats: stats[address],
    smart,
    tags,
    // RPC 也是外部依赖,降级模式一并跳过(客户端本就把 null 显示成暂不可用)。
    pusdBalance: null,
    profile:
      warm && decorated
        ? { ...warm.profile, topMarkets: decorated.topMarkets }
        : null,
    holdings,
    categories: decorated?.categories ?? [],
    alertHits,
    alertHitsWindowDays: ALERT_HITS_WINDOW_DAYS,
    impact: impactOf(db, address),
    recent: warm?.recent ?? [],
    degraded,
    retryAfterSec,
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address: raw } = await params;
  const address = String(raw ?? "").toLowerCase();
  if (!ADDRESS_RE.test(address)) {
    return Response.json({ error: "invalid address" }, { status: 400 });
  }
  const db = openDb(process.env.DASH_DB ?? "data.sqlite");
  try {
    // Same getWalletStats fanout as POST /api/wallet-stats (plus activity
    // pages, holdings and an RPC call), so it shares that route's
    // "wallet-profile" budget — otherwise enumerating public leaderboard
    // addresses one GET at a time would walk straight around the batch route's
    // ceiling. Cost 3: a cold profile is worth several batch wallets.
    const limited = guardExpensive(
      req,
      "wallet-profile",
      { perIp: 120, global: 400, cost: 3 },
      { error: "rate limited" },
    );
    if (limited) {
      // 限流 ≠ 无数据:计费照收(枚举者刷不动上游 —— 他们只能反复拿到
      // 本地缓存),但把本地能给的全给出去,客户端 60s 后自动重试实时层。
      // 窗口定长 1 分钟(lib/apiGuard),retryAfterSec 与之对齐。
      return await localOnlyDossier(db, address, "rate_limited", 60);
    }
    try {
      // Still fetched concurrently, but each half now hits its OWN cache and
      // its own TTL — a warm profile no longer forces a stale holdings book.
      const [{ profile, recent }, holdings] = await Promise.all([
        loadProfile(address),
        loadHoldings(address),
      ]);

      // Age + settled record + live PUSD cash (all fetched concurrently; the
      // balance is a single RPC eth_call and degrades to null on failure).
      const [ages, stats, pusdBalance] = await Promise.all([
        getWalletAges(db, [address]),
        getWalletStats(db, [address]),
        fetchPusdBalance(address),
      ]);
      const firstTs = ages[address] ?? null;
      const smart = getSmartTags(db, [address])[address] ?? null;
      // Derived wallet tags (pool source / discovery-channel evidence / bot),
      // same model the /discovery funnel shows — lib/walletTags.
      const tags = getWalletTags(db, address);

      const eventCats = await getEventCategories(
        db,
        profile.topMarkets.map((m) => m.eventSlug),
      );
      const { topMarkets, categories } = decorateWithTaxonomy(
        profile,
        eventCats,
      );

      // This tool's own history with the wallet, bounded to the recent window
      // (see lib/alertHits for the LIKE-probe and lower-bound rationale).
      const alertHits = queryAlertHitRows(db, address)
        .map(parseAlertHit)
        .filter((h): h is AlertHit => h !== null);

      return Response.json({
        address,
        firstTs,
        ageDays: firstTs != null ? (Date.now() / 1000 - firstTs) / 86400 : null,
        stats: stats[address],
        smart,
        tags,
        pusdBalance,
        profile: { ...profile, topMarkets },
        holdings,
        categories,
        alertHits,
        // Surfaced so the page can label the coverage window it's showing.
        alertHitsWindowDays: ALERT_HITS_WINDOW_DAYS,
        impact: impactOf(db, address),
        recent,
      });
    } catch (e) {
      // 上游故障走与限流同一条降级路:本地档案 + 客户端稍后重试。
      // (此前这里直接回 {error},整页跟着变成一条红字。)
      console.error("[/api/wallet] live dossier failed, degrading:", e);
      return await localOnlyDossier(db, address, "upstream_error", 30);
    }
  } catch (e) {
    // 连本地组装都失败(SQLite 故障等)才是真·错误,保留旧错误信封。
    console.error("[/api/wallet] dossier failed:", e);
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 200 },
    );
  } finally {
    db.close();
  }
}
