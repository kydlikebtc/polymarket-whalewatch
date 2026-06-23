import type { DB } from "../lib/db";
import type { Trade } from "../lib/types";
import { selectNewTrades } from "../lib/poll";
import { dedupKey, notionalUsd } from "../lib/trades";
import { formatLargeTradeAlert } from "../lib/alert";
interface Deps {
  db: DB;
  send: (html: string) => Promise<void>;
  fetchTrades: () => Promise<Trade[]>;
  thresholds: number[];
}
export async function runOnce({ db, send, fetchTrades, thresholds }: Deps) {
  const minTier = thresholds[0];
  const fetched = await fetchTrades();
  const isSeen = (k: string) =>
    !!db.prepare("SELECT 1 FROM seen_trades WHERE dedup_key=?").get(k);
  for (const t of selectNewTrades(fetched, isSeen)) {
    const n = notionalUsd(t);
    if (n < minTier) continue;
    const tier = [...thresholds].reverse().find((x) => n >= x) ?? minTier;
    await send(formatLargeTradeAlert(t, tier));
    const k = dedupKey(t);
    db.prepare(
      "INSERT OR IGNORE INTO seen_trades (dedup_key, ts) VALUES (?, ?)",
    ).run(k, t.timestamp);
    db.prepare(
      "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES (?,?,?,?)",
    ).run("large", k, JSON.stringify(t), t.timestamp);
  }
}
