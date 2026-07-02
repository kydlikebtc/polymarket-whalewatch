import { openDb } from "../../../lib/db";
import { getTradesWindowDeep } from "../../../lib/polymarket";
import { getAllSmartTags } from "../../../lib/smartWallets";
import { detectConsensus, type ConsensusGroup } from "../../../lib/consensus";
import { getMarketMeta } from "../../../lib/gamma";
import type { Trade } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The window fetch dominates cost (up to 20 pages), so cache it briefly keyed
// by hours; detection params are applied in memory per request. The cache
// holds the PROMISE so concurrent misses share one in-flight fetch instead of
// each hammering the upstream with their own multi-page pull. The DEEP fetch
// sweeps BUY/SELL separately so each side gets its own offset budget.
const FLOOR_USD = 2000;
const CACHE_TTL_MS = 30_000;
type WindowResult = {
  trades: Trade[];
  truncated: boolean;
  effectiveSinceSec: number;
};
const cache = new Map<number, { at: number; promise: Promise<WindowResult> }>();

function getWindowShared(hours: number): Promise<WindowResult> {
  const hit = cache.get(hours);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const sinceSec = Math.floor(Date.now() / 1000) - hours * 3600;
  const entry = {
    at: Date.now(),
    promise: getTradesWindowDeep({ minUsd: FLOOR_USD, sinceSec }),
  };
  // A failed fetch must not stay cached, or every request within the TTL
  // would re-reject without retrying.
  entry.promise.catch(() => {
    if (cache.get(hours) === entry) cache.delete(hours);
  });
  cache.set(hours, entry);
  return entry.promise;
}

const ALLOWED_HOURS = new Set([2, 6, 12]);

// A consensus group as served to the dashboard: plus the market's CURRENT
// price for the bought outcome, so the page can show "still followable".
type ConsensusView = ConsensusGroup & {
  currentPrice: number | null;
  category: string | null;
  // Settled market: the "follow gap" is moot — the page shows hit/miss instead.
  closed: boolean;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const hours = ALLOWED_HOURS.has(Number(url.searchParams.get("hours")))
    ? Number(url.searchParams.get("hours"))
    : 6;
  const minWallets = Math.max(
    2,
    Math.floor(Number(url.searchParams.get("minWallets")) || 2),
  );
  const rawPerWallet = Number(url.searchParams.get("minPerWalletUsd"));
  const minPerWalletUsd =
    Number.isFinite(rawPerWallet) && rawPerWallet > 0
      ? Math.floor(rawPerWallet)
      : 5000;
  const filters = { hours, minWallets, minPerWalletUsd };

  try {
    const db = openDb(process.env.DASH_DB ?? "data.sqlite");
    try {
      const smartTags = getAllSmartTags(db);
      const { trades, truncated, effectiveSinceSec } =
        await getWindowShared(hours);

      const groups = detectConsensus(trades, smartTags, {
        minWallets,
        minPerWalletUsd,
      });

      // Current outcome prices via gamma (cached; failures degrade to null).
      const meta = await getMarketMeta(
        db,
        groups.map((g) => g.conditionId),
      );
      const views: ConsensusView[] = groups.map((g) => {
        const m = meta[g.conditionId];
        const idx = m?.outcomes.findIndex(
          (o) => o.toLowerCase() === g.outcome.toLowerCase(),
        );
        const price =
          m && idx != null && idx >= 0 ? m.outcomePrices[idx] : undefined;
        return {
          ...g,
          currentPrice:
            typeof price === "number" && Number.isFinite(price) ? price : null,
          category: m?.category ?? null,
          closed: m?.closed ?? false,
        };
      });

      return Response.json({
        filters,
        smartCount: smartTags.size,
        truncated,
        effectiveSinceSec,
        groups: views,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[/api/consensus] failed:", message);
    return Response.json({
      filters,
      smartCount: 0,
      truncated: false,
      effectiveSinceSec: null,
      groups: [],
      error: message,
    });
  }
}
