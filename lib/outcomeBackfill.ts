import type { DB } from "./db";
import { computeAlertOutcomes, type OutcomeDeps } from "./alertOutcomes";

// Worker-driven outcome backfill. computeAlertOutcomes used to run only when
// someone opened the dashboard (/api/alert-outcomes), so the "validation loop"
// statistics silently covered just the alerts that happened to be VIEWED — a
// biased sample. This cycle makes the worker itself sweep every non-terminal
// alert on a fixed cadence, so the win-rate denominator is always the full
// alert history regardless of anyone watching.
//
// The per-alert semantics (due marks, immutable-price caching, 6h null-retry
// backoff, settlement via gamma meta) all live in computeAlertOutcomes and are
// reused as-is; this module only decides WHICH alerts to hand it each cycle.

export interface OutcomeBackfillState {
  // Rotation cursor: id of the OLDEST alert processed so far in the current
  // sweep; the next cycle continues strictly below it. null = start a fresh
  // sweep from the newest alert. Guarantees every candidate gets a turn even
  // when maxPerCycle clips a large backlog (newest-first alone would starve
  // the tail forever).
  cursorId: number | null;
  // Alerts whose payloads can never be tracked (pre-upgrade consensus rows,
  // malformed JSON). Probed once per process, then excluded from selection —
  // without this they'd occupy cycle slots forever. In-memory on purpose:
  // a restart re-probes them once, which is cheap (no network, just a parse).
  untrackable: Set<number>;
}

export function createBackfillState(): OutcomeBackfillState {
  return { cursorId: null, untrackable: new Set() };
}

export interface OutcomeBackfillOpts {
  outcomes: OutcomeDeps;
  // Per-cycle ceiling on alerts handed to compute. Bounds the worst-case
  // upstream burst (a cold backlog can owe two prices-history calls per
  // alert); the cursor rotation drains anything beyond the cap on later
  // cycles instead of dropping it.
  maxPerCycle?: number;
  // computeAlertOutcomes builds an IN(...) with one placeholder per id, so
  // batches stay well under SQLite's variable limit and one batch failure
  // only loses that batch.
  batchSize?: number;
  compute?: typeof computeAlertOutcomes; // test seam
}

export interface OutcomeBackfillResult {
  // Non-terminal alerts in the db (minus known-untrackable) — the honest
  // "how much validation work exists" number, independent of the cap.
  pending: number;
  processed: number; // ids handed to compute this cycle
  updated: number; // ids compute reported an outcome for
  newlyUntrackable: number;
  wrapped: boolean; // this cycle reached the oldest candidate; next starts fresh
}

// Terminal = settled AND both follow-through marks present. Everything else
// still has (or may still get) work: missing rows, unresolved markets, and
// null marks the 6h backoff will retry.
const CANDIDATE_WHERE = `
  (ao.alert_id IS NULL
   OR ao.resolved = 0
   OR ao.price_1h IS NULL
   OR ao.price_24h IS NULL)`;

const DEFAULT_MAX_PER_CYCLE = 500;
const DEFAULT_BATCH_SIZE = 100;

export async function runOutcomeBackfillCycle(
  db: DB,
  state: OutcomeBackfillState,
  opts: OutcomeBackfillOpts,
): Promise<OutcomeBackfillResult> {
  const {
    maxPerCycle = DEFAULT_MAX_PER_CYCLE,
    batchSize = DEFAULT_BATCH_SIZE,
    compute = computeAlertOutcomes,
  } = opts;

  const rawPending = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM alerts a
         LEFT JOIN alert_outcomes ao ON ao.alert_id = a.id
         WHERE ${CANDIDATE_WHERE}`,
      )
      .get() as { n: number }
  ).n;
  // Untrackable ids always match the WHERE (they never get an outcome row),
  // so subtracting the set size keeps `pending` an honest work count.
  const pending = Math.max(0, rawPending - state.untrackable.size);

  // Over-select by the skip-set size so untrackable rows sitting inside the
  // window can't shrink the effective batch below maxPerCycle.
  const selected = (
    db
      .prepare(
        `SELECT a.id FROM alerts a
         LEFT JOIN alert_outcomes ao ON ao.alert_id = a.id
         WHERE ${CANDIDATE_WHERE} AND (? IS NULL OR a.id < ?)
         ORDER BY a.id DESC
         LIMIT ?`,
      )
      .all(
        state.cursorId,
        state.cursorId,
        maxPerCycle + state.untrackable.size,
      ) as { id: number }[]
  ).map((r) => r.id);

  const filtered = selected.filter((id) => !state.untrackable.has(id));
  const ids = filtered.slice(0, maxPerCycle);
  // Clipped = the over-selection grabbed more TRACKABLE rows than the cap;
  // the sliced-off tail was selected but NOT processed, so the cursor must
  // stop at the last processed id — jumping past the tail would starve the
  // same rows on every sweep (window geometry repeats while the backlog is
  // stable). When not clipped, advance past everything selected (including
  // trailing untrackables).
  const clipped = filtered.length > maxPerCycle;

  // Wrapped when selection ran out of rows below the cursor — the sweep is
  // complete and the next cycle restarts from the newest alert (picking up
  // whatever arrived meanwhile).
  const wrapped =
    !clipped && selected.length < maxPerCycle + state.untrackable.size;
  state.cursorId = wrapped
    ? null
    : clipped
      ? ids[ids.length - 1] // selected is DESC → last element = min processed
      : Math.min(...selected);

  let updated = 0;
  let newlyUntrackable = 0;
  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    try {
      const out = await compute(db, chunk, opts.outcomes);
      updated += Object.keys(out).length;
      // compute returns an entry for every TRACKABLE id (even all-null
      // outcomes get a first-touch row) — absence means the payload can never
      // be tracked. Only judged on a batch that succeeded: a thrown batch
      // says nothing about its ids and they must retry on a later sweep.
      for (const id of chunk) {
        if (!(id in out)) {
          state.untrackable.add(id);
          newlyUntrackable++;
        }
      }
    } catch (e) {
      console.warn(
        `[outcomeBackfill] batch failed (${chunk.length} alert(s), first id ${chunk[0]}):`,
        e,
      );
    }
  }

  return { pending, processed: ids.length, updated, newlyUntrackable, wrapped };
}
