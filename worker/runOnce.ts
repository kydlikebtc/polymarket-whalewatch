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
export async function runOnce({ db, send, fetchTrades, thresholds }: Deps) {
  const minTier = thresholds[0];
  const fetched = await fetchTrades();
  const isSeen = (k: string) => hasSeen(db, k);
  for (const t of selectNewTrades(fetched, isSeen)) {
    const n = notionalUsd(t);
    if (n < minTier) continue;
    const tier = [...thresholds].reverse().find((x) => n >= x) ?? minTier;
    const k = dedupKey(t);
    // Send first, then persist seen+alert. This is at-least-once: if send() throws the trade
    // is NOT marked seen and will retry next poll (good); the rare send-ok-but-persist-fails
    // case yields one duplicate alert, which we accept over dropping alerts.
    await send(formatLargeTradeAlert(t, tier));
    markSeen(db, k, t.timestamp);
    recordAlert(db, "large", k, JSON.stringify(t), t.timestamp);
  }
}
