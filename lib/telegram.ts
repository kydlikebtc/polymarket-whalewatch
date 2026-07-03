export interface TgCreds {
  botToken: string;
  chatId: string;
}

interface TgResponse {
  ok: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

// A PERMANENT (non-retryable) send failure: HTTP 4xx other than 429 — bad
// entities, bot kicked from the chat, chat not found. Retrying the identical
// request can never succeed, so the alert engines must KEEP their claim
// (record the alert without a push) instead of rolling back — otherwise one
// poison message pins the head of the oldest-first queue every cycle.
export class TelegramPermanentError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "TelegramPermanentError";
  }
}

// Duck-typed on the `permanent` marker (not instanceof) so bundler module
// duplication can never break the engines' transient/permanent classification.
export const isPermanentSendError = (e: unknown): boolean =>
  typeof e === "object" &&
  e !== null &&
  (e as { permanent?: unknown }).permanent === true;

// The serial engine loop awaits every send: one hung connection must not
// freeze /trades polling for undici's default ~300s.
const TIMEOUT_MS = 10_000;
// 5xx / network-level failures: bounded short backoff, then throw (transient —
// the engines roll the claim back and the at-least-once path re-sends next cycle).
const TRANSIENT_BACKOFF_MS = [1_000, 2_000, 4_000];
// 429: honor retry_after up to this cap. A larger ask is NOT slept on — throw
// immediately (transient) rather than blocking the serial loop for minutes.
const RETRY_AFTER_CAP_SEC = 60;
const MAX_RATE_RETRIES = 5;

// HTML → plain text for the parse-mode-less downgrade resend: tags stripped,
// entities unescaped (&amp; last so unescaping can't mint new entities).
export const stripHtml = (s: string): string =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

// Injectable for tests only — production callers never pass this.
export interface TgSendOpts {
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Send one Telegram message with bounded failure handling:
 *  - 10s request timeout (AbortSignal.timeout);
 *  - 5xx / network errors: 3 retries at 1s/2s/4s, then throw (transient);
 *  - 429: wait retry_after (capped at 60s, max 5 waits); a retry_after above
 *    the cap throws immediately (transient) instead of freezing the loop;
 *  - other 4xx: PERMANENT — retried ONCE with parse_mode dropped (plain text,
 *    HTML stripped) so a formatting bug degrades the message instead of
 *    killing the push; if that also fails, a TelegramPermanentError
 *    (`permanent: true`) is thrown for the engines to keep their claim on.
 */
export async function sendMessage(
  creds: TgCreds,
  html: string,
  opts: TgSendOpts = {},
): Promise<void> {
  try {
    return await postWithRetry(creds, html, true, opts);
  } catch (e) {
    if (!isPermanentSendError(e)) throw e;
    console.warn(
      `[telegram] permanent failure with parse_mode=HTML — downgrading to plain text once: ${e instanceof Error ? e.message : String(e)}`,
    );
    try {
      return await postWithRetry(creds, stripHtml(html), false, opts);
    } catch (e2) {
      // Spec'd as permanent regardless of the downgrade's own failure mode:
      // the original request already failed permanently, and this message must
      // not re-enter the oldest-first queue forever.
      throw new TelegramPermanentError(
        `telegram send failed even after plain-text downgrade: ${e2 instanceof Error ? e2.message : String(e2)}`,
      );
    }
  }
}

// One logical send in a fixed parse mode, with the transient retry loop.
async function postWithRetry(
  creds: TgCreds,
  text: string,
  htmlMode: boolean,
  opts: TgSendOpts,
): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  let transientAttempt = 0; // consumed by 5xx AND network-level failures
  let rateAttempt = 0; // consumed by capped 429 waits

  for (;;) {
    let res: Response;
    try {
      res = await fetch(
        `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: creds.chatId,
            text,
            ...(htmlMode ? { parse_mode: "HTML" } : {}),
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
    } catch (e) {
      // Network-level failure or the 10s timeout — transient.
      const msg = e instanceof Error ? e.message : String(e);
      if (transientAttempt >= TRANSIENT_BACKOFF_MS.length) {
        throw new Error(
          `telegram sendMessage network failure after ${transientAttempt + 1} attempt(s): ${msg}`,
        );
      }
      const delay = TRANSIENT_BACKOFF_MS[transientAttempt++];
      console.warn(
        `[telegram] network error (${msg}) — retry ${transientAttempt}/${TRANSIENT_BACKOFF_MS.length} in ${delay}ms`,
      );
      await sleep(delay);
      continue;
    }

    const data: TgResponse = await res.json().catch(() => ({ ok: false }));
    if (data.ok) return;

    const retryAfter = data.parameters?.retry_after;
    if (res.status === 429 || retryAfter !== undefined) {
      if (retryAfter !== undefined && retryAfter > RETRY_AFTER_CAP_SEC) {
        console.warn(
          `[telegram] rate limited with retry_after=${retryAfter}s (> ${RETRY_AFTER_CAP_SEC}s cap) — throwing for next-cycle re-send instead of blocking the loop`,
        );
        throw new Error(
          `telegram sendMessage rate limited: retry_after=${retryAfter}s exceeds the ${RETRY_AFTER_CAP_SEC}s cap`,
        );
      }
      if (rateAttempt >= MAX_RATE_RETRIES) {
        throw new Error(
          `telegram sendMessage still rate limited after ${rateAttempt} wait(s): ${JSON.stringify(data)}`,
        );
      }
      const waitSec = Math.min(retryAfter ?? 1, RETRY_AFTER_CAP_SEC);
      rateAttempt++;
      console.warn(
        `[telegram] 429 rate limited — waiting ${waitSec}s (retry ${rateAttempt}/${MAX_RATE_RETRIES})`,
      );
      await sleep(waitSec * 1000);
      continue;
    }

    if (res.status >= 500) {
      if (transientAttempt >= TRANSIENT_BACKOFF_MS.length) {
        throw new Error(
          `telegram sendMessage failed (status ${res.status}) after ${transientAttempt + 1} attempt(s): ${JSON.stringify(data)}`,
        );
      }
      const delay = TRANSIENT_BACKOFF_MS[transientAttempt++];
      console.warn(
        `[telegram] server error ${res.status} — retry ${transientAttempt}/${TRANSIENT_BACKOFF_MS.length} in ${delay}ms`,
      );
      await sleep(delay);
      continue;
    }

    if (res.status >= 400 && res.status < 500) {
      // Non-429 4xx: bad entities / bot kicked / chat not found — permanent.
      throw new TelegramPermanentError(
        `telegram sendMessage failed permanently (status ${res.status}): ${JSON.stringify(data)}`,
      );
    }

    // ok:false with a non-error HTTP status (or an unparsable body) — treat as
    // transient-shaped and let the at-least-once path retry next cycle.
    throw new Error(
      `telegram sendMessage failed (status ${res.status}): ${JSON.stringify(data)}`,
    );
  }
}
