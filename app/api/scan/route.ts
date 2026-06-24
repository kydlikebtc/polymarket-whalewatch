import { getTradesWindow } from "../../../lib/polymarket";
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
  txHash: string;
  ts: number;
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

// Module-level TTL cache (~20s) keyed by minUsd:side:hours. The live Data API is
// the same for every visitor, so caching avoids hammering it when a user clicks
// rapidly through filters. Cache is per-process; force-dynamic only disables
// Next's own caching, so we do it explicitly here.
const CACHE_TTL_MS = 20_000;
const cache = new Map<string, { at: number; body: ScanResponse }>();

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

function toScanTrade(t: Trade): ScanTrade {
  return {
    title: t.title,
    outcome: t.outcome,
    side: t.side,
    usd: notionalUsd(t),
    price: t.price,
    wallet: t.proxyWallet,
    eventSlug: t.eventSlug,
    txHash: t.transactionHash,
    ts: t.timestamp,
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
  const key = `${minUsd}:${side}:${hours}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return Response.json(hit.body);
  }

  try {
    const sinceSec = Math.floor(Date.now() / 1000) - hours * 3600;
    const { trades: raw, truncated } = await getTradesWindow({
      minUsd,
      side: side === "ALL" ? undefined : side,
      sinceSec,
    });
    const trades = raw.map(toScanTrade);
    const body: ScanResponse = {
      filters,
      stats: computeStats(trades),
      truncated,
      trades,
    };
    cache.set(key, { at: Date.now(), body });
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
