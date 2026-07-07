import { z } from "zod";
import { fetchWithRetry } from "./fetchWithRetry";

const DATA_API = "https://data-api.polymarket.com";
const PAGE_SIZE = 50;

// Drop sub-dollar leftovers so the list shows real positions, not dust.
const DUST_USD = 1;

// The display slice of a /positions row. Same endpoint fetchResolvedOpenPositions
// uses, but here we keep the LIVE (unresolved) rows — the wallet's active book.
const HoldingRowSchema = z.object({
  title: z.string(),
  slug: z.string().optional().default(""), // per-MARKET slug (gamma /markets?slug=)
  eventSlug: z.string().optional().default(""),
  outcome: z.string(),
  size: z.number(), // shares held
  avgPrice: z.number(), // entry (cost) price
  curPrice: z.number(), // current mark
  currentValue: z.number(), // USD, mark-to-market
  cashPnl: z.number(), // USD unrealized
  percentPnl: z.number(), // % unrealized
  redeemable: z.boolean(), // true = market resolved (decided), awaiting redeem
  endDate: z.string().nullable().optional(),
});

export interface Holding {
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  endDate: string | null;
}

export interface HoldingsSummary {
  holdings: Holding[]; // LIVE positions, sorted by currentValue desc
  totalValue: number;
  totalCashPnl: number;
  count: number;
  truncated: boolean;
}

/**
 * Pure: raw /positions rows → LIVE (unresolved) holdings, sorted by current
 * value desc, dust dropped, with portfolio totals. `redeemable: true` rows are
 * resolved (decided, awaiting redeem) and excluded — this is the wallet's
 * ACTIVE book (what it is currently betting on), not its settled history.
 */
export function parseHoldings(
  rawRows: unknown[],
  truncated = false,
): HoldingsSummary {
  const holdings: Holding[] = [];
  for (const row of rawRows) {
    const parsed = HoldingRowSchema.safeParse(row);
    if (!parsed.success) continue;
    const r = parsed.data;
    if (r.redeemable) continue; // resolved → not a live holding
    if (r.currentValue < DUST_USD) continue; // dust
    holdings.push({
      title: r.title,
      slug: r.slug ?? "",
      eventSlug: r.eventSlug ?? "",
      outcome: r.outcome,
      size: r.size,
      avgPrice: r.avgPrice,
      curPrice: r.curPrice,
      currentValue: r.currentValue,
      cashPnl: r.cashPnl,
      percentPnl: r.percentPnl,
      endDate: r.endDate ?? null,
    });
  }
  holdings.sort((a, b) => b.currentValue - a.currentValue);
  return {
    holdings,
    totalValue: holdings.reduce((s, h) => s + h.currentValue, 0),
    totalCashPnl: holdings.reduce((s, h) => s + h.cashPnl, 0),
    count: holdings.length,
    truncated,
  };
}

// One wallet's CURRENT position in a specific market outcome — the "stock"
// (what it holds now) that complements the consensus/disagreement "flow" (what
// it net-bought in the window). Used as extra reference on the expanded rows.
export interface MarketPosition {
  outcome: string;
  size: number; // shares held now
  avgPrice: number;
  curPrice: number;
  currentValue: number; // USD, mark-to-market
  cashPnl: number; // USD unrealized
  percentPnl: number; // % unrealized
}

const MarketPosRowSchema = z.object({
  outcome: z.string(),
  size: z.number(),
  avgPrice: z.number(),
  curPrice: z.number(),
  currentValue: z.number(),
  cashPnl: z.number(),
  percentPnl: z.number(),
});

/**
 * Pure: raw /positions rows (already market-filtered) → a map of
 * outcome(lowercased) → MarketPosition. A wallet holding both sides of a market
 * (hedger) yields two entries; a wallet that fully sold out yields none. Dust
 * (current value < $1 and < 1 share) is dropped so "cleared" reads as cleared.
 */
export function parseMarketPositions(
  rawRows: unknown[],
): Record<string, MarketPosition> {
  const out: Record<string, MarketPosition> = {};
  for (const row of rawRows) {
    const parsed = MarketPosRowSchema.safeParse(row);
    if (!parsed.success) continue;
    const r = parsed.data;
    if (r.currentValue < DUST_USD && r.size < 1) continue;
    out[r.outcome.toLowerCase()] = {
      outcome: r.outcome,
      size: r.size,
      avgPrice: r.avgPrice,
      curPrice: r.curPrice,
      currentValue: r.currentValue,
      cashPnl: r.cashPnl,
      percentPnl: r.percentPnl,
    };
  }
  return out;
}

// Fetch one wallet's CURRENT positions in a single market via the server-side
// market filter (?market=<conditionId>) — one cheap call, no pagination (a
// wallet holds at most a couple of outcomes per market).
export async function fetchWalletMarketPositions(
  wallet: string,
  conditionId: string,
): Promise<Record<string, MarketPosition>> {
  const url = `${DATA_API}/positions?user=${encodeURIComponent(wallet)}&market=${encodeURIComponent(conditionId)}`;
  // Retry transient 5xx/429 — a big market fans out many of these at once, so a
  // momentary rate-limit must not silently degrade a wallet's holding to "—".
  const res = await fetchWithRetry(url, {
    timeoutMs: 8000,
    headers: { "User-Agent": "polymarket-monitor" },
    label: "fetchWalletMarketPositions",
  });
  if (!res.ok) throw new Error(`fetchWalletMarketPositions ${res.status}`);
  const body = await res.json();
  return parseMarketPositions(Array.isArray(body) ? body : []);
}

// Fetch a wallet's current holdings from data-api /positions (offset-paginated,
// newest first). Same shape as fetchResolvedOpenPositions but keeps LIVE rows.
export async function fetchCurrentHoldings(
  wallet: string,
  opts: { maxPages?: number } = {},
): Promise<HoldingsSummary> {
  const { maxPages = 8 } = opts;
  const raw: unknown[] = [];
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const url = `${DATA_API}/positions?user=${encodeURIComponent(wallet)}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "polymarket-monitor" },
    });
    if (!res.ok) throw new Error(`fetchCurrentHoldings ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body) || body.length === 0) break;
    raw.push(...body);
    if (body.length < PAGE_SIZE) break;
    if (page === maxPages - 1) truncated = true;
  }
  return parseHoldings(raw, truncated);
}
