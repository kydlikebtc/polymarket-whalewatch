import "dotenv/config";
import { parseConfig } from "../lib/config";
import { openDb } from "../lib/db";
import { getLargeTrades } from "../lib/polymarket";
import { sendMessage } from "../lib/telegram";
import { runOnce } from "./runOnce";
const cfg = parseConfig(process.env);
const db = openDb();
const creds = { botToken: cfg.telegramBotToken, chatId: cfg.telegramChannelId };
async function loop() {
  try {
    await runOnce({
      db,
      send: (html) => sendMessage(creds, html),
      fetchTrades: () => getLargeTrades(cfg.largeThresholds[0]),
      thresholds: cfg.largeThresholds,
    });
  } catch (e) {
    console.error("[poll] error", e);
  }
  setTimeout(loop, cfg.pollIntervalMs);
}
console.log("[worker] starting, thresholds", cfg.largeThresholds);
loop();
