import { TradeSchema, type Trade } from "./types";
import { dedupKey } from "./trades";
import { fetchWithRetry } from "./fetchWithRetry";
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
function parseTradeRows(raw: unknown, source: string): Trade[] {
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
    if (rawCount < 500) return { trades: out, truncated: false }; // last available page
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
