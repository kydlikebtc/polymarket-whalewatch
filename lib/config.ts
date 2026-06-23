import { z } from "zod";
const Env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHANNEL_ID: z.string().min(1),
  LARGE_THRESHOLDS: z.string().default("10000,50000"),
  POLL_INTERVAL_MS: z.string().default("4000"),
});
export function parseConfig(raw: NodeJS.ProcessEnv) {
  const e = Env.parse(raw);
  return {
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    telegramChannelId: e.TELEGRAM_CHANNEL_ID,
    largeThresholds: e.LARGE_THRESHOLDS.split(",")
      .map(Number)
      .sort((a, b) => a - b),
    pollIntervalMs: Number(e.POLL_INTERVAL_MS),
  };
}
export type AppConfig = ReturnType<typeof parseConfig>;
