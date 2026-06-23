import "dotenv/config";
import { parseConfig } from "../lib/config";
import { openDb } from "../lib/db";
import { getLargeTrades } from "../lib/polymarket";
import { sendMessage } from "../lib/telegram";
import { runOnce, seedSeen } from "./runOnce";
const cfg = parseConfig(process.env);
const db = openDb();
const creds = { botToken: cfg.telegramBotToken, chatId: cfg.telegramChannelId };
const fetchTrades = () => getLargeTrades(cfg.largeThresholds[0]);
async function loop() {
  try {
    await runOnce({
      db,
      send: (html) => sendMessage(creds, html),
      fetchTrades,
      thresholds: cfg.largeThresholds,
    });
  } catch (e) {
    console.error("[poll] error", e);
  }
  setTimeout(loop, cfg.pollIntervalMs);
}
async function start() {
  console.log("[worker] starting, thresholds", cfg.largeThresholds);
  // On a cold start (empty dedup table) seed the current backlog silently so we
  // don't blast historical trades; warm restarts skip this and resume alerting.
  const seenCount = (
    db.prepare("SELECT COUNT(*) AS c FROM seen_trades").get() as { c: number }
  ).c;
  if (seenCount === 0) {
    const n = await seedSeen({ db, fetchTrades });
    console.log(`[worker] cold start: seeded ${n} existing trades (no alert)`);
  }
  loop();
}
// 7x24 resilience: never let a stray rejection or a startup-phase network blip kill the worker.
process.on("unhandledRejection", (e) =>
  console.error("[worker] unhandledRejection", e),
);
process.on("uncaughtException", (e) =>
  console.error("[worker] uncaughtException", e),
);
// seedSeen is atomic w.r.t. fetch failure (nothing is seeded if the fetch rejects), so a failed
// cold start can be cleanly retried without risking a half-seeded backlog storm.
start().catch((e) => {
  console.error("[worker] start failed, retrying after interval", e);
  setTimeout(start, cfg.pollIntervalMs);
});
