import { parseConfig } from "../lib/config";
import { openDb, type DB } from "../lib/db";
import { getLargeTrades } from "../lib/polymarket";
import { sendMessage } from "../lib/telegram";
import { getWalletAges } from "../lib/walletAge";
import { getAlertConditions } from "../lib/alertConditions";
import { runAlertCycle } from "../lib/alertEngine";

// Guarded singleton: instrumentation may call this more than once (per runtime),
// and `npm run worker` also calls it — the flag makes every call after the first
// a no-op so we never run two concurrent poll loops against the same db.
let started = false;

const SECONDS_PER_DAY = 86400;

/**
 * Start the continuously-running alert engine.
 *
 * - Writes to the SAME SQLite file the dashboard reads (openDb default
 *   `data.sqlite`, overridable via DASH_DB so engine + dashboard always agree).
 * - Telegram is OPTIONAL: push only when both creds are set (telegramEnabled);
 *   otherwise matches are still recorded to the `alerts` table.
 * - minTimestamp = now at startup, so we never replay historical backlog.
 * - Reads conditions fresh from the `config` table every cycle, so dashboard
 *   edits take effect on the next poll.
 */
export function startAlertEngine(): void {
  if (started) return;
  started = true;

  const cfg = parseConfig(process.env);
  const dbPath = process.env.DASH_DB || "data.sqlite";
  const db: DB = openDb(dbPath);
  const creds = {
    botToken: cfg.telegramBotToken,
    chatId: cfg.telegramChannelId,
  };
  const send = cfg.telegramEnabled
    ? (html: string) => sendMessage(creds, html)
    : undefined;
  // Only alert on trades that arrive AFTER the engine starts (no historical storm).
  const minTimestamp = Math.floor(Date.now() / 1000);

  // walletAge.getWalletAges returns firstActivityTs (unix sec) | null per wallet.
  // The engine needs ageDays, so convert here.
  const getAges = async (
    wallets: string[],
  ): Promise<Record<string, number | null>> => {
    const firstTsByWallet = await getWalletAges(db, wallets);
    const now = Math.floor(Date.now() / 1000);
    const out: Record<string, number | null> = {};
    for (const [w, firstTs] of Object.entries(firstTsByWallet)) {
      out[w] =
        typeof firstTs === "number" ? (now - firstTs) / SECONDS_PER_DAY : null;
    }
    return out;
  };

  // Fetch at a SAFE floor, not the raw configured minUsd: the Data API's
  // server-side filterAmount is fast when matches are DENSE (low threshold) but
  // the origin times out (~5.75s → 408) when they're SPARSE (high threshold,
  // scanning deep history to fill a page). So we fetch at min(minUsd, SAFE_FLOOR)
  // — a superset of any higher configured minUsd — and let runAlertCycle apply
  // the exact (higher) minUsd in memory. The floor never EXCEEDS minUsd, so a
  // low-threshold config (e.g. $500) still sees its trades.
  const SAFE_FLOOR = 10_000;
  // `conditions` is read fresh each cycle, so fetchTrades must take the floor as
  // an argument rather than closing over a startup value.
  const fetchTrades = (minUsd: number) =>
    getLargeTrades(Math.min(minUsd, SAFE_FLOOR), 1000);

  console.log(
    `[engine] starting · db=${dbPath} · telegram=${
      cfg.telegramEnabled ? "on" : "off (records to SQLite only)"
    } · interval=${cfg.pollIntervalMs}ms`,
  );

  async function loop() {
    try {
      const conditions = getAlertConditions(db);
      const fired = await runAlertCycle({
        db,
        fetchTrades: () => fetchTrades(conditions.minUsd),
        conditions,
        getAges,
        send,
        minTimestamp,
      });
      if (fired > 0) console.log(`[engine] cycle fired ${fired} alert(s)`);
    } catch (e) {
      console.error("[engine] cycle error", e);
    }
    setTimeout(loop, cfg.pollIntervalMs);
  }

  loop();
}
