import { openDb } from "../../../lib/db";
import { createPromiseCache } from "../../../lib/promiseCache";
import { guardExpensive } from "../../../lib/apiGuard";
import { getTradesWindowDeep } from "../../../lib/polymarket";
import { getAllSmartTags } from "../../../lib/smartWallets";
import { detectConsensus, type ConsensusGroup } from "../../../lib/consensus";
import {
  DEFAULT_DISAGREEMENT,
  detectDisagreement,
  type DisagreementMarket,
} from "../../../lib/disagreement";
import { detectSmartExits } from "../../../lib/smartExit";
import { excludeContestedFromConsensus } from "../../../lib/marketSignals";
import { getEventCategories, getMarketMeta } from "../../../lib/gamma";
import type { Trade } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The window fetch dominates cost (up to 20 pages), so cache it briefly keyed
// by hours; detection params are applied in memory per request. Promise-cached
// (lib/promiseCache) so concurrent misses share one in-flight fetch instead of
// each hammering the upstream with their own multi-page pull. The DEEP fetch
// sweeps BUY/SELL separately so each side gets its own offset budget.
const FLOOR_USD = 2000;
const CACHE_TTL_MS = 30_000;
// currentPrice is THE "still followable" actionability signal on this page —
// the default market_meta TTL (1h) can serve an hour-stale "current" price
// and misdirect a follow/skip decision. Refresh on the same order as the 30s
// window cache; closed markets short-circuit inside getMarketMeta and never
// refetch regardless.
const CURRENT_PRICE_TTL_SEC = 60;
type WindowResult = {
  trades: Trade[];
  truncated: boolean;
  effectiveSinceSec: number;
};
const windowCache = createPromiseCache<WindowResult>(CACHE_TTL_MS);

function getWindowShared(hours: number): Promise<WindowResult> {
  return windowCache(String(hours), () => {
    const sinceSec = Math.floor(Date.now() / 1000) - hours * 3600;
    return getTradesWindowDeep({ minUsd: FLOOR_USD, sinceSec });
  });
}

const ALLOWED_HOURS = new Set([2, 6, 12]);

// A consensus group as served to the dashboard: plus the market's CURRENT
// price for the bought outcome, so the page can show "still followable".
type ConsensusView = ConsensusGroup & {
  currentPrice: number | null;
  category: string | null;
  // 二级分类(体育联盟/加密资产等;null = 无/未知),展示合成「体育·NBA」。
  subcategory: string | null;
  // Settled market: the "follow gap" is moot — the page shows hit/miss instead.
  closed: boolean;
};

// A disagreement side enriched with the outcome's CURRENT price.
type SideView = DisagreementMarket["sides"][number] & {
  currentPrice: number | null;
};
type DisagreementView = Omit<DisagreementMarket, "sides"> & {
  sides: SideView[];
  category: string | null;
  subcategory: string | null;
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

  // A cache MISS is a two-sided multi-page window pull sharing the engine's
  // data-api budget. The 30s promise cache collapses concurrent misses but
  // does nothing against a client walking distinct parameter combinations,
  // so the public-deployment limiter is the actual ceiling.
  const limited = guardExpensive(
    req,
    "consensus",
    { perIp: 60, global: 300 },
    {
      filters,
      smartCount: 0,
      truncated: false,
      effectiveSinceSec: null,
      groups: [],
      disagreement: [],
      exits: [],
    },
  );
  if (limited) return limited;

  try {
    const db = openDb(process.env.DASH_DB ?? "data.sqlite");
    try {
      const smartTags = getAllSmartTags(db);
      const { trades, truncated, effectiveSinceSec } =
        await getWindowShared(hours);

      // Detect both signals over the same window/pool, then make them mutually
      // exclusive: a market with smart money on opposing outcomes is a
      // DISAGREEMENT, not two one-sided "consensuses". The per-side floor reuses
      // the same minPerWalletUsd control so both views tune together.
      const rawGroups = detectConsensus(trades, smartTags, {
        minWallets,
        minPerWalletUsd,
      });
      const disagreements = detectDisagreement(trades, smartTags, {
        ...DEFAULT_DISAGREEMENT,
        minPerSideUsd: minPerWalletUsd,
      });
      const groups = excludeContestedFromConsensus(rawGroups, disagreements);
      // 离场(2026-08-28 八件套):同一份双侧窗口的卖侧读数。复用同一
      // minWallets/minPerWalletUsd 控件 —— 三个视图一把尺同调。
      const exits = detectSmartExits(trades, smartTags, {
        minWallets,
        minPerWalletUsd,
      });

      // Current outcome prices via gamma (cached; failures degrade to null) for
      // the UNION of both lists. Categories come from EVENT TAGS — the
      // market-level category field is null for most modern markets.
      const conditionIds = [
        ...new Set([
          ...groups.map((g) => g.conditionId),
          ...disagreements.map((d) => d.conditionId),
        ]),
      ];
      const eventSlugs = [
        ...new Set([
          ...groups.map((g) => g.eventSlug),
          ...disagreements.map((d) => d.eventSlug),
        ]),
      ];
      const [meta, categories] = await Promise.all([
        getMarketMeta(db, conditionIds, { ttlSec: CURRENT_PRICE_TTL_SEC }),
        getEventCategories(db, eventSlugs),
      ]);

      const priceOf = (conditionId: string, outcome: string): number | null => {
        const m = meta[conditionId];
        const idx = m?.outcomes.findIndex(
          (o) => o.toLowerCase() === outcome.toLowerCase(),
        );
        const price =
          m && idx != null && idx >= 0 ? m.outcomePrices[idx] : undefined;
        return typeof price === "number" && Number.isFinite(price)
          ? price
          : null;
      };

      const views: ConsensusView[] = groups.map((g) => ({
        ...g,
        currentPrice: priceOf(g.conditionId, g.outcome),
        category: categories[g.eventSlug]?.category ?? null,
        subcategory: categories[g.eventSlug]?.subcategory ?? null,
        closed: meta[g.conditionId]?.closed ?? false,
      }));

      const disagreement: DisagreementView[] = disagreements.map((d) => ({
        ...d,
        sides: d.sides.map((s) => ({
          ...s,
          currentPrice: priceOf(d.conditionId, s.outcome),
        })),
        category: categories[d.eventSlug]?.category ?? null,
        subcategory: categories[d.eventSlug]?.subcategory ?? null,
        closed: meta[d.conditionId]?.closed ?? false,
      }));

      return Response.json({
        filters,
        smartCount: smartTags.size,
        truncated,
        effectiveSinceSec,
        groups: views,
        disagreement,
        exits,
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
      disagreement: [],
      exits: [],
      error: message,
    });
  }
}
