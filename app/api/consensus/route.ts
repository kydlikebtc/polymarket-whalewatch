import { openDb } from "../../../lib/db";
import { getTradesWindow } from "../../../lib/polymarket";
import { getAllSmartTags } from "../../../lib/smartWallets";
import { detectConsensus, type ConsensusGroup } from "../../../lib/consensus";
import { getMarketMeta } from "../../../lib/gamma";
import type { Trade } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The window fetch dominates cost (up to 20 pages), so cache it briefly keyed
// by hours; detection params are applied in memory per request.
const FLOOR_USD = 2000;
const CACHE_TTL_MS = 30_000;
const cache = new Map<
  number,
  { at: number; trades: Trade[]; truncated: boolean }
>();

const ALLOWED_HOURS = new Set([2, 6, 12]);

// A consensus group as served to the dashboard: plus the market's CURRENT
// price for the bought outcome, so the page can show "still followable".
type ConsensusView = ConsensusGroup & {
  currentPrice: number | null;
  category: string | null;
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
    const smartTags = getAllSmartTags(db);

    let base = cache.get(hours);
    if (!base || Date.now() - base.at >= CACHE_TTL_MS) {
      const sinceSec = Math.floor(Date.now() / 1000) - hours * 3600;
      const { trades, truncated } = await getTradesWindow({
        minUsd: FLOOR_USD,
        sinceSec,
      });
      base = { at: Date.now(), trades, truncated };
      cache.set(hours, base);
    }

    const groups = detectConsensus(base.trades, smartTags, {
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
      };
    });

    return Response.json({
      filters,
      smartCount: smartTags.size,
      truncated: base.truncated,
      groups: views,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[/api/consensus] failed:", message);
    return Response.json({
      filters,
      smartCount: 0,
      truncated: false,
      groups: [],
      error: message,
    });
  }
}
