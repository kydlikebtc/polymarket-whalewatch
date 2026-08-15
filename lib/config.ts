import { z } from "zod";
// Telegram creds are OPTIONAL: the alert engine always records matches to SQLite
// and only pushes to Telegram when both a bot token and a channel id are set.
// Defaulting to "" lets the engine (and the Next app via instrumentation) start
// with no Telegram configuration at all.
const Env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHANNEL_ID: z.string().default(""),
  // Opt-in startup connectivity ping (default OFF): when truthy AND Telegram
  // is enabled, the engine pushes one online message at start so a creds /
  // permission problem surfaces at deploy time instead of as days of silence.
  TELEGRAM_STARTUP_PING: z.string().default(""),
  LARGE_THRESHOLDS: z.string().default("10000,50000"),
  POLL_INTERVAL_MS: z.string().default("4000"),
  // Public base URL of the deployed dashboard — powers the 🎯 signal-card
  // deep links in Telegram pushes and bot replies. Defaults to the production
  // deployment; point elsewhere for a self-hosted instance.
  PUBLIC_URL: z.string().default("https://whalewatch.wired.fund"),
  // Dead-man's switch (optional): a healthchecks.io/uptime-kuma style ping
  // URL. The engine GETs it every minute WHILE ALL LOOPS ARE FRESH — so the
  // ping service's "no ping received" alarm covers process death AND silent
  // loop hangs, through a channel independent of this process and of Telegram.
  HEALTHCHECK_PING_URL: z.string().default(""),
  // 对外信号付费频道(批次 1):策略信号实时推送的目的频道。与告警频道
  // (TELEGRAM_CHANNEL_ID)刻意分开 —— 告警频道是公开的,策略信号实时版
  // 是付费墙内的。空 = 该通道关闭(fail-closed)。
  TELEGRAM_SIGNAL_CHANNEL_ID: z.string().default(""),
  // 公开延迟通道的延迟分钟数(默认 30)。延迟是免费/付费分层的唯一杠杆
  // (设计 §4.4):免费版不阉割字段,只晚到 —— 公开可验证记录必须完整。
  SIGNAL_PUBLIC_DELAY_MIN: z.string().default("30"),
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

const DEFAULT_SIGNAL_PUBLIC_DELAY_MIN = 30;

// 与 parsePollIntervalMs 同一姿态:坏值回默认并 warn(引擎必须扛住 .env 手误
// 7×24),负数没有语义(延迟不能为负)同样回默认。0 合法 —— 运营可显式关闭
// 延迟(例如测试期),但那是显式选择不是手误。
function parseSignalPublicDelayMin(raw: string): number {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0) {
    console.warn(
      `[config] SIGNAL_PUBLIC_DELAY_MIN=${JSON.stringify(raw)} 不是合法分钟数 — 使用默认 ${DEFAULT_SIGNAL_PUBLIC_DELAY_MIN}`,
    );
    return DEFAULT_SIGNAL_PUBLIC_DELAY_MIN;
  }
  return Math.round(n);
}

// Boolean env flags: explicit truthy spellings only, everything else (including
// "" — the default) is false. No warn on unrecognized values: an unset flag is
// the normal case, and "0"/"false" must stay silent.
const TRUTHY = new Set(["1", "true", "yes", "on"]);
function parseBoolEnv(raw: string): boolean {
  return TRUTHY.has(raw.trim().toLowerCase());
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
    telegramStartupPing: parseBoolEnv(e.TELEGRAM_STARTUP_PING),
    largeThresholds: parseLargeThresholds(e.LARGE_THRESHOLDS),
    pollIntervalMs: parsePollIntervalMs(e.POLL_INTERVAL_MS),
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ""),
    healthcheckPingUrl: e.HEALTHCHECK_PING_URL.trim(),
    telegramSignalChannelId: e.TELEGRAM_SIGNAL_CHANNEL_ID.trim(),
    signalPublicDelayMin: parseSignalPublicDelayMin(e.SIGNAL_PUBLIC_DELAY_MIN),
  };
}
export type AppConfig = ReturnType<typeof parseConfig>;
