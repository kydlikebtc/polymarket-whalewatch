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
  // A ≈50/50 resolution (cancelled event / draw ruling) carries no verdict.
  if (Math.abs(resolutionPrice - 0.5) < OUTCOME_EPSILON) return null;
  // Exactly zero P&L is a push at any fill price.
  if (resolutionPrice === entry) return null;
  // The ε-near-the-fill push is only meaningful for FRACTIONAL (scalar)
  // settlements, where landing within half a cent of the fill really is a
  // wash. Applying it to standard 0/1 settlements made the deadband
  // ASYMMETRIC: a 0.997 fill settling at 1 was discarded as a push while the
  // SAME fill settling at 0 counted as a loss — so extreme-conviction alerts
  // could only ever lose (mirrored at the low end: sub-0.005 fills could only
  // ever win). A binary settlement is decisive however extreme the fill was;
  // the call was either right or wrong.
  const isBinary =
    resolutionPrice <= OUTCOME_EPSILON ||
    resolutionPrice >= 1 - OUTCOME_EPSILON;
  if (!isBinary && Math.abs(resolutionPrice - entry) < OUTCOME_EPSILON) {
    return null;
  }
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
  /**
   * Escalation fold key — rows sharing it are ONE signal re-alerted (a
   * consensus growing 2 → 3 → 4 wallets writes three rows, because dedup_key
   * carries walletCount). Absent/null = counted per row, which is right for
   * single fills. Mirrors lib/signalRecord's fold so the dashboard strip and
   * the push footer can never report two different numbers for one event.
   */
  foldKey?: string | null;
  /** Fold tiebreaker: the EARLIEST row survives (the actionable one). */
  createdAt?: number;
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
/**
 * `consensus:0xabc:Yes:3` → `consensus:0xabc:Yes`. A consensus re-alerts as it
 * grows and dedup_key carries the wallet count, so dropping the last segment
 * yields a stable per-(market, outcome) identity with no payload re-parse.
 * lastIndexOf is safe even if an outcome label ever contains a colon: the
 * wallet count never does. Non-consensus rows must pass null — single fills
 * are independent decisions and folding them would delete real samples.
 */
export function consensusFoldKey(dedupKey: string | null): string | null {
  if (!dedupKey) return null;
  const cut = dedupKey.lastIndexOf(":");
  return cut > 0 ? dedupKey.slice(0, cut) : null;
}

/**
 * Collapse re-alerts of one signal down to the row a reader could have acted
 * on — the earliest. Kept local (rather than importing signalRecord's twin)
 * because this module is bundled into the client page and must stay free of
 * the `better-sqlite3` import chain; the two share the rule, not the code.
 *
 * The constraint is structural (only foldKey/createdAt are read) so the bot's
 * market card can reuse it on its own row shape.
 */
export function foldAlertEscalations<
  T extends { foldKey?: string | null; createdAt?: number },
>(alerts: T[]): T[] {
  const earliest = new Map<string, T>();
  const unfoldable: T[] = [];
  for (const a of alerts) {
    if (!a.foldKey) {
      unfoldable.push(a);
      continue;
    }
    const prev = earliest.get(a.foldKey);
    if (!prev || (a.createdAt ?? 0) < (prev.createdAt ?? 0)) {
      earliest.set(a.foldKey, a);
    }
  }
  return [...unfoldable, ...earliest.values()];
}

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
  // Fold PER STAT, after gradability, not once up front. The three marks are
  // backfilled independently per alert id, so a group's formation row can have
  // no price_1h yet while its escalation row does. Folding first would let the
  // ungradable formation row win the fold and delete the whole group from that
  // stat. Same discipline as lib/signalRecord's "filter, then fold".
  const gradeInto = (
    stat: OutcomeStat,
    graded: { a: SummaryAlert; hit: boolean }[],
  ) => {
    for (const g of foldAlertEscalations(
      graded.map((g) => ({
        ...g,
        foldKey: g.a.foldKey,
        createdAt: g.a.createdAt,
      })),
    )) {
      bump(stat, g.a.type, g.hit);
    }
  };
  const dirGraded = (pick: (o: SummaryOutcome) => number | null) => {
    const out: { a: SummaryAlert; hit: boolean }[] = [];
    for (const a of alerts) {
      const o = outcomes[a.id];
      if (!o) continue;
      const later = pick(o);
      if (later == null) continue;
      const v = directionVerdict(a.side, a.price, later);
      if (v === "push") continue; // ε push: out of numerator AND denominator
      out.push({ a, hit: v === "hit" });
    }
    return out;
  };
  gradeInto(
    summary.dir1h,
    dirGraded((o) => o.price1h),
  );
  gradeInto(
    summary.dir24h,
    dirGraded((o) => o.price24h),
  );
  gradeInto(
    summary.settled,
    alerts.flatMap((a) => {
      const o = outcomes[a.id];
      return o && o.resolved && o.won != null ? [{ a, hit: o.won }] : [];
    }),
  );
  return summary;
}
