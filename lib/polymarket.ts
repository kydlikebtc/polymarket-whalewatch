import { TradeSchema, type Trade } from "./types";
import { dedupKey } from "./trades";
import { z } from "zod";
const DATA_API = "https://data-api.polymarket.com";

// The public Data API (Cloudflare front) intermittently returns 408/5xx on
// expensive queries (high filterAmount + side filter) — the origin times out
// around ~5.75s. These are transient: a retry almost always succeeds (and warms
// the CDN, so the next attempt is fast). Bounded exponential backoff so a
// probabilistic 408 never surfaces to the user as a scan failure.
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
async function fetchTrades(
  url: string,
  attempts = 4,
  baseDelayMs = 300,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (res.ok || !TRANSIENT_STATUS.has(res.status) || i === attempts - 1) {
        return res;
      }
      console.warn(
        `[fetchTrades] transient ${res.status}, retry ${i + 1}/${attempts}`,
      );
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) throw e;
      console.warn(`[fetchTrades] fetch error, retry ${i + 1}/${attempts}`);
    }
    await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
  }
  if (lastErr) throw lastErr;
  throw new Error("fetchTrades: retries exhausted");
}

export async function getLargeTrades(
  minUsd: number,
  limit = 500,
): Promise<Trade[]> {
  const url = `${DATA_API}/trades?filterType=CASH&filterAmount=${minUsd}&takerOnly=true&limit=${limit}`;
  const res = await fetchTrades(url);
  if (!res.ok) throw new Error(`getLargeTrades ${res.status}`);
  const raw = await res.json();
  const parsed = z.array(TradeSchema).safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    console.warn(
      `[getLargeTrades] response shape mismatch (falling back to raw): ${issues}`,
    );
    return raw as Trade[];
  }
  if (parsed.data.length === limit) {
    // Full page: more than `limit` large trades may exist this cycle and would be missed.
    // Single-page fetch is the MVP choice; offset pagination is a P2+ item (design §5).
    console.warn(
      `[getLargeTrades] full page (${limit} rows) — some large trades this cycle may be missed`,
    );
  }
  return parsed.data;
}

export interface TradesWindowQuery {
  minUsd: number;
  side?: "BUY" | "SELL";
  sinceSec: number;
  maxPages?: number;
}

// Verified live: /trades offset hard-caps at 3000 — deeper requests fail with
// HTTP 400 "max historical activity offset of 3000 exceeded" (same cap as
// /activity). Dense windows (low floor × long window) DO reach it, so the
// pagination below treats the cap as "window truncated", never as a failure.
const MAX_TRADES_OFFSET = 3000;

/**
 * Fetch all large trades newer than `sinceSec`, paginating by offset because the
 * Data API has no time-range param. Rows come back newest-first, so we stop as
 * soon as we see a row older than the cutoff (window edge reached → complete).
 * `truncated:true` means we hit `maxPages` OR the API's hard offset cap before
 * reaching the edge, so older in-window trades may still exist and are NOT
 * included — the fetched prefix is still a complete, self-consistent
 * (shorter) window.
 */
export async function getTradesWindow({
  minUsd,
  side,
  sinceSec,
  maxPages = 20,
}: TradesWindowQuery): Promise<{ trades: Trade[]; truncated: boolean }> {
  const out: Trade[] = [];
  for (let page = 0; page < maxPages; page++) {
    const offset = page * 500;
    if (offset > MAX_TRADES_OFFSET) {
      console.warn(
        `[getTradesWindow] offset cap ${MAX_TRADES_OFFSET} reached (${out.length} rows) — window truncated`,
      );
      return { trades: out, truncated: true };
    }
    const sideParam = side ? `&side=${side}` : "";
    const url = `${DATA_API}/trades?filterType=CASH&filterAmount=${minUsd}&takerOnly=true&limit=500&offset=${offset}${sideParam}`;
    const res = await fetchTrades(url);
    if (!res.ok) {
      // A mid-pagination 400 is the deep-offset cap (possibly moved server-side):
      // degrade to the fetched prefix instead of failing the whole scan. A 400
      // on the FIRST page is a genuinely bad request and still throws.
      if (res.status === 400 && page > 0) {
        console.warn(
          `[getTradesWindow] offset rejected at page ${page} (${out.length} rows) — window truncated`,
        );
        return { trades: out, truncated: true };
      }
      throw new Error(`getTradesWindow ${res.status}`);
    }
    const raw = await res.json();
    const parsed = z.array(TradeSchema).safeParse(raw);
    const rows: Trade[] = parsed.success ? parsed.data : (raw as Trade[]);
    if (rows.length === 0) return { trades: out, truncated: false };
    for (const t of rows) {
      // Newest-first ordering: the first older-than-cutoff row marks the window edge.
      if (t.timestamp < sinceSec) return { trades: out, truncated: false };
      out.push(t);
    }
    if (rows.length < 500) return { trades: out, truncated: false }; // last available page
  }
  // Hit the page cap before reaching the window edge — more in-window rows may exist.
  console.warn(
    `[getTradesWindow] hit maxPages=${maxPages} (${out.length} rows) — window may be incomplete`,
  );
  return { trades: out, truncated: true };
}

export interface DeepWindowResult {
  trades: Trade[];
  truncated: boolean;
  // Start of the COMPLETE merged window. Equals the requested sinceSec when
  // the full window was covered; later (more recent) when depth ran out.
  effectiveSinceSec: number;
}

/**
 * Deeper window fetch: BUY and SELL are swept SEPARATELY so each side gets its
 * own 3000-offset budget (verified live: the cap is per-query), roughly
 * doubling how far back a dense window can reach — the sparser SELL side often
 * covers the full window even when BUY caps out.
 *
 * The merged result is trimmed to the newest truncation edge so accounting
 * stays complete for BOTH sides of every wallet (a wallet's sells are never
 * silently missing from a window that includes its buys). Overlapping
 * pagination re-serves are deduped.
 */
export async function getTradesWindowDeep({
  minUsd,
  sinceSec,
  maxPages = 20,
}: Omit<TradesWindowQuery, "side">): Promise<DeepWindowResult> {
  const [buy, sell] = await Promise.all([
    getTradesWindow({ minUsd, side: "BUY", sinceSec, maxPages }),
    getTradesWindow({ minUsd, side: "SELL", sinceSec, maxPages }),
  ]);

  // The complete merged window starts at the NEWEST truncation edge: beyond
  // it one side is blind, so its rows are dropped to keep netting honest.
  let effectiveSinceSec = sinceSec;
  for (const r of [buy, sell]) {
    if (r.truncated && r.trades.length > 0) {
      const oldest = r.trades[r.trades.length - 1].timestamp;
      if (oldest > effectiveSinceSec) effectiveSinceSec = oldest;
    }
  }

  const seen = new Set<string>();
  const trades: Trade[] = [];
  for (const t of [...buy.trades, ...sell.trades]) {
    if (t.timestamp < effectiveSinceSec) continue;
    const k = dedupKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    trades.push(t);
  }
  trades.sort((a, b) => b.timestamp - a.timestamp);
  return {
    trades,
    truncated: effectiveSinceSec > sinceSec,
    effectiveSinceSec,
  };
}
