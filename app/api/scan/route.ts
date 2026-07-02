import { getTradesWindowDeep } from "../../../lib/polymarket";
import { getEventCategories } from "../../../lib/gamma";
import { openDb } from "../../../lib/db";
import { notionalUsd } from "../../../lib/trades";
import type { Trade } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ScanTrade = {
  title: string;
  outcome: string;
  side: "BUY" | "SELL";
  usd: number;
  price: number;
  wallet: string;
  eventSlug: string;
  // Market slug (e.g. strait-of-hormuz-…) — not rendered, powers copy-to-clipboard.
  slug: string;
  txHash: string;
  ts: number;
  // Market category from the event's gamma tags (null = unknown).
  category: string | null;
};

type ScanStats = {
  count: number;
  totalUsd: number;
  buyUsd: number;
  sellUsd: number;
  maxTrade: ScanTrade | null;
};

type ScanResponse = {
  filters: { minUsd: number; side: "BUY" | "SELL" | "ALL"; hours: number };
  stats: ScanStats;
  truncated: boolean;
  trades: ScanTrade[];
  error?: string;
};

const EMPTY_STATS: ScanStats = {
  count: 0,
  totalUsd: 0,
  buyUsd: 0,
  sellUsd: 0,
  maxTrade: null,
};

// The Data API's server-side `filterAmount` is FAST when dense (low threshold)
// but the origin times out (~5.75s → 408) on high thresholds because matching
// trades are sparse and it scans huge history to fill a page. So we ALWAYS fetch
// at a low, fast floor and apply the user's (higher) amount + side filters in
// memory. The low-floor result is a superset of any higher threshold, so the
// filtered output is exact — and switching amount/side is instant (no refetch).
const SAFE_FLOOR = 10_000;

// Cache the BASE fetch keyed by floor:hours (NOT by amount/side — those are
// applied client-side). ~20s TTL so rapid filter changes don't hammer the API.
const CACHE_TTL_MS = 20_000;
const cache = new Map<
  string,
  { at: number; trades: Trade[]; truncated: boolean }
>();

const ALLOWED_HOURS = new Set([1, 6, 24]);

function clampHours(raw: string | null): number {
  const n = Number(raw);
  return ALLOWED_HOURS.has(n) ? n : 24;
}

function parseSide(raw: string | null): "BUY" | "SELL" | "ALL" {
  return raw === "BUY" || raw === "SELL" ? raw : "ALL";
}

function parseMinUsd(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10_000;
}

function toScanTrade(
  t: Trade,
  categories: Record<string, string | null>,
): ScanTrade {
  return {
    title: t.title,
    outcome: t.outcome,
    side: t.side,
    usd: notionalUsd(t),
    price: t.price,
    wallet: t.proxyWallet,
    eventSlug: t.eventSlug,
    slug: t.slug,
    txHash: t.transactionHash,
    ts: t.timestamp,
    category: categories[t.eventSlug] ?? null,
  };
}

function computeStats(trades: ScanTrade[]): ScanStats {
  let totalUsd = 0;
  let buyUsd = 0;
  let sellUsd = 0;
  let maxTrade: ScanTrade | null = null;
  for (const t of trades) {
    totalUsd += t.usd;
    if (t.side === "BUY") buyUsd += t.usd;
    else sellUsd += t.usd;
    if (!maxTrade || t.usd > maxTrade.usd) maxTrade = t;
  }
  return { count: trades.length, totalUsd, buyUsd, sellUsd, maxTrade };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const minUsd = parseMinUsd(url.searchParams.get("minUsd"));
  const side = parseSide(url.searchParams.get("side"));
  const hours = clampHours(url.searchParams.get("hours"));
  const filters = { minUsd, side, hours };

  // Fetch at a fast floor; never ask the origin for a slow high-amount query.
  const baseFloor = Math.min(minUsd, SAFE_FLOOR);
  const baseKey = `${baseFloor}:${hours}`;

  try {
    let base = cache.get(baseKey);
    if (!base || Date.now() - base.at >= CACHE_TTL_MS) {
      const sinceSec = Math.floor(Date.now() / 1000) - hours * 3600;
      // Deep fetch sweeps BUY and SELL separately (each side gets its own
      // API depth budget); the user's side filter still applies in memory.
      const { trades, truncated } = await getTradesWindowDeep({
        minUsd: baseFloor,
        sinceSec,
      });
      base = { at: Date.now(), trades, truncated };
      cache.set(baseKey, base);
    }

    // Category enrichment via event tags — permanently cached per slug, so
    // only first-seen events cost a gamma call. Failures degrade to null.
    let categories: Record<string, string | null> = {};
    const db = openDb(process.env.DASH_DB ?? "data.sqlite");
    try {
      categories = await getEventCategories(
        db,
        base.trades.map((t) => t.eventSlug),
      );
    } finally {
      db.close();
    }

    const filtered = base.trades
      .map((t) => toScanTrade(t, categories))
      .filter((t) => t.usd >= minUsd && (side === "ALL" || t.side === side));

    const body: ScanResponse = {
      filters,
      stats: computeStats(filtered),
      truncated: base.truncated,
      trades: filtered,
    };
    return Response.json(body);
  } catch (error) {
    // Never 500 the UI: degrade to empty stats plus an error string the page can show.
    const message = error instanceof Error ? error.message : String(error);
    console.error("[/api/scan] live scan failed:", message);
    const body: ScanResponse = {
      filters,
      stats: EMPTY_STATS,
      truncated: false,
      trades: [],
      error: message,
    };
    return Response.json(body);
  }
}
