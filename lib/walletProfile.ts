import { z } from "zod";

const DATA_API = "https://data-api.polymarket.com";

// Verified live limits for /activity: limit caps at 1000, offset hard-caps at
// 3000 (400 beyond) — so "recent 2000 trades" is exactly two max-size pages.
const PAGE_LIMIT = 1000;

// One TRADE row from /activity (usdcSize is USD — verified size*price≈usdcSize).
const ActivityTradeSchema = z.object({
  timestamp: z.number(),
  conditionId: z.string(),
  side: z.enum(["BUY", "SELL"]),
  size: z.number(),
  usdcSize: z.number(),
  price: z.number(),
  title: z.string().default(""),
  outcome: z.string().default(""),
  eventSlug: z.string().default(""),
  transactionHash: z.string().default(""),
});
export type ActivityTrade = z.infer<typeof ActivityTradeSchema>;

// One /activity page with a retry. The _cb param busts the CDN's per-URL cache
// (it can pin a mis-sorted origin response — sortBy=TIMESTAMP is REQUIRED, and
// even then a poisoned cached copy must be avoided), which means every call
// hits the origin: measured ~3s per max-size page, occasionally slower — hence
// the generous timeout plus one retry.
async function fetchActivityPage(
  wallet: string,
  offset: number,
): Promise<unknown[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cb =
      Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
    const url =
      `${DATA_API}/activity?user=${encodeURIComponent(wallet)}&type=TRADE` +
      `&sortBy=TIMESTAMP&sortDirection=DESC&limit=${PAGE_LIMIT}&offset=${offset}&_cb=${cb}`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "polymarket-monitor" },
      });
      if (!res.ok) throw new Error(`fetchRecentTrades ${res.status}`);
      const raw = await res.json();
      return Array.isArray(raw) ? raw : [];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function fetchRecentTrades(
  wallet: string,
): Promise<ActivityTrade[]> {
  // Both pages fire CONCURRENTLY (uncached origin pages are ~3s each — serial
  // was the dossier's whole latency budget). Page 2 costs one wasted request
  // for small wallets and is discarded unless page 1 came back full.
  const [p0, p1] = await Promise.all([
    fetchActivityPage(wallet, 0),
    fetchActivityPage(wallet, PAGE_LIMIT),
  ]);
  const rows = p0.length === PAGE_LIMIT ? [...p0, ...p1] : p0;
  const out: ActivityTrade[] = [];
  for (const row of rows) {
    const parsed = ActivityTradeSchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export interface PriceBand {
  from: number; // inclusive
  to: number; // exclusive (last band includes 1)
  buyUsd: number;
  buyCount: number;
}

export interface MarketFocus {
  conditionId: string;
  title: string;
  eventSlug: string;
  buyUsd: number;
  sellUsd: number;
  netUsd: number;
  trades: number;
  lastTs: number;
}

export interface WalletProfile {
  tradeCount: number;
  buyUsd: number;
  sellUsd: number;
  avgTradeUsd: number;
  // Share of BUY trades under $1k — high values signal a splitter/accumulator.
  smallBuyShare: number | null;
  priceBands: PriceBand[]; // 10 bands over BUY trades
  topMarkets: MarketFocus[]; // by gross traded USD
  firstTs: number | null; // oldest trade in the analyzed window
  lastTs: number | null;
}

const BAND_COUNT = 10;
const SMALL_BUY_USD = 1000;
const TOP_MARKETS = 8;

// Pure analysis over the recent-trade window: where does this wallet play,
// at what odds, and does it build positions in small clips?
export function analyzeTrades(trades: ActivityTrade[]): WalletProfile {
  const priceBands: PriceBand[] = Array.from(
    { length: BAND_COUNT },
    (_, i) => ({
      from: i / BAND_COUNT,
      to: (i + 1) / BAND_COUNT,
      buyUsd: 0,
      buyCount: 0,
    }),
  );
  const markets = new Map<string, MarketFocus>();
  let buyUsd = 0;
  let sellUsd = 0;
  let buyCount = 0;
  let smallBuys = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const t of trades) {
    if (firstTs === null || t.timestamp < firstTs) firstTs = t.timestamp;
    if (lastTs === null || t.timestamp > lastTs) lastTs = t.timestamp;
    if (t.side === "BUY") {
      buyUsd += t.usdcSize;
      buyCount++;
      if (t.usdcSize < SMALL_BUY_USD) smallBuys++;
      const idx = Math.min(
        BAND_COUNT - 1,
        Math.max(0, Math.floor(t.price * BAND_COUNT)),
      );
      priceBands[idx].buyUsd += t.usdcSize;
      priceBands[idx].buyCount++;
    } else {
      sellUsd += t.usdcSize;
    }
    let m = markets.get(t.conditionId);
    if (!m) {
      m = {
        conditionId: t.conditionId,
        title: t.title,
        eventSlug: t.eventSlug,
        buyUsd: 0,
        sellUsd: 0,
        netUsd: 0,
        trades: 0,
        lastTs: t.timestamp,
      };
      markets.set(t.conditionId, m);
    }
    if (t.side === "BUY") m.buyUsd += t.usdcSize;
    else m.sellUsd += t.usdcSize;
    m.trades++;
    if (t.timestamp > m.lastTs) m.lastTs = t.timestamp;
  }

  const topMarkets = [...markets.values()]
    .map((m) => ({ ...m, netUsd: m.buyUsd - m.sellUsd }))
    .sort((a, b) => b.buyUsd + b.sellUsd - (a.buyUsd + a.sellUsd))
    .slice(0, TOP_MARKETS);

  return {
    tradeCount: trades.length,
    buyUsd,
    sellUsd,
    avgTradeUsd: trades.length > 0 ? (buyUsd + sellUsd) / trades.length : 0,
    smallBuyShare: buyCount > 0 ? smallBuys / buyCount : null,
    priceBands,
    topMarkets,
    firstTs,
    lastTs,
  };
}
