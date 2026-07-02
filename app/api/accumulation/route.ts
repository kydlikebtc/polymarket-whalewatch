import { getTradesWindowDeep } from "../../../lib/polymarket";
import { aggregate, type AccumGroup } from "../../../lib/accumulate";
import type { Trade } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A wallet can build a large position via MANY small sub-$10k BUYs, evading
// single-large-trade monitoring. We surface that by aggregating the trade feed
// per (wallet, conditionId, outcome).
//
// The precision floor is the dollar size we pull at — a lower floor catches
// smaller chunks but covers a shorter real window (more rows per minute → the
// API's 3000-offset depth cap is reached sooner). The DEEP fetch sweeps
// BUY/SELL separately, so each side gets its own depth budget and the offset
// cap is handled inside getTradesWindow (no external page math needed).
const ALLOWED_FLOORS = new Set([500, 1000, 2000]);
const DEFAULT_FLOOR = 2000;
const MIN_BUY_COUNT = 3;
// Every BUY must be < this. The single-large-trade alert threshold — so a split
// group never double-counts a position that already fired a single-trade alert.
const SPLIT_CEILING = 10_000;

// Cache the BASE fetch keyed by floor:hours (NOT by minNetUsd — that's applied
// in memory). ~30s TTL so rapid filter changes don't hammer the API.
const CACHE_TTL_MS = 30_000;
const cache = new Map<
  string,
  { at: number; trades: Trade[]; truncated: boolean }
>();

const ALLOWED_HOURS = new Set([1, 2, 4]);

function clampHours(raw: string | null): number {
  const n = Number(raw);
  return ALLOWED_HOURS.has(n) ? n : 4;
}

function clampFloor(raw: string | null): number {
  const n = Number(raw);
  return ALLOWED_FLOORS.has(n) ? n : DEFAULT_FLOOR;
}

function parseMinNetUsd(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10_000;
}

type AccumStats = {
  groupCount: number;
  totalNetUsd: number;
  topNetUsd: number;
};

type AccumResponse = {
  filters: { floor: number; hours: number; minNetUsd: number };
  stats: AccumStats;
  truncated: boolean;
  // Oldest timestamp (seconds) in the base pull — lets the UI show the REAL
  // window covered, which can be shorter than `hours` once the page cap is hit.
  oldestTs: number | null;
  groups: AccumGroup[];
  error?: string;
};

// The oldest (minimum) timestamp across the base pull, or null if empty.
function oldestTimestamp(trades: Trade[]): number | null {
  let oldest: number | null = null;
  for (const t of trades) {
    if (oldest === null || t.timestamp < oldest) oldest = t.timestamp;
  }
  return oldest;
}

function computeStats(groups: AccumGroup[]): AccumStats {
  let totalNetUsd = 0;
  let topNetUsd = 0;
  for (const g of groups) {
    totalNetUsd += g.netUsd;
    if (g.netUsd > topNetUsd) topNetUsd = g.netUsd;
  }
  return { groupCount: groups.length, totalNetUsd, topNetUsd };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const hours = clampHours(url.searchParams.get("hours"));
  const floor = clampFloor(url.searchParams.get("floor"));
  const minNetUsd = parseMinNetUsd(url.searchParams.get("minNetUsd"));
  const filters = { floor, hours, minNetUsd };

  // Cache key includes the floor: different precision floors are different pulls.
  const baseKey = `${floor}:${hours}`;

  try {
    let base = cache.get(baseKey);
    if (!base || Date.now() - base.at >= CACHE_TTL_MS) {
      const sinceSec = Math.floor(Date.now() / 1000) - hours * 3600;
      const { trades, truncated } = await getTradesWindowDeep({
        minUsd: floor,
        sinceSec,
      });
      base = { at: Date.now(), trades, truncated };
      cache.set(baseKey, base);
    }

    const groups = aggregate(base.trades, {
      minNetUsd,
      minBuyCount: MIN_BUY_COUNT,
      splitCeiling: SPLIT_CEILING,
    });

    const body: AccumResponse = {
      filters,
      stats: computeStats(groups),
      truncated: base.truncated,
      oldestTs: oldestTimestamp(base.trades),
      groups,
    };
    return Response.json(body);
  } catch (error) {
    // Never 500 the UI: degrade to empty stats plus an error string the page can show.
    const message = error instanceof Error ? error.message : String(error);
    console.error("[/api/accumulation] live scan failed:", message);
    const body: AccumResponse = {
      filters,
      stats: { groupCount: 0, totalNetUsd: 0, topNetUsd: 0 },
      truncated: false,
      oldestTs: null,
      groups: [],
      error: message,
    };
    return Response.json(body);
  }
}
