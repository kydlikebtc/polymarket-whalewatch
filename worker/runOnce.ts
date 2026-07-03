import type { DB } from "../lib/db";
import type { Trade } from "../lib/types";
import { selectNewTrades } from "../lib/poll";
import { dedupKey, notionalUsd } from "../lib/trades";
import { formatLargeTradeAlert } from "../lib/alert";
import { hasSeen, markSeen, recordAlert } from "../lib/seen";
interface Deps {
  db: DB;
  send: (html: string) => Promise<void>;
  fetchTrades: () => Promise<Trade[]>;
  thresholds: number[];
}
// Cold-start seeding: mark the current backlog of trades as seen WITHOUT alerting,
// so a fresh start doesn't replay up to a full page (~500) of historical fills.
// Subsequent polls then only alert genuinely new trades. Returns how many were seeded.
export async function seedSeen({
  db,
  fetchTrades,
}: Pick<Deps, "db" | "fetchTrades">): Promise<number> {
  const fetched = await fetchTrades();
  let seeded = 0;
  for (const t of fetched) {
    const k = dedupKey(t);
    if (!hasSeen(db, k)) {
      markSeen(db, k, t.timestamp);
      seeded++;
    }
  }
  return seeded;
}

export async function runOnce({ db, send, fetchTrades, thresholds }: Deps) {
  const minTier = thresholds[0];
  const fetched = await fetchTrades();
  const isSeen = (k: string) => hasSeen(db, k);
  for (const t of selectNewTrades(fetched, isSeen)) {
    const n = notionalUsd(t);
    if (n < minTier) continue;
    const k = dedupKey(t);
    // Send first, then persist seen+alert. This is at-least-once: if send() throws the trade
    // is NOT marked seen and will retry next poll (good); the rare send-ok-but-persist-fails
    // case yields one duplicate alert, which we accept over dropping alerts.
    // 🐳/💰 tiering now lives INSIDE formatLargeTradeAlert on fixed notional
    // cutoffs — thresholds[0] is only the alert floor here.
    await send(formatLargeTradeAlert(t));
    markSeen(db, k, t.timestamp);
    recordAlert(db, "large", k, JSON.stringify(t), t.timestamp);
  }
}
