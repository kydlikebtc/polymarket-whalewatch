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

export interface SignalRecord {
  settled: number; // outcomes with a win/loss verdict (pushes excluded)
  wins: number;
  /** Σ fill price — the wins the market itself implied at those same prices. */
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

interface Row {
  won: number;
  price: number | null;
}

function record(rows: Row[]): SignalRecord {
  // A row with no fill price has no benchmark and so cannot be graded — it
  // leaves BOTH sides of the ledger, the same discipline pushes get.
  const graded = rows.filter(
    (r): r is Row & { price: number } =>
      typeof r.price === "number" && Number.isFinite(r.price),
  );
  const wins = graded.reduce((s, r) => s + (r.won === 1 ? 1 : 0), 0);
  const implied = graded.reduce((s, r) => s + r.price, 0);
  const variance = graded.reduce((s, r) => s + r.price * (1 - r.price), 0);
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
      `SELECT ao.won, ${ENTRY_PRICE_SQL} AS price FROM alerts a
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
      `SELECT ao.won, ${ENTRY_PRICE_SQL} AS price FROM alerts a
       JOIN alert_outcomes ao ON ao.alert_id = a.id
       WHERE a.type = ? AND a.created_at >= ? AND ao.won IS NOT NULL`,
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
