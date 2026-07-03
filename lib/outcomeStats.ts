// Single source of truth for the outcome-validation math, shared by the
// backend scorer (lib/alertOutcomes, the lib/db backfill) and the dashboard
// (app/alerts). Pure and client-safe: no node imports, no db access. Keeping
// the deadband and the win/loss rule in ONE place is the point — a ✅ in the
// table must never disagree with the summary strip about what counts as a hit.

// ε deadband in price units (0.005 = 0.5¢): moves/settles this close to the
// entry price are P&L noise, recorded as a push and excluded from BOTH the
// numerator and the denominator of every hit-rate.
export const OUTCOME_EPSILON = 0.005;

export type DirectionVerdict = "hit" | "miss" | "push";

/**
 * Direction verdict for a follow-through mark (1h/24h price vs the fill
 * price). BUY expects the price to rise, SELL to fall; a move inside the ε
 * deadband is a push.
 */
export function directionVerdict(
  side: string,
  entry: number,
  later: number,
): DirectionVerdict {
  const delta = later - entry;
  if (Math.abs(delta) < OUTCOME_EPSILON) return "push";
  const good = side === "SELL" ? delta < 0 : delta > 0;
  return good ? "hit" : "miss";
}

/**
 * Settlement win/loss judged by P&L direction against the FILL price — not a
 * fixed 0.5 divider. BUY@0.9 settling at 0.6 is a 0.3/share LOSS even though
 * 0.6 > 0.5 (fractional/scalar settlements); BUY@0.3 settling at 0.45 is a
 * real win. Standard 0/1 settlements are unchanged. Returns null for a push:
 * a ≈50/50 resolution (cancelled event / draw ruling) or a settle within ε of
 * the fill — pushes stay out of the win-rate denominator.
 */
export function settleWon(
  side: "BUY" | "SELL",
  entry: number,
  resolutionPrice: number,
): boolean | null {
  if (Math.abs(resolutionPrice - 0.5) < OUTCOME_EPSILON) return null;
  if (Math.abs(resolutionPrice - entry) < OUTCOME_EPSILON) return null;
  return side === "BUY" ? resolutionPrice > entry : resolutionPrice < entry;
}

/**
 * Wilson 95% score interval for a hit-rate — the honest range behind a small
 * sample's point estimate (2/3 reads "67%" but is really ~21%–94%).
 */
export function wilsonInterval(
  hits: number,
  total: number,
  z = 1.96,
): { lo: number; hi: number } {
  if (total <= 0) return { lo: 0, hi: 1 };
  const p = hits / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const half =
    (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

export interface OutcomeTally {
  hits: number;
  total: number;
}

export interface OutcomeStat extends OutcomeTally {
  byType: Record<string, OutcomeTally>;
}

export interface OutcomeSummary {
  dir1h: OutcomeStat;
  dir24h: OutcomeStat;
  settled: OutcomeStat;
}

// Structural inputs — the dashboard's AlertView / AlertOutcome satisfy these.
export interface SummaryAlert {
  id: number;
  type: string;
  side: string;
  price: number;
}

export interface SummaryOutcome {
  price1h: number | null;
  price24h: number | null;
  resolved: boolean;
  won: boolean | null;
}

/**
 * Fold computed outcomes into the validation-strip stats: 1h/24h direction
 * hit-rates plus the settled win-rate, each grouped by alert type — mixing
 * 💰 large with 🏆 smart in one pool lets one bury the other (Simpson's
 * paradox). ε pushes are excluded from numerator AND denominator; settled
 * pushes arrive as won=null and are likewise skipped.
 */
export function summarizeOutcomes(
  alerts: SummaryAlert[],
  outcomes: Record<number, SummaryOutcome>,
): OutcomeSummary {
  const empty = (): OutcomeStat => ({ hits: 0, total: 0, byType: {} });
  const summary: OutcomeSummary = {
    dir1h: empty(),
    dir24h: empty(),
    settled: empty(),
  };
  const bump = (stat: OutcomeStat, type: string, hit: boolean) => {
    stat.total += 1;
    if (hit) stat.hits += 1;
    const t = (stat.byType[type] ??= { hits: 0, total: 0 });
    t.total += 1;
    if (hit) t.hits += 1;
  };
  for (const a of alerts) {
    const o = outcomes[a.id];
    if (!o) continue;
    const marks: [number | null, OutcomeStat][] = [
      [o.price1h, summary.dir1h],
      [o.price24h, summary.dir24h],
    ];
    for (const [later, stat] of marks) {
      if (later == null) continue;
      const v = directionVerdict(a.side, a.price, later);
      if (v === "push") continue;
      bump(stat, a.type, v === "hit");
    }
    if (o.resolved && o.won != null) bump(summary.settled, a.type, o.won);
  }
  return summary;
}
