import { TradeSchema, type Trade } from "./types";
import { z } from "zod";
const DATA_API = "https://data-api.polymarket.com";
export async function getLargeTrades(
  minUsd: number,
  limit = 500,
): Promise<Trade[]> {
  const url = `${DATA_API}/trades?filterType=CASH&filterAmount=${minUsd}&takerOnly=true&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
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

/**
 * Fetch all large trades newer than `sinceSec`, paginating by offset because the
 * Data API has no time-range param. Rows come back newest-first, so we stop as
 * soon as we see a row older than the cutoff (window edge reached → complete).
 * `truncated:true` means we hit `maxPages` before reaching the edge, so older
 * in-window trades may still exist and are NOT included.
 */
export async function getTradesWindow({
  minUsd,
  side,
  sinceSec,
  maxPages = 20,
}: TradesWindowQuery): Promise<{ trades: Trade[]; truncated: boolean }> {
  const out: Trade[] = [];
  for (let page = 0; page < maxPages; page++) {
    const sideParam = side ? `&side=${side}` : "";
    const url = `${DATA_API}/trades?filterType=CASH&filterAmount=${minUsd}&takerOnly=true&limit=500&offset=${page * 500}${sideParam}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`getTradesWindow ${res.status}`);
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
