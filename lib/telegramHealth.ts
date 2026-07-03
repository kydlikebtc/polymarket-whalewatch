import type { DB } from "./db";
import { esc } from "./tgFormat";

// Push-channel self-diagnosis. The failure mode this exists for: creds rot,
// the bot gets kicked, or a sustained 429 storm — every cycle logs a
// console.error nobody reads, and "no messages" is indistinguishable from
// "no large trades" for days. Two local signals, no new external endpoints:
//  1. counters in the `config` table (written by the engine's send wrapper,
//     read by /api/alerts → alerts-page callout);
//  2. after TG_FAILURE_DIAG_THRESHOLD consecutive send failures, ONE
//     rate-limited (per UTC hour, deduped via a config key) self-diagnostic
//     push through the same channel — useful when the channel is flapping
//     rather than hard-down (hard-down keeps the dashboard callout as the
//     remaining signal).

// Consecutive FAILED SEND ATTEMPTS (across the alert + consensus loops, which
// share one wrapped send) before the diagnostic fires. Attempt-granularity,
// not cycle-granularity: idle cycles with nothing to push must neither reset
// nor grow the streak.
export const TG_FAILURE_DIAG_THRESHOLD = 3;

const HOUR_SEC = 3600;
// Keep the stored last-error short: it feeds a config row and a one-line
// dashboard hint, not a stack-trace archive.
const MAX_ERR_LEN = 200;

// config-table keys — single source of truth shared by the engine (writes)
// and the dashboard's /api/alerts (reads via getTelegramHealth).
const KEY_FAILS = "tg_consec_send_failures";
const KEY_LAST_ERR = "tg_last_send_error";
const KEY_LAST_ERR_TS = "tg_last_send_error_ts";
const KEY_LAST_OK_TS = "tg_last_send_ok_ts";
const KEY_DIAG_HOUR = "tg_diag_last_hour";

function getCfg(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as
    { value: string | null } | undefined;
  return row?.value ?? null;
}

function setCfg(db: DB, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    key,
    value,
  );
}

function intOrNull(s: string | null): number | null {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export interface TelegramHealth {
  consecutiveSendFailures: number;
  lastErrorMessage: string | null;
  lastErrorAt: number | null; // unix sec
  lastOkAt: number | null; // unix sec
  // Dashboard warning gate: streak has reached the diagnostic threshold. A
  // single transient blip (streak 1–2) must not flash a red banner.
  failing: boolean;
}

/**
 * Read the channel-health counters for the dashboard. Returns null when the
 * config table is unreadable (cold db opened readonly by the API route) —
 * "unknown", not "healthy".
 */
export function getTelegramHealth(db: DB): TelegramHealth | null {
  try {
    const n = intOrNull(getCfg(db, KEY_FAILS)) ?? 0;
    return {
      consecutiveSendFailures: n,
      lastErrorMessage: getCfg(db, KEY_LAST_ERR),
      lastErrorAt: intOrNull(getCfg(db, KEY_LAST_ERR_TS)),
      lastOkAt: intOrNull(getCfg(db, KEY_LAST_OK_TS)),
      failing: n >= TG_FAILURE_DIAG_THRESHOLD,
    };
  } catch (e) {
    console.warn("[telegramHealth] health read failed (missing table?):", e);
    return null;
  }
}

// Injectable for tests only — production callers never pass these.
export interface HealthSendOpts {
  threshold?: number;
  nowSec?: () => number;
}

/**
 * Wrap the engine's Telegram send with health accounting:
 *  - success: reset the consecutive-failure streak, stamp last-ok;
 *  - failure: bump the streak + record the error (config table), then — at the
 *    threshold, at most once per UTC hour — push one self-diagnostic message,
 *    and ALWAYS rethrow the ORIGINAL error so the engines' claim-rollback /
 *    permanent-poison semantics stay byte-for-byte untouched.
 * The diagnostic's own outcome deliberately does not feed the counters (it
 * would otherwise mint a fake recovery or double-count one outage).
 */
export function wrapSendWithHealth(
  db: DB,
  send: (html: string) => Promise<void>,
  opts: HealthSendOpts = {},
): (html: string) => Promise<void> {
  const threshold = opts.threshold ?? TG_FAILURE_DIAG_THRESHOLD;
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  return async (html: string) => {
    try {
      await send(html);
    } catch (e) {
      const now = nowSec();
      const streak = recordSendFailure(db, e, now);
      await maybeSendDiagnostic(db, send, streak, threshold, now);
      throw e;
    }
    recordSendSuccess(db, nowSec());
  };
}

function recordSendSuccess(db: DB, now: number): void {
  const prev = intOrNull(getCfg(db, KEY_FAILS)) ?? 0;
  if (prev > 0) {
    console.log(
      `[telegramHealth] channel recovered after ${prev} consecutive send failure(s)`,
    );
  }
  setCfg(db, KEY_FAILS, "0");
  setCfg(db, KEY_LAST_OK_TS, String(now));
}

// Returns the new streak length.
function recordSendFailure(db: DB, err: unknown, now: number): number {
  const streak = (intOrNull(getCfg(db, KEY_FAILS)) ?? 0) + 1;
  const msg = (err instanceof Error ? err.message : String(err)).slice(
    0,
    MAX_ERR_LEN,
  );
  setCfg(db, KEY_FAILS, String(streak));
  setCfg(db, KEY_LAST_ERR, msg);
  setCfg(db, KEY_LAST_ERR_TS, String(now));
  console.warn(
    `[telegramHealth] send failure streak=${streak} (dashboard warning at ${TG_FAILURE_DIAG_THRESHOLD}): ${msg}`,
  );
  return streak;
}

async function maybeSendDiagnostic(
  db: DB,
  send: (html: string) => Promise<void>,
  streak: number,
  threshold: number,
  now: number,
): Promise<void> {
  if (streak < threshold) return;
  const bucket = String(Math.floor(now / HOUR_SEC));
  if (getCfg(db, KEY_DIAG_HOUR) === bucket) return;
  // Claim the hour BEFORE attempting: even a failed diagnostic must not retry
  // within the hour — the channel is already sick, don't pile on.
  setCfg(db, KEY_DIAG_HOUR, bucket);
  const lastErr = getCfg(db, KEY_LAST_ERR) ?? "";
  const html =
    `⚠️ <b>推送通道自诊断</b>：Telegram 已连续 ${streak} 次发送失败\n` +
    `最近错误：${esc(lastErr)}\n` +
    `告警仍在正常入库（看板可见），仅推送受影响 — 请检查 bot token / 频道权限 / 限流`;
  try {
    await send(html);
    console.warn(
      `[telegramHealth] pushed self-diagnostic after ${streak} consecutive send failure(s)`,
    );
  } catch (e) {
    console.error(
      "[telegramHealth] self-diagnostic push itself failed (channel hard-down?) — the dashboard telegramHealth warning is the remaining signal:",
      e,
    );
  }
}
