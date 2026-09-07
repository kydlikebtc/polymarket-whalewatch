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
//
// Exported so callers that implement their own post-retry degradation (e.g.
// getTradesWindow keeping the already-fetched prefix on a mid-pagination 408)
// classify statuses with the SAME set instead of a drifting copy.
//
// 计量(2026-09-07):每次**尝试**都记一笔到 lib/upstreamMeter(纯内存累加,
// 零 I/O、永不抛),由引擎循环节流落盘。记尝试而不是记逻辑请求 —— 消耗上游
// 预算的是尝试次数,一次 4 连重试对 data-api 就是 4 次。
import { recordUpstreamCall } from "./upstreamMeter";

export const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

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
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        ...(headers ? { headers } : {}),
      });
      const transient = TRANSIENT_STATUS.has(res.status);
      recordUpstreamCall({
        label,
        ms: Date.now() - startedAt,
        status: res.status,
        transient,
      });
      if (res.ok || !transient || i === attempts - 1) {
        return res;
      }
      console.warn(
        `[${label}] transient ${res.status}, retry ${i + 1}/${attempts}`,
      );
    } catch (e) {
      // status=null 与「拿到 5xx」是两种失败:这一类可能根本没到对端。
      recordUpstreamCall({
        label,
        ms: Date.now() - startedAt,
        status: null,
        transient: true,
      });
      lastErr = e;
      if (i === attempts - 1) throw e;
      console.warn(`[${label}] fetch error, retry ${i + 1}/${attempts}`);
    }
    await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
  }
  if (lastErr) throw lastErr;
  throw new Error(`${label}: retries exhausted`);
}
