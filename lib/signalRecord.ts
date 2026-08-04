import type { DB } from "./db";

// Push-embedded signal track record (P0.14): every Telegram alert carries the
// verifiable 30-day record of its own source — the wallet for large/smart
// fills, the signal type for consensus. This is the channel's whole
// differentiation: the validation loop grades every signal (worker backfill,
// full denominator), and the push shows the grade instead of hiding it. The
// entire ecosystem either fabricates social proof or can't verify its claims;
// we publish ours on every message, small samples honestly labeled.
//
// The grade is PRICE-ADJUSTED, because in a prediction market the fill price
// IS the market's own probability estimate — it is the benchmark. A raw hit
// rate silently benchmarks against 50%, which is never the right number: a
// wallet buying favourites at 0.85 "wins" 85% of the time without saying
// anything the market didn't already know, while one buying longshots at 0.20
// looks awful at 30% while crushing it. (A live sample made this concrete: a
// 47% hit rate read like losing, but the fills averaged 0.546 — the market
// expected 34.9 wins and got 30, a gap well inside noise.) So the record
// reports three things: how many the source hit, how many the MARKET expected
// it to hit at those same prices, and whether the gap outruns luck.

// SIDE MATTERS. The benchmark is the market's implied probability of THE
// EVENT THE SIGNAL BET ON, and a SELL bets on the opposite event: settleWon
// grades a SELL as a win when `resolutionPrice < entry`, so at a fill of 0.20
// the market's own expectation of that win is 0.80, not 0.20. Summing raw fill
// prices got this exactly backwards on the sell side — 10 SELL@0.20 fills all
// settling at 0 (a textbook zero-edge outcome the market priced at 80%) came
// out as wins=10 vs implied=2.0, an excess of +8.0 at 6.3σ, and the push
// printed "已超运气范围". The SD is untouched: p(1−p) is symmetric about 0.5,
// so only the CENTRE of the null was wrong, which is the half that decides
// whether a strategy looks like alpha.
export interface SignalRecord {
  settled: number; // outcomes with a win/loss verdict (pushes excluded)
  wins: number;
  /**
   * Σ market-implied probability of each signal's own win condition — the wins
   * the market itself expected at those same prices. BUY contributes `price`,
   * SELL contributes `1 − price`.
   */
  implied: number;
  /** wins − implied. Positive = beat the market's own pricing. */
  excess: number;
  /**
   * SD of `wins` under the efficient-market null (√Σ p(1−p)) — the yardstick
   * for whether `excess` means anything at this sample size.
   */
  sd: number;
}

const WINDOW_DAYS = 30;
// Below this, any inference is numerology — show the raw tally, labeled.
const MIN_RECORD_SAMPLE = 5;
// |excess| beyond this many SDs is reported as clearing the noise floor.
const SIGNIFICANCE_SD = 2;

// large/smart carry the fill price directly; consensus carries the group's
// usd-weighted average buy price under a different key (same "entry" the
// validation loop measures against — see app/api/alerts). Verified present on
// 100% of rows of all three types.
const ENTRY_PRICE_SQL = `COALESCE(json_extract(a.payload, '$.price'), json_extract(a.payload, '$.avgBuyPrice'))`;

// Consensus payloads carry no `side` — a consensus IS net buying, so the
// absent key defaults to BUY rather than dropping the row.
const SIDE_SQL = `COALESCE(json_extract(a.payload, '$.side'), 'BUY')`;

// Escalation fold key. A consensus re-alerts as it escalates — the dedup_key
// is `consensus:<cid>:<outcome>:<walletCount>` (consensus.ts), so a group going
// 2 → 3 → 4 wallets writes THREE alerts rows for ONE signal. Counting them per
// row double-counts, and not neutrally: escalated groups are by construction
// the STRONGER groups, so the record is inflated exactly where it flatters.
// The three rows are also plainly not independent, which breaks the Bernoulli
// assumption behind sd = √Σp(1−p) and makes "已超运气范围" fire too easily.
// Rows lacking either key part fold-key to NULL — never merged, since a wrong
// merge silently deletes real samples while a missed merge only over-counts.
const FOLD_KEY_SQL = `CASE WHEN a.type = 'consensus'
    THEN json_extract(a.payload, '$.conditionId') || '|' || json_extract(a.payload, '$.outcome')
    ELSE NULL END`;

export interface GradedRow {
  won: number;
  price: number | null;
  /** "BUY" | "SELL"; absent/unknown reads as BUY (see SIDE_SQL). */
  side?: string | null;
  /** Rows sharing a non-null key are ONE signal seen twice (see FOLD_KEY_SQL). */
  foldKey?: string | null;
  /** Fold tiebreaker — the EARLIEST row survives (see foldEscalations). */
  createdAt?: number | null;
}

/**
 * Collapse re-alerts of the same signal to the row a reader could actually
 * have acted on: the FORMATION one. Keeping the earliest (rather than the
 * latest, or an average) is the only choice that grades the signal at the
 * price it was first published at — the later escalation rows quote a price
 * the market had already moved to.
 *
 * Folding runs over ALREADY-GRADED rows, so the rare case where a formation
 * row settled as a push (≈50/50, excluded upstream) while its escalation did
 * not falls back to the escalation. That is the honest outcome: something was
 * gradeable, and it is still counted exactly once.
 */
export function foldEscalations<T extends GradedRow>(rows: T[]): T[] {
  const earliest = new Map<string, T>();
  const unfoldable: T[] = [];
  for (const r of rows) {
    if (!r.foldKey) {
      unfoldable.push(r);
      continue;
    }
    const prev = earliest.get(r.foldKey);
    // Strict <: on a created_at tie the first row wins, and callers order by
    // (created_at, id) so "first" is deterministic across runs.
    if (!prev || (r.createdAt ?? 0) < (prev.createdAt ?? 0)) {
      earliest.set(r.foldKey, r);
    }
  }
  return [...unfoldable, ...earliest.values()];
}

/**
 * The market's own probability of THIS signal's win condition. A SELL wins
 * when the price falls, and the market prices that at 1 − p.
 */
function impliedWinProb(
  price: number,
  side: string | null | undefined,
): number {
  return side === "SELL" ? 1 - price : price;
}

/**
 * The one place the price-adjusted grade is computed. Exported so every
 * surface (push footer, signal feed, dashboard) reports the SAME number from
 * the SAME rule — a second implementation is how "16/20 中" ends up meaning
 * two different things in two places.
 */
export function gradeRows(rows: GradedRow[]): SignalRecord {
  return record(rows);
}

type Row = GradedRow;

function record(rows: Row[]): SignalRecord {
  // A row with no fill price has no benchmark and so cannot be graded — it
  // leaves BOTH sides of the ledger, the same discipline pushes get.
  // Price-filter BEFORE folding, not after: folding first would let a
  // priceless formation row win the fold and then get dropped, deleting a
  // signal its own escalation could have graded.
  const graded = foldEscalations(
    rows.filter(
      (r): r is Row & { price: number } =>
        typeof r.price === "number" && Number.isFinite(r.price),
    ),
  );
  const wins = graded.reduce((s, r) => s + (r.won === 1 ? 1 : 0), 0);
  const implied = graded.reduce(
    (s, r) => s + impliedWinProb(r.price, r.side),
    0,
  );
  // p(1−p) is symmetric, so the SD is side-invariant — written through
  // impliedWinProb anyway so the null hypothesis has exactly one definition.
  const variance = graded.reduce((s, r) => {
    const p = impliedWinProb(r.price, r.side);
    return s + p * (1 - p);
  }, 0);
  return {
    settled: graded.length,
    wins,
    implied,
    excess: wins - implied,
    sd: Math.sqrt(variance),
  };
}

/**
 * The wallet's own large/smart signal record over the last 30 days: alerts
 * this tool fired on the wallet's fills, joined to their settled outcomes.
 * `won IS NOT NULL` excludes both unsettled markets and 50-50 pushes — the
 * denominator is decisions, same as the dashboard's win-rate strip.
 */
export function walletSignalRecord(
  db: DB,
  wallet: string,
  opts: { nowSec?: number; days?: number } = {},
): SignalRecord {
  const { nowSec = Math.floor(Date.now() / 1000), days = WINDOW_DAYS } = opts;
  const rows = db
    .prepare(
      `SELECT ao.won, ${ENTRY_PRICE_SQL} AS price, ${SIDE_SQL} AS side FROM alerts a
       JOIN alert_outcomes ao ON ao.alert_id = a.id
       WHERE a.type IN ('large', 'smart')
         AND a.created_at >= ?
         AND lower(json_extract(a.payload, '$.proxyWallet')) = ?
         AND ao.won IS NOT NULL`,
    )
    .all(nowSec - days * 86_400, wallet.toLowerCase()) as Row[];
  return record(rows);
}

/** A signal TYPE's 30-day record (the consensus push carries its own grade). */
export function typeSignalRecord(
  db: DB,
  type: string,
  opts: { nowSec?: number; days?: number } = {},
): SignalRecord {
  const { nowSec = Math.floor(Date.now() / 1000), days = WINDOW_DAYS } = opts;
  const rows = db
    .prepare(
      `SELECT ao.won, ${ENTRY_PRICE_SQL} AS price, ${SIDE_SQL} AS side,
              ${FOLD_KEY_SQL} AS foldKey, a.created_at AS createdAt
       FROM alerts a
       JOIN alert_outcomes ao ON ao.alert_id = a.id
       WHERE a.type = ? AND a.created_at >= ? AND ao.won IS NOT NULL
       ORDER BY a.created_at ASC, a.id ASC`,
    )
    .all(type, nowSec - days * 86_400) as Row[];
  return record(rows);
}

/**
 * One honest line for the push footer, or null when there is nothing to say.
 *
 * Wording rules, ordered by how badly getting them wrong would hurt:
 *   1. The market's own expectation prints NEXT TO the hit count, never
 *      omitted — it is the only thing that makes the hit count readable.
 *   2. The excess never appears without a verdict on the noise floor, so a
 *      −5.1 or +5.1 can't be quoted as though it were a finding.
 *   3. Small samples show the raw tally and say so, instead of dressing up
 *      four data points.
 *
 * This replaced "剔除运气后至少 X%" (the Wilson lower bound of the RAW hit
 * rate). That line was the most quotable thing in every push and it was
 * indefensible: it discounted sampling luck but never the market baseline, so
 * 16/20 fills bought at 0.90 — two wins WORSE than the market — still printed
 * "at least 58%", while a genuinely edge-positive longshot book printed "at
 * least 30%". It claimed in words to have removed luck while leaving the
 * benchmark untouched.
 */
export function formatRecordLine(
  label: string,
  r: SignalRecord,
): string | null {
  if (r.settled === 0) return null;
  const head = `📐 ${label} 30d 信号:${r.wins}/${r.settled} 中`;
  if (r.settled < MIN_RECORD_SAMPLE) return `${head}（样本不足）`;
  const excess = `${r.excess >= 0 ? "+" : "−"}${Math.abs(r.excess).toFixed(1)}`;
  const beyondLuck = r.sd > 0 && Math.abs(r.excess) >= SIGNIFICANCE_SD * r.sd;
  const verdict = beyondLuck ? "已超运气范围" : "仍在运气范围内";
  return `${head} · 市场同价位预期 ${r.implied.toFixed(1)} 中 · 超额 ${excess}（${verdict}）`;
}
