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
const DEFAULT_POLL_INTERVAL_MS = 4000;
// Floor, not crash: the engine must survive a bad env edit 7×24. The dangerous
// failure is NaN — setTimeout(fn, NaN) fires after ~1ms, turning the 4s poll
// into a busy-loop hammering /trades (rate-limit or IP-ban territory).
const MIN_POLL_INTERVAL_MS = 1000;
const DEFAULT_LARGE_THRESHOLDS = [10_000, 50_000];

// Number(raw) with NaN → default and sub-floor → clamp, each with a warn that
// echoes the raw input so a typo like "4_000"/"4s" is diagnosable from the log.
function parsePollIntervalMs(raw: string): number {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) {
    console.warn(
      `[config] POLL_INTERVAL_MS=${JSON.stringify(raw)} is not a number — using default ${DEFAULT_POLL_INTERVAL_MS}ms (a NaN interval would busy-loop the poll at ~1ms)`,
    );
    return DEFAULT_POLL_INTERVAL_MS;
  }
  if (n < MIN_POLL_INTERVAL_MS) {
    console.warn(
      `[config] POLL_INTERVAL_MS=${JSON.stringify(raw)} below the ${MIN_POLL_INTERVAL_MS}ms floor — clamped`,
    );
    return MIN_POLL_INTERVAL_MS;
  }
  return Math.round(n);
}

// Non-numeric entries (e.g. "10_000") parse to NaN and would poison every
// downstream `>=` comparison; drop them, and fall back to the defaults when
// nothing survives — always warn with the raw input.
function parseLargeThresholds(raw: string): number[] {
  const parts = raw.split(",").map((s) => s.trim());
  const valid = parts
    .filter((s) => s !== "" && Number.isFinite(Number(s)))
    .map(Number);
  if (valid.length === 0) {
    console.warn(
      `[config] LARGE_THRESHOLDS=${JSON.stringify(raw)} has no parseable numbers — using default ${DEFAULT_LARGE_THRESHOLDS.join(",")}`,
    );
    return [...DEFAULT_LARGE_THRESHOLDS];
  }
  if (valid.length < parts.length) {
    console.warn(
      `[config] LARGE_THRESHOLDS=${JSON.stringify(raw)}: dropped ${parts.length - valid.length} non-numeric entrie(s), kept ${valid.join(",")}`,
    );
  }
  return valid.sort((a, b) => a - b);
}

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
    largeThresholds: parseLargeThresholds(e.LARGE_THRESHOLDS),
    pollIntervalMs: parsePollIntervalMs(e.POLL_INTERVAL_MS),
  };
}
export type AppConfig = ReturnType<typeof parseConfig>;
