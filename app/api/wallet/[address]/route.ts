import { openDb } from "../../../../lib/db";
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
import { getEventCategories } from "../../../../lib/gamma";
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

export async function GET(
  req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address: raw } = await params;
  const address = String(raw ?? "").toLowerCase();
  if (!ADDRESS_RE.test(address)) {
    return Response.json({ error: "invalid address" }, { status: 400 });
  }
  // Same getWalletStats fanout as POST /api/wallet-stats (plus activity pages,
  // holdings and an RPC call), so it shares that route's "wallet-profile"
  // budget — otherwise enumerating public leaderboard addresses one GET at a
  // time would walk straight around the batch route's ceiling. Cost 3: a cold
  // profile is worth several batch wallets.
  const limited = guardExpensive(
    req,
    "wallet-profile",
    { perIp: 120, global: 400, cost: 3 },
    { error: "rate limited" },
  );
  if (limited) return limited;
  try {
    const db = openDb(process.env.DASH_DB ?? "data.sqlite");
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

      // Category focus via EVENT TAGS over the top markets (cheap, cached) —
      // the market-level category field is null for most modern markets.
      const eventCats = await getEventCategories(
        db,
        profile.topMarkets.map((m) => m.eventSlug),
      );
      const catUsd = new Map<string, number>();
      const topMarkets = profile.topMarkets.map((m) => {
        const tax = eventCats[m.eventSlug];
        const category = tax?.category ?? null;
        // 类别集中度聚合保持一级口径(评分/画像的既有键不动,见二级分类
        // 设计文档 §2 红线);市场行额外带上二级,展示层合成「体育·NBA」。
        const subcategory = tax?.subcategory ?? null;
        if (category) {
          catUsd.set(
            category,
            (catUsd.get(category) ?? 0) + m.buyUsd + m.sellUsd,
          );
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
        recent,
      });
    } finally {
      db.close();
    }
  } catch (e) {
    console.error("[/api/wallet] profile failed:", e);
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 200 },
    );
  }
}
