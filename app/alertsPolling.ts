// Pure decision helpers for the alerts page's polling loops, extracted from
// app/alerts/page.tsx so the change-detection / throttle logic is unit-
// testable without a DOM (same pattern as tableView.ts / urlQuery.ts).

// /api/alert-outcomes throttle: the 1h/24h marks it backfills move on an
// HOURLY scale, so re-POSTing on every 5s data poll (an open tab with any
// unresolved alert ≈ 17k POSTs/day) was pure waste. Between new-alert
// arrivals, one refresh per minute is plenty.
export const OUTCOMES_MIN_INTERVAL_MS = 60_000;

// Change-detection fingerprint for a poll payload: row count + max alert id.
// An identical fingerprint means the list content cannot have changed (alerts
// are append-only with AUTOINCREMENT ids), so the page skips setData and the
// [data]-effects (outcomes POST, new-alert chime scan) don't re-run every 5s
// over an unchanged list.
export function alertsSnapshot(alerts: ReadonlyArray<{ id: number }>): string {
  let maxId = 0;
  for (const a of alerts) if (a.id > maxId) maxId = a.id;
  return `${alerts.length}:${maxId}`;
}

// POST gate for /api/alert-outcomes. Fire immediately when an id we have
// NEVER queried shows up (a fresh alert wants its marks ASAP); otherwise only
// after the throttle interval — unresolved rows re-poll on the minute-scale
// tick instead of riding the 5s data poll.
export function shouldFetchOutcomes(args: {
  wantIds: number[];
  knownIds: ReadonlySet<number>;
  lastFetchAt: number;
  nowMs: number;
  minIntervalMs?: number;
}): boolean {
  const {
    wantIds,
    knownIds,
    lastFetchAt,
    nowMs,
    minIntervalMs = OUTCOMES_MIN_INTERVAL_MS,
  } = args;
  if (wantIds.length === 0) return false;
  if (wantIds.some((id) => !knownIds.has(id))) return true;
  return nowMs - lastFetchAt >= minIntervalMs;
}
