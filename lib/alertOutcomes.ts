import type { DB } from "./db";
import type { MarketMeta } from "./gamma";
import { fetchPriceAt } from "./priceHistory";
import { mapLimit } from "./mapLimit";
import { settleWon } from "./outcomeStats";

// The validation loop's answer to "was this signal any good?": the market
// price 1h/24h after the signal plus the final settlement result. Everything
// here is queried ON DEMAND from public history (prices-history + gamma) —
// no archival layer needed — and cached because past prices are immutable.
export interface AlertOutcome {
  price1h: number | null;
  price24h: number | null;
  resolved: boolean;
  resolutionPrice: number | null; // settled price of the alert's outcome (≈0 or 1)
  won: boolean | null; // P&L direction vs the fill price (settleWon); null = push
}

// Minimal payload fields required for outcome tracking. Large/smart payloads
// are single fills; consensus payloads are group aggregates tracked as a
// synthetic BUY at the group's usd-weighted average price, timed at the LAST
// member fill (the moment the alert-worthy formation completed).
interface TrackablePayload {
  asset: string;
  conditionId: string;
  price: number;
  timestamp: number;
  side: "BUY" | "SELL";
  outcomeIndex: number;
}

function parseTrackable(
  type: string | null,
  payload: string | null,
): TrackablePayload | null {
  if (!payload) return null;
  try {
    const p = JSON.parse(payload) as Record<string, unknown>;
    if (type === "consensus") {
      // Every member trade of a (conditionId, outcome) group shares the same
      // token, so the group-level asset/outcomeIndex identify it. Pre-upgrade
      // payloads (before detectConsensus carried these fields) skip gracefully.
      if (
        typeof p.asset !== "string" ||
        typeof p.conditionId !== "string" ||
        typeof p.avgBuyPrice !== "number" ||
        typeof p.lastTs !== "number" ||
        typeof p.outcomeIndex !== "number"
      ) {
        return null;
      }
      return {
        asset: p.asset,
        conditionId: p.conditionId,
        price: p.avgBuyPrice,
        timestamp: p.lastTs,
        side: "BUY",
        outcomeIndex: p.outcomeIndex,
      };
    }
    if (
      typeof p.asset !== "string" ||
      typeof p.conditionId !== "string" ||
      typeof p.price !== "number" ||
      typeof p.timestamp !== "number" ||
      (p.side !== "BUY" && p.side !== "SELL") ||
      typeof p.outcomeIndex !== "number"
    ) {
      return null;
    }
    return {
      asset: p.asset,
      conditionId: p.conditionId,
      price: p.price,
      timestamp: p.timestamp,
      side: p.side,
      outcomeIndex: p.outcomeIndex,
    };
  } catch {
    return null;
  }
}

const HOUR = 3600;
const DAY = 86_400;
// Wait a little past the mark so the candle actually exists.
const SETTLE_MARGIN_SEC = 300;
// A null price (inactive market) retries at most this often, not per request.
const NULL_RETRY_SEC = 6 * HOUR;

export interface OutcomeDeps {
  fetchPrice?: typeof fetchPriceAt;
  getMeta: (conditionIds: string[]) => Promise<Record<string, MarketMeta>>;
  nowSec?: number;
  concurrency?: number;
}

/**
 * Compute (and cache) outcomes for the given alert ids. Immutable facts —
 * historical prices and settlements — are written once to alert_outcomes;
 * unresolved markets are re-checked via the (cached) gamma meta each call.
 * Untrackable rows (pre-upgrade consensus payloads, malformed payloads) are
 * skipped.
 */
export async function computeAlertOutcomes(
  db: DB,
  ids: number[],
  deps: OutcomeDeps,
): Promise<Record<number, AlertOutcome>> {
  const {
    fetchPrice = fetchPriceAt,
    getMeta,
    nowSec = Math.floor(Date.now() / 1000),
    concurrency = 4,
  } = deps;
  if (ids.length === 0) return {};

  const placeholders = ids.map(() => "?").join(",");
  const alerts = db
    .prepare(
      `SELECT id, type, payload FROM alerts WHERE id IN (${placeholders})`,
    )
    .all(...ids) as {
    id: number;
    type: string | null;
    payload: string | null;
  }[];

  const trackable = alerts
    .map((a) => ({ id: a.id, p: parseTrackable(a.type, a.payload) }))
    .filter((a): a is { id: number; p: TrackablePayload } => a.p !== null);
  if (trackable.length === 0) return {};

  const selOut = db.prepare(
    "SELECT price_1h, price_24h, resolved, resolution_price, won, checked_at FROM alert_outcomes WHERE alert_id = ?",
  );
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO alert_outcomes
       (alert_id, price_1h, price_24h, resolved, resolution_price, won, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  // One batched (cached) meta lookup covers every unresolved market.
  const cachedRows = new Map(
    trackable.map((a) => [
      a.id,
      selOut.get(a.id) as
        | {
            price_1h: number | null;
            price_24h: number | null;
            resolved: number;
            resolution_price: number | null;
            won: number | null;
            checked_at: number;
          }
        | undefined,
    ]),
  );
  const unresolvedCids = [
    ...new Set(
      trackable
        .filter((a) => !cachedRows.get(a.id)?.resolved)
        .map((a) => a.p.conditionId),
    ),
  ];
  let metaByCid: Record<string, MarketMeta> = {};
  if (unresolvedCids.length > 0) {
    try {
      metaByCid = await getMeta(unresolvedCids);
    } catch (e) {
      console.warn("[alertOutcomes] meta lookup failed:", e);
    }
  }

  const out: Record<number, AlertOutcome> = {};
  await mapLimit(trackable, concurrency, async ({ id, p }) => {
    const cached = cachedRows.get(id);
    let price1h = cached?.price_1h ?? null;
    let price24h = cached?.price_24h ?? null;
    let resolved = !!cached?.resolved;
    let resolutionPrice = cached?.resolution_price ?? null;
    let won: boolean | null = cached?.won == null ? null : cached.won === 1;
    let dirty = !cached;

    if (!resolved) {
      const meta = metaByCid[p.conditionId];
      const rp = meta?.closed ? meta.outcomePrices[p.outcomeIndex] : undefined;
      if (typeof rp === "number" && Number.isFinite(rp)) {
        resolved = true;
        resolutionPrice = rp;
        // Win/loss is judged by P&L direction against the FILL price, not a
        // fixed 0.5 divider — BUY@0.9 settling at 0.6 lost 0.3/share even
        // though 0.6 > 0.5 (fractional settlements). Pushes (≈50/50
        // cancellation/draw ruling, or a settle within ε of the fill) stay
        // null and never enter the win-rate denominator; standard 0/1
        // settlements score exactly as before.
        won = settleWon(p.side, p.price, rp);
        dirty = true;
      }
    }

    // Historical prices are immutable: fetch once when the mark has passed;
    // nulls (dead market) back off instead of retrying every request.
    // "Attempted" must be judged PER MARK: a cached row whose checked_at
    // predates the mark (e.g. the dashboard viewed the alert before the hour
    // elapsed) has NEVER tried this mark, so the null backoff must not gate it.
    const marks: [number, "1h" | "24h"][] = [
      [HOUR, "1h"],
      [DAY, "24h"],
    ];
    for (const [delta, which] of marks) {
      const have = which === "1h" ? price1h : price24h;
      if (have != null) continue;
      const markAt = p.timestamp + delta + SETTLE_MARGIN_SEC;
      if (nowSec < markAt) continue;
      const attempted = cached != null && cached.checked_at >= markAt;
      if (attempted && nowSec - cached.checked_at <= NULL_RETRY_SEC) continue;
      try {
        const price = await fetchPrice(p.asset, p.timestamp + delta);
        if (which === "1h") price1h = price;
        else price24h = price;
        dirty = true;
      } catch (e) {
        console.warn(`[alertOutcomes] price fetch failed (alert ${id}):`, e);
      }
    }

    if (dirty) {
      upsert.run(
        id,
        price1h,
        price24h,
        resolved ? 1 : 0,
        resolutionPrice,
        won == null ? null : won ? 1 : 0,
        nowSec,
      );
    }
    out[id] = { price1h, price24h, resolved, resolutionPrice, won };
  });
  return out;
}
