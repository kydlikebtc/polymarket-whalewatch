import type { DB } from "./db";
import type { Trade } from "./types";
import type { AlertConditions } from "./alertConditions";
import { selectNewTrades } from "./poll";
import { dedupKey, notionalUsd } from "./trades";
import { formatLargeTradeAlert } from "./alert";
import { hasSeen, markSeen, recordAlert } from "./seen";

export interface EngineDeps {
  db: DB;
  fetchTrades: () => Promise<Trade[]>;
  conditions: AlertConditions;
  // ageDays by lowercased wallet (null = unknown). Only called when an age cap is set.
  getAges: (wallets: string[]) => Promise<Record<string, number | null>>;
  // Optional Telegram push; when undefined, matches are still recorded to SQLite.
  send?: (html: string) => Promise<void>;
  // Only consider trades with timestamp >= this (prevents replaying historical backlog).
  minTimestamp: number;
}

/**
 * One conditional matching cycle. Returns the number of alerts fired.
 *
 * Pipeline (cheap filters first, then the network-bound age filter):
 *  1. disabled → 0.
 *  2. fetch → drop already-seen → drop older than minTimestamp.
 *  3. amount / side / price-band filters (pure, no I/O).
 *  4. age filter (only if maxAgeDays set): fetch ages for survivor wallets, keep
 *     wallets with a finite ageDays <= cap (unknown-age and older are dropped).
 *  5. for each match (oldest-first): optionally push to Telegram, then record.
 *  6. mark EVERY evaluated `fresh` trade seen so it isn't re-evaluated next cycle.
 *
 * NOTE: condition changes apply only to trades arriving AFTER the change — trades
 * already marked seen are never re-evaluated against new conditions.
 */
export async function runAlertCycle(deps: EngineDeps): Promise<number> {
  const { db, fetchTrades, conditions, getAges, send, minTimestamp } = deps;

  if (!conditions.enabled) return 0;

  const fetched = await fetchTrades();
  // selectNewTrades drops already-seen and sorts oldest-first; then apply the
  // timestamp gate so we never replay historical fills on a cold/late start.
  const fresh = selectNewTrades(fetched, (k) => hasSeen(db, k)).filter(
    (t) => t.timestamp >= minTimestamp,
  );

  const minPrice = conditions.minPrice ?? 0;
  const maxPrice = conditions.maxPrice ?? 1;

  // Cheap, pure filters first.
  let survivors = fresh.filter((t) => {
    if (notionalUsd(t) < conditions.minUsd) return false;
    if (conditions.side !== "ALL" && t.side !== conditions.side) return false;
    if (t.price < minPrice || t.price > maxPrice) return false;
    return true;
  });

  // Address-age filter (network-bound) — only when a cap is set and survivors remain.
  if (conditions.maxAgeDays != null && survivors.length > 0) {
    const cap = conditions.maxAgeDays;
    const wallets = [
      ...new Set(survivors.map((t) => t.proxyWallet.toLowerCase())),
    ];
    const ages = await getAges(wallets);
    survivors = survivors.filter((t) => {
      const age = ages[t.proxyWallet.toLowerCase()];
      // Drop unknown-age (null/undefined) and wallets older than the cap.
      return typeof age === "number" && Number.isFinite(age) && age <= cap;
    });
  }

  // Fire alerts for the final matches (already oldest-first from selectNewTrades).
  for (const t of survivors) {
    const k = dedupKey(t);
    // At-least-once: send first; if send() throws, the trade is NOT marked seen
    // below (we throw out of the loop) and retries next cycle.
    if (send) await send(formatLargeTradeAlert(t, conditions.minUsd));
    markSeen(db, k, t.timestamp);
    recordAlert(db, "large", k, JSON.stringify(t), t.timestamp);
  }

  // Mark every evaluated fresh trade seen (matches were marked above; this covers
  // the non-matches) so condition-failing trades aren't re-evaluated next cycle.
  for (const t of fresh) {
    markSeen(db, dedupKey(t), t.timestamp);
  }

  return survivors.length;
}
