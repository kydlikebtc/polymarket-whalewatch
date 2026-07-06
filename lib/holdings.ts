import { z } from "zod";

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
