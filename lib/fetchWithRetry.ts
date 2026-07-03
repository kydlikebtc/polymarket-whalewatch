// Shared bounded-backoff fetch for Polymarket's public APIs (data-api / gamma).
// Extracted verbatim from the /trades fetcher: the Cloudflare front
// intermittently returns 408/5xx on expensive queries (the origin times out
// around ~5.75s). These are transient: a retry almost always succeeds (and
// warms the CDN, so the next attempt is fast). Bounded exponential backoff so
// a probabilistic 408/502 never surfaces to the caller as a hard failure.
//
// Contract kept from the original: non-transient statuses return immediately,
// and the LAST attempt returns the response as-is (even when non-ok) so every
// caller keeps its own `!res.ok` handling.
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface FetchWithRetryOpts {
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  // Log prefix so each caller's retries stay attributable in the shared log.
  label?: string;
}

export async function fetchWithRetry(
  url: string,
  opts: FetchWithRetryOpts = {},
): Promise<Response> {
  const {
    attempts = 4,
    baseDelayMs = 300,
    timeoutMs = 12_000,
    headers,
    label = "fetchWithRetry",
  } = opts;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        ...(headers ? { headers } : {}),
      });
      if (res.ok || !TRANSIENT_STATUS.has(res.status) || i === attempts - 1) {
        return res;
      }
      console.warn(
        `[${label}] transient ${res.status}, retry ${i + 1}/${attempts}`,
      );
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) throw e;
      console.warn(`[${label}] fetch error, retry ${i + 1}/${attempts}`);
    }
    await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
  }
  if (lastErr) throw lastErr;
  throw new Error(`${label}: retries exhausted`);
}
