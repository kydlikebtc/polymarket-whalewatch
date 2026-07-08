import { TradeSchema, type Trade } from "./types";
import { dedupKey } from "./trades";
import { fetchWithRetry, TRANSIENT_STATUS } from "./fetchWithRetry";
const DATA_API = "https://data-api.polymarket.com";

// /trades-specific retry wrapper: 12s timeout (server-side filterAmount scans
// are slow when matches are sparse) and the historical [fetchTrades] log label.
// The backoff/transient-status policy lives in the shared fetchWithRetry.
const fetchTrades = (url: string) =>
  fetchWithRetry(url, { timeoutMs: 12_000, label: "fetchTrades" });

// Per-row salvage parse: one malformed row (API shape drift) must not poison
// the whole page — the old all-or-nothing z.array fallback returned RAW rows,
// letting NaN notionals slip past every filter (NaN comparisons are all false)
// and fire "$NaN" alerts. Bad rows are dropped and summarized in one warn with
// the first issue path so shape drift stays diagnosable from the log.
// Exported for every /trades-shaped consumer (earlyWinner's per-market sweep).
export function parseTradeRows(raw: unknown, source: string): Trade[] {
  if (!Array.isArray(raw)) {
    console.warn(`[${source}] response is not an array — treating as empty`);
    return [];
  }
  const rows: Trade[] = [];
  let dropped = 0;
  let firstIssue: string | null = null;
  for (const row of raw) {
    const parsed = TradeSchema.safeParse(row);
    if (parsed.success) {
      rows.push(parsed.data);
      continue;
    }
    dropped++;
    if (!firstIssue) {
      const i = parsed.error.issues[0];
      firstIssue = i ? `${i.path.join(".")}: ${i.message}` : "unknown issue";
    }
  }
  if (dropped > 0) {
    console.warn(
      `[${source}] dropped ${dropped}/${raw.length} malformed row(s), kept ${rows.length} (first issue: ${firstIssue})`,
    );
  }
  return rows;
}

export interface LargeTradesOpts {
  // Window edge: rows older than this are pre-window backlog the engine has
  // already dispositioned — stop paginating (and drop them) on first sight.
  sinceSec?: number;
  // Full-page top-up budget. 1 (default) keeps the historical single-page
  // behavior for scripts; the embedded engine passes more so a hot cycle can
  // page deeper instead of silently dropping the overflow.
  maxPages?: number;
  // Batched "any of these already processed?" probe (one seen_trades IN(...)
  // query per full page). Once a page touches previously-seen trades, deeper
  // pages are all old news — no point topping up.
  hasSeenAny?: (trades: Trade[]) => boolean;
}

/**
 * Newest-first large-trades feed. The page-0 request is identical to the
 * historical single-page fetch; when the page comes back FULL and every row is
 * still new to the caller (unseen + inside the window), offset pages are
 * appended (same ≤3000-offset budget and mid-pagination degradation policy as
 * getTradesWindow) so a burst cycle no longer silently loses the overflow.
 * Page-size decisions use the RAW row count: salvage-dropped rows still
 * occupied page slots.
 */
export async function getLargeTrades(
  minUsd: number,
  limit = 500,
  opts: LargeTradesOpts = {},
): Promise<Trade[]> {
  const { sinceSec, maxPages = 1, hasSeenAny } = opts;
  const out: Trade[] = [];
  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;
    if (offset > MAX_TRADES_OFFSET) {
      console.warn(
        `[getLargeTrades] offset cap ${MAX_TRADES_OFFSET} reached (${out.length} rows) — stopping top-up`,
      );
      return out;
    }
    const url =
      `${DATA_API}/trades?filterType=CASH&filterAmount=${minUsd}&takerOnly=true&limit=${limit}` +
      (page > 0 ? `&offset=${offset}` : "");
    const res = await fetchTrades(url);
    if (!res.ok) {
      // Mid-top-up failure degrades to the fetched prefix (same policy as
      // getTradesWindow's mid-pagination handling); a first-page failure is
      // still a real error for the caller to handle.
      if (page > 0) {
        console.warn(
          `[getLargeTrades] top-up page ${page} failed (${res.status}) — keeping ${out.length} fetched rows`,
        );
        return out;
      }
      throw new Error(`getLargeTrades ${res.status}`);
    }
    const raw = await res.json();
    const rawCount = Array.isArray(raw) ? raw.length : 0;
    const rows = parseTradeRows(raw, "getLargeTrades");
    for (const t of rows) {
      // Newest-first: the first row older than sinceSec marks the window edge;
      // everything deeper is pre-window backlog.
      if (sinceSec != null && t.timestamp < sinceSec) return out;
      out.push(t);
    }
    if (rawCount < limit) return out; // genuine last page of the feed
    // Full page. Only rows NEW to the engine justify going deeper — at any
    // realistic floor the all-time feed always fills page 0, so "full" alone
    // is not a burst signal.
    if (hasSeenAny && rows.length > 0 && hasSeenAny(rows)) return out;
    if (page === maxPages - 1) {
      console.warn(
        `[getLargeTrades] full page (${limit} rows, page ${page + 1}/${maxPages}) — some large trades this cycle may be missed`,
      );
      return out;
    }
    console.warn(
      `[getLargeTrades] full page of unseen in-window rows — topping up at offset=${(page + 1) * limit}`,
    );
  }
  return out;
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

// Window-sweep page size. 250 (down from 500): the origin fills a page by
// scanning history until `limit` rows match, so on a sparse side (e.g.
// SELL @ $10k) a 250-row page needs ~half the scan — far less likely to hit
// the ~5.75s origin timeout that produced cold-cache 408s. The embedded
// engine's getLargeTrades made the same 500→250 move earlier (POLL_PAGE_LIMIT)
// for the same reason; this aligns the window sweeps.
const WINDOW_PAGE_LIMIT = 250;

// When a page STILL comes back transient after fetchWithRetry's whole backoff
// budget, halve the page at the SAME offset before degrading: a cheaper query
// usually completes even on a cold cache. 250 → 125 → 60 (max 2 shrinks).
const SHRINK_LIMITS = [125, 60];

/**
 * Fetch all large trades newer than `sinceSec`, paginating by offset because the
 * Data API has no time-range param. Rows come back newest-first, so we stop as
 * soon as we see a row older than the cutoff (window edge reached → complete).
 *
 * Offsets advance by the RAW row count of each page (not a fixed stride), so a
 * page can be re-fetched at the same offset with a smaller `limit` — that's
 * how the shrink-retry works — and mixed page sizes stay gap-free and
 * overlap-free. `maxPages` bounds the number of CONSUMED pages (shrink
 * retries at the same offset don't burn budget); the default 20 comfortably
 * reaches the 3000-offset cap at 250 rows/page (13 pages) with shrink slack.
 *
 * `truncated:true` means we hit `maxPages`, the API's hard offset cap, or a
 * mid-window transient failure (408/5xx surviving every retry — cold upstream
 * cache) before reaching the edge, so older in-window trades may still exist
 * and are NOT included — the fetched prefix is still a complete,
 * self-consistent (shorter) window.
 */
export async function getTradesWindow({
  minUsd,
  side,
  sinceSec,
  maxPages = 20,
}: TradesWindowQuery): Promise<{ trades: Trade[]; truncated: boolean }> {
  const out: Trade[] = [];
  const sideParam = side ? `&side=${side}` : "";
  const pageUrl = (limit: number, offset: number) =>
    `${DATA_API}/trades?filterType=CASH&filterAmount=${minUsd}&takerOnly=true&limit=${limit}&offset=${offset}${sideParam}`;

  let offset = 0;
  for (let pages = 0; pages < maxPages; pages++) {
    if (offset > MAX_TRADES_OFFSET) {
      console.warn(
        `[getTradesWindow] offset cap ${MAX_TRADES_OFFSET} reached (${out.length} rows) — window truncated`,
      );
      return { trades: out, truncated: true };
    }
    let limit = WINDOW_PAGE_LIMIT;
    let res = await fetchTrades(pageUrl(limit, offset));
    // Shrink-retry: a transient status that survived fetchWithRetry's backoff
    // means the origin timed out filling this page (cold cache on an expensive
    // query) — retry the SAME offset with a halved limit before giving up.
    for (const shrunk of SHRINK_LIMITS) {
      if (res.ok || !TRANSIENT_STATUS.has(res.status)) break;
      console.warn(
        `[getTradesWindow] transient ${res.status} at offset=${offset} limit=${limit} — retrying same offset with limit=${shrunk}`,
      );
      limit = shrunk;
      res = await fetchTrades(pageUrl(limit, offset));
    }
    if (!res.ok) {
      // A mid-pagination 400 is the deep-offset cap (possibly moved server-side):
      // degrade to the fetched prefix instead of failing the whole scan. A 400
      // on the FIRST page is a genuinely bad request and still throws.
      if (res.status === 400 && offset > 0) {
        console.warn(
          `[getTradesWindow] offset rejected at offset=${offset} (${out.length} rows) — window truncated`,
        );
        return { trades: out, truncated: true };
      }
      // A transient status that survived every retry AND every shrink: the
      // already-fetched prefix is still a complete, self-consistent shorter
      // window — return it truncated instead of discarding paid-for pages.
      // A FIRST-page transient still throws: there is no prefix to salvage.
      if (TRANSIENT_STATUS.has(res.status) && offset > 0) {
        console.warn(
          `[getTradesWindow] transient ${res.status} persisted at offset=${offset} after retries+shrinks (${out.length} rows fetched) — window truncated`,
        );
        return { trades: out, truncated: true };
      }
      throw new Error(`getTradesWindow ${res.status}`);
    }
    const raw = await res.json();
    // Salvage parse; pagination decisions below use the RAW page length, not
    // the salvaged length — a dropped row still occupied a page slot, so a
    // salvaged short page must not be mistaken for the last available page.
    const rawCount = Array.isArray(raw) ? raw.length : 0;
    const rows = parseTradeRows(raw, "getTradesWindow");
    if (rawCount === 0) return { trades: out, truncated: false };
    for (const t of rows) {
      // Newest-first ordering: the first older-than-cutoff row marks the window edge.
      if (t.timestamp < sinceSec) return { trades: out, truncated: false };
      out.push(t);
    }
    // Short RAW page (vs THIS page's possibly-shrunk limit) = last available page.
    if (rawCount < limit) return { trades: out, truncated: false };
    offset += rawCount;
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
 *
 * Degradation: the two sides are ISOLATED (allSettled). If one side fails
 * outright (e.g. a first-page 408 that survived every retry — typical of the
 * upstream's cold cache on expensive sparse-side queries), the survivor is
 * returned as a truncated window whose effectiveSinceSec is the survivor's
 * own oldest row ("now" = zero coverage when the survivor is empty), instead
 * of failing the whole scan. Only when BOTH sides fail does an error
 * propagate — with the original "getTradesWindow <status>" message shape
 * that /api/scan's error presentation relies on.
 */
export async function getTradesWindowDeep({
  minUsd,
  sinceSec,
  maxPages = 20,
}: Omit<TradesWindowQuery, "side">): Promise<DeepWindowResult> {
  const [buyRes, sellRes] = await Promise.allSettled([
    getTradesWindow({ minUsd, side: "BUY", sinceSec, maxPages }),
    getTradesWindow({ minUsd, side: "SELL", sinceSec, maxPages }),
  ]);

  if (buyRes.status === "rejected" && sellRes.status === "rejected") {
    // Nothing to salvage — surface the BUY error AS-IS so callers keep seeing
    // the "getTradesWindow <status>" shape; log both reasons for diagnosis.
    console.warn(
      `[getTradesWindowDeep] BOTH sides failed (BUY: ${String(buyRes.reason)}; SELL: ${String(sellRes.reason)})`,
    );
    throw buyRes.reason;
  }

  const fulfilled: Array<{ trades: Trade[]; truncated: boolean }> = [];
  let sideFailed = false;
  for (const [label, settled] of [
    ["BUY", buyRes],
    ["SELL", sellRes],
  ] as const) {
    if (settled.status === "fulfilled") {
      fulfilled.push(settled.value);
      continue;
    }
    sideFailed = true;
    console.warn(
      `[getTradesWindowDeep] ${label} side failed (${String(settled.reason)}) — degrading to the surviving side, window truncated`,
    );
  }

  // The complete merged window starts at the NEWEST truncation edge: beyond
  // it one side is blind, so its rows are dropped to keep netting honest.
  let effectiveSinceSec = sinceSec;
  for (const r of fulfilled) {
    if (r.truncated && r.trades.length > 0) {
      const oldest = r.trades[r.trades.length - 1].timestamp;
      if (oldest > effectiveSinceSec) effectiveSinceSec = oldest;
    }
  }
  if (sideFailed) {
    // The failed side is blind for the WHOLE window, so honest coverage only
    // reaches back to the survivor's own oldest row. An EMPTY survivor means
    // zero verified coverage — report "now" and return the empty window
    // rather than throwing (callers render the coverage note, not an error).
    const survivor = fulfilled[0];
    const oldest =
      survivor.trades.length > 0
        ? survivor.trades[survivor.trades.length - 1].timestamp
        : Math.floor(Date.now() / 1000);
    if (oldest > effectiveSinceSec) effectiveSinceSec = oldest;
  }

  const seen = new Set<string>();
  const trades: Trade[] = [];
  for (const t of fulfilled.flatMap((r) => r.trades)) {
    if (t.timestamp < effectiveSinceSec) continue;
    const k = dedupKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    trades.push(t);
  }
  trades.sort((a, b) => b.timestamp - a.timestamp);
  return {
    trades,
    truncated: sideFailed || effectiveSinceSec > sinceSec,
    effectiveSinceSec,
  };
}
