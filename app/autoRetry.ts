// One-shot auto retry for the scanner pages' failed pulls. The upstream
// origin times out (~5.75s → 408) on expensive cold-cache queries — first
// load AND filter switches (new baseKey → new cold deep pull) both hit it —
// and fetchWithRetry's back-to-back attempts all land on the same cold cache.
// Those failed attempts WARM it though, so a single delayed retry usually
// succeeds where the user would otherwise mash 刷新. Pure predicate extracted
// (same pattern as tableView.ts / alertsPolling.ts) so the decision is
// unit-testable without a DOM.

import { useCallback, useEffect, useRef, useState } from "react";

// Long enough for the upstream cache to finish warming from our own failed
// attempts (empirically seconds-scale), short enough to not feel stuck.
export const AUTO_RETRY_DELAY_MS = 4_000;

/**
 * Whether an error response should trigger the one-shot automatic retry.
 * Retry only when there is nothing displayable to fall back on (no rows in
 * the response and no success since the budget was last armed — i.e. NOT a
 * background auto-refresh failing over an already-shown table) and the
 * budget for this user-triggered pull hasn't been spent. A retry that fails
 * again surfaces the error normally.
 */
export function shouldScheduleAutoRetry(args: {
  hasError: boolean;
  rowCount: number;
  hadSuccessSinceArm: boolean;
  budgetUsed: boolean;
}): boolean {
  const { hasError, rowCount, hadSuccessSinceArm, budgetUsed } = args;
  return hasError && rowCount === 0 && !hadSuccessSinceArm && !budgetUsed;
}

/**
 * Page-side wiring: watch the latest response; when a pull comes back as an
 * error with nothing displayable, schedule ONE delayed retry and report
 * `retrying: true` while it is pending so the page can show a "预热中" notice
 * instead of the error callout. The budget re-arms on every user-triggered
 * pull: automatically when `retry` (the filter-bound load) changes identity,
 * and via the returned `rearm()` for the manual 刷新 button. The timer is
 * cleaned up on unmount, on the next response, and on filter changes.
 */
export function useAutoRetryOnError(
  data: { error?: string } | null,
  rowCount: number,
  retry: () => void,
): { retrying: boolean; rearm: () => void } {
  const budgetUsed = useRef<boolean>(false);
  const hadSuccess = useRef<boolean>(false);
  // Last response object already dispositioned — effect re-runs caused by a
  // `retry` identity change (filter switch) must NOT reschedule a retry for
  // the stale error while the fresh pull is already in flight.
  const handled = useRef<{ error?: string } | null>(null);
  const [retrying, setRetrying] = useState<boolean>(false);

  const rearm = useCallback(() => {
    budgetUsed.current = false;
    hadSuccess.current = false;
  }, []);

  // A filter change produces a new `retry` identity = a fresh user-triggered
  // pull, which deserves its own single retry. (Declared BEFORE the
  // scheduling effect so the reset wins the same render pass.)
  useEffect(() => {
    rearm();
  }, [retry, rearm]);

  useEffect(() => {
    if (!data || handled.current === data) return;
    handled.current = data;
    if (!data.error) {
      hadSuccess.current = true;
      setRetrying(false);
      return;
    }
    if (
      !shouldScheduleAutoRetry({
        hasError: true,
        rowCount,
        hadSuccessSinceArm: hadSuccess.current,
        budgetUsed: budgetUsed.current,
      })
    ) {
      // Second failure of the same pull (or a background-refresh failure):
      // stop masking it — the page falls back to its normal error callout.
      setRetrying(false);
      return;
    }
    budgetUsed.current = true;
    setRetrying(true);
    console.warn(
      `[autoRetry] pull failed ("${data.error}") — retrying once in ${AUTO_RETRY_DELAY_MS}ms (upstream cache warm-up)`,
    );
    const id = setTimeout(retry, AUTO_RETRY_DELAY_MS);
    return () => clearTimeout(id);
  }, [data, rowCount, retry]);

  return { retrying, rearm };
}
