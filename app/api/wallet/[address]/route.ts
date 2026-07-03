import { openDb } from "../../../../lib/db";
import {
  ALERT_HITS_WINDOW_DAYS,
  parseAlertHit,
  queryAlertHitRows,
  type AlertHit,
} from "../../../../lib/alertHits";
import { getWalletAges } from "../../../../lib/walletAge";
import { getWalletStats } from "../../../../lib/walletStats";
import { getSmartTags } from "../../../../lib/smartWallets";
import { getMarketMeta } from "../../../../lib/gamma";
import {
  analyzeTrades,
  fetchRecentTrades,
  type ActivityTrade,
  type WalletProfile,
} from "../../../../lib/walletProfile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

// The activity pull is 1-2 upstream requests; keep a short in-memory cache so
// tab refreshes / repeat visits don't refetch the same 2000 rows. Bounded:
// Map insertion order gives a cheap oldest-first eviction so distinct
// addresses can't grow the cache without limit.
const PROFILE_TTL_MS = 10 * 60_000;
const PROFILE_CACHE_MAX = 500;
const profileCache = new Map<
  string,
  { at: number; profile: WalletProfile; recent: ActivityTrade[] }
>();

function cacheProfile(
  address: string,
  entry: { at: number; profile: WalletProfile; recent: ActivityTrade[] },
) {
  while (profileCache.size >= PROFILE_CACHE_MAX) {
    const oldest = profileCache.keys().next().value;
    if (oldest == null) break;
    profileCache.delete(oldest);
  }
  profileCache.set(address, entry);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address: raw } = await params;
  const address = String(raw ?? "").toLowerCase();
  if (!ADDRESS_RE.test(address)) {
    return Response.json({ error: "invalid address" }, { status: 400 });
  }
  try {
    const db = openDb(process.env.DASH_DB ?? "data.sqlite");
    try {
      let cached = profileCache.get(address);
      if (!cached || Date.now() - cached.at >= PROFILE_TTL_MS) {
        const trades = await fetchRecentTrades(address);
        cached = {
          at: Date.now(),
          profile: analyzeTrades(trades),
          recent: trades.slice(0, 20),
        };
        cacheProfile(address, cached);
      }
      const { profile, recent } = cached;

      // Age + settled record + whitelist flag (all cached server-side).
      const [ages, stats] = await Promise.all([
        getWalletAges(db, [address]),
        getWalletStats(db, [address]),
      ]);
      const firstTs = ages[address] ?? null;
      const smart = getSmartTags(db, [address])[address] ?? null;

      // Category focus via gamma over the top markets (cheap, cached).
      const meta = await getMarketMeta(
        db,
        profile.topMarkets.map((m) => m.conditionId),
      );
      const catUsd = new Map<string, number>();
      const topMarkets = profile.topMarkets.map((m) => {
        const category = meta[m.conditionId]?.category ?? null;
        if (category) {
          catUsd.set(
            category,
            (catUsd.get(category) ?? 0) + m.buyUsd + m.sellUsd,
          );
        }
        return { ...m, category };
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
        profile: { ...profile, topMarkets },
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
