import type { DB } from "./db";
import { wilsonInterval } from "./outcomeStats";

// Push-embedded signal track record (P0.14): every Telegram alert carries the
// verifiable 30-day record of its own source — the wallet for large/smart
// fills, the signal type for consensus. This is the channel's whole
// differentiation: the validation loop grades every signal (worker backfill,
// full denominator), and the push shows the grade instead of hiding it. The
// entire ecosystem either fabricates social proof or can't verify its claims;
// we publish ours on every message, small samples honestly labeled.

export interface SignalRecord {
  settled: number; // outcomes with a win/loss verdict (pushes excluded)
  wins: number;
  wilsonLo: number; // Wilson 95% lower bound of the hit rate
}

const WINDOW_DAYS = 30;
// Below this, a Wilson bound is numerology — show the raw count, labeled.
const MIN_WILSON_SAMPLE = 5;

function record(rows: { won: number }[]): SignalRecord {
  const settled = rows.length;
  const wins = rows.reduce((s, r) => s + (r.won === 1 ? 1 : 0), 0);
  return { settled, wins, wilsonLo: wilsonInterval(wins, settled).lo };
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
      `SELECT ao.won FROM alerts a
       JOIN alert_outcomes ao ON ao.alert_id = a.id
       WHERE a.type IN ('large', 'smart')
         AND a.created_at >= ?
         AND lower(json_extract(a.payload, '$.proxyWallet')) = ?
         AND ao.won IS NOT NULL`,
    )
    .all(nowSec - days * 86_400, wallet.toLowerCase()) as { won: number }[];
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
      `SELECT ao.won FROM alerts a
       JOIN alert_outcomes ao ON ao.alert_id = a.id
       WHERE a.type = ? AND a.created_at >= ? AND ao.won IS NOT NULL`,
    )
    .all(type, nowSec - days * 86_400) as { won: number }[];
  return record(rows);
}

/**
 * One honest line for the push footer, or null when there is nothing to say.
 * Small samples show the raw tally explicitly labeled instead of a bound that
 * would be statistical theater.
 *
 * Wording: the bound is the Wilson 95% lower bound, but channel readers must
 * not need a statistics background — "剔除运气后至少 X%" states exactly what
 * the number means (small-sample luck discounted, this is the floor we can
 * defend). The technical term lives in the glossary, not the push.
 */
export function formatRecordLine(
  label: string,
  r: SignalRecord,
): string | null {
  if (r.settled === 0) return null;
  if (r.settled < MIN_WILSON_SAMPLE) {
    return `📐 ${label} 30d 信号:${r.wins}/${r.settled} 中（样本不足）`;
  }
  return `📐 ${label} 30d 信号:${r.wins}/${r.settled} 中 · 剔除运气后至少 ${Math.round(r.wilsonLo * 100)}%`;
}
