import { z } from "zod";
// Telegram creds are OPTIONAL: the alert engine always records matches to SQLite
// and only pushes to Telegram when both a bot token and a channel id are set.
// Defaulting to "" lets the engine (and the Next app via instrumentation) start
// with no Telegram configuration at all.
const Env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHANNEL_ID: z.string().default(""),
  LARGE_THRESHOLDS: z.string().default("10000,50000"),
  POLL_INTERVAL_MS: z.string().default("4000"),
});
// Accept any string-keyed env-like record (not the full NodeJS.ProcessEnv
// contract). Once Next's types are in the program they augment ProcessEnv to
// require NODE_ENV, which would otherwise reject partial test fixtures; the
// parser only reads the keys validated by the zod schema below.
export function parseConfig(raw: Record<string, string | undefined>) {
  const e = Env.parse(raw);
  const telegramBotToken = e.TELEGRAM_BOT_TOKEN;
  const telegramChannelId = e.TELEGRAM_CHANNEL_ID;
  return {
    telegramBotToken,
    telegramChannelId,
    // Telegram is on only when BOTH creds are non-empty.
    telegramEnabled: !!(telegramBotToken && telegramChannelId),
    largeThresholds: e.LARGE_THRESHOLDS.split(",")
      .map(Number)
      .sort((a, b) => a - b),
    pollIntervalMs: Number(e.POLL_INTERVAL_MS),
  };
}
export type AppConfig = ReturnType<typeof parseConfig>;
