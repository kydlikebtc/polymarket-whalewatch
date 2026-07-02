import type { DB } from "./db";

const GAMMA_API = "https://gamma-api.polymarket.com";

// The markets endpoint accepts repeated condition_ids params; keep chunks small
// so URLs stay short and one bad chunk fails independently.
const CHUNK = 20;

// Normalized market metadata for enrichment. Field-shape notes (verified live):
// `liquidity` is a STRING but `liquidityNum` is a number; `outcomes` and
// `outcomePrices` are stringified JSON arrays; `category` can be null.
export interface MarketMeta {
  conditionId: string;
  volume24hr: number | null;
  liquidity: number | null;
  endDate: string | null; // ISO
  closed: boolean;
  category: string | null;
  outcomes: string[];
  outcomePrices: number[];
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && Number.isFinite(Number(v))
      ? Number(v)
      : null;

const jsonArr = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

// Lenient row normalization — gamma rows vary across market types, so missing
// fields degrade to null instead of dropping the whole market.
function normalize(row: Record<string, unknown>): MarketMeta | null {
  const conditionId =
    typeof row.conditionId === "string" ? row.conditionId : null;
  if (!conditionId) return null;
  return {
    conditionId,
    volume24hr: num(row.volume24hr),
    liquidity: num(row.liquidityNum) ?? num(row.liquidity),
    endDate: typeof row.endDate === "string" ? row.endDate : null,
    closed: row.closed === true,
    category: typeof row.category === "string" ? row.category : null,
    outcomes: jsonArr(row.outcomes).map(String),
    outcomePrices: jsonArr(row.outcomePrices)
      .map((p) => num(p))
      .map((p) => p ?? NaN),
  };
}

export async function fetchMarketMeta(
  conditionIds: string[],
): Promise<Record<string, MarketMeta>> {
  const distinct = [...new Set(conditionIds.filter(Boolean))];
  const out: Record<string, MarketMeta> = {};
  for (let i = 0; i < distinct.length; i += CHUNK) {
    const chunk = distinct.slice(i, i + CHUNK);
    const qs = chunk.map((c) => `condition_ids=${c}`).join("&");
    const res = await fetch(`${GAMMA_API}/markets?${qs}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "polymarket-monitor" },
    });
    if (!res.ok) throw new Error(`fetchMarketMeta ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw)) continue;
    for (const row of raw) {
      const meta = normalize(row as Record<string, unknown>);
      if (meta) out[meta.conditionId] = meta;
    }
  }
  return out;
}

const DEFAULT_TTL_SEC = 3600;

/**
 * SQLite-cached market metadata keyed by conditionId (market_meta table).
 * Open markets refresh hourly (volume/liquidity drift); CLOSED markets are
 * final — their cache never expires, which is what lets the settlement
 * backfill treat gamma as a permanent resolution source.
 * Fetch errors degrade to "missing" (absent key) so callers always get a map.
 */
export async function getMarketMeta(
  db: DB,
  conditionIds: string[],
  opts: {
    ttlSec?: number;
    fetcher?: typeof fetchMarketMeta;
    nowSec?: number;
  } = {},
): Promise<Record<string, MarketMeta>> {
  const {
    ttlSec = DEFAULT_TTL_SEC,
    fetcher = fetchMarketMeta,
    nowSec = Math.floor(Date.now() / 1000),
  } = opts;
  const distinct = [...new Set(conditionIds.filter(Boolean))];
  const sel = db.prepare(
    "SELECT meta_json, fetched_at FROM market_meta WHERE condition_id = ?",
  );
  const ins = db.prepare(
    "INSERT OR REPLACE INTO market_meta (condition_id, meta_json, fetched_at) VALUES (?, ?, ?)",
  );
  const out: Record<string, MarketMeta> = {};
  const misses: string[] = [];
  for (const cid of distinct) {
    const row = sel.get(cid) as
      { meta_json: string; fetched_at: number } | undefined;
    if (!row) {
      misses.push(cid);
      continue;
    }
    try {
      const meta = JSON.parse(row.meta_json) as MarketMeta;
      // Closed = resolved = immutable; only open markets go stale.
      if (meta.closed || nowSec - row.fetched_at < ttlSec) {
        out[cid] = meta;
      } else {
        misses.push(cid);
      }
    } catch {
      misses.push(cid);
    }
  }
  if (misses.length > 0) {
    try {
      const fetched = await fetcher(misses);
      for (const [cid, meta] of Object.entries(fetched)) {
        ins.run(cid, JSON.stringify(meta), nowSec);
        out[cid] = meta;
      }
    } catch (e) {
      console.warn("[gamma] meta fetch failed (degrading to cached-only):", e);
    }
  }
  return out;
}

// Per-trade market context derived from meta — the "what does this money mean
// for THIS market" layer attached to alerts.
export interface TradeMarketContext {
  impact24h: number | null; // tradeUsd / 24h volume
  liquidityShare: number | null; // tradeUsd / market liquidity
  liquidity: number | null;
  volume24hr: number | null;
  hoursToEnd: number | null; // null when closed or endDate missing/past-unknown
  category: string | null;
}

export function tradeMarketContext(
  tradeUsd: number,
  meta: MarketMeta | undefined,
  nowSec: number,
): TradeMarketContext | null {
  if (!meta) return null;
  const endMs = meta.endDate ? Date.parse(meta.endDate) : NaN;
  const hoursToEnd =
    !meta.closed && Number.isFinite(endMs)
      ? Math.max(0, (endMs / 1000 - nowSec) / 3600)
      : null;
  return {
    impact24h:
      meta.volume24hr && meta.volume24hr > 0
        ? tradeUsd / meta.volume24hr
        : null,
    liquidityShare:
      meta.liquidity && meta.liquidity > 0 ? tradeUsd / meta.liquidity : null,
    liquidity: meta.liquidity,
    volume24hr: meta.volume24hr,
    hoursToEnd,
    category: meta.category,
  };
}
