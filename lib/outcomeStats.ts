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

/**
 * Wilson interval on the EFFECTIVE sample size — the number of independent
 * markets behind a hit-rate, not the number of alert rows.
 *
 * Why this exists: every alert fired on one market shares that market's single
 * settlement. They are N copies of ONE random draw, not N observations. Live
 * measurement on this project's own history: 3852 settled alerts landed on
 * just 669 markets, with up to 201 rows on a single market (the big fills on
 * one World-Cup match). Treating rows as independent understated the interval
 * by ~1.9× — and flipped the SIGN of several per-bucket conclusions, because
 * the few heavily-alerted markets dominated the naive average.
 *
 * For the settled win-rate the within-market correlation is exactly 1 (same
 * market ⇒ same verdict), so the design effect equals the mean cluster size
 * and the effective n collapses cleanly to the cluster COUNT. For the 1h/24h
 * direction marks the correlation is high but not 1, so using the cluster
 * count there is conservative — deliberately: a too-wide interval understates
 * confidence, a too-narrow one manufactures it.
 *
 * The POINT estimate stays hits/total. "We fired 3852 alerts and 2176 were
 * right" is a true and useful sentence; only the uncertainty around it needs
 * the correction.
 */
export function clusteredInterval(
  hits: number,
  total: number,
  clusters: number,
  z = 1.96,
): { lo: number; hi: number } {
  if (total <= 0) return { lo: 0, hi: 1 };
  // Clamp: 0/absent means "not clustered" and a count above the row count is
  // impossible. Either way fall back to the row count — never let a bad
  // cluster number buy a NARROWER interval than the honest naive one.
  const eff = clusters > 0 && clusters < total ? clusters : total;
  const p = hits / total;
  // wilsonInterval derives p from hits/total, so a fractional numerator is
  // fine here: it carries the observed rate onto the effective denominator.
  return wilsonInterval(p * eff, eff, z);
}

export interface OutcomeTally {
  hits: number;
  total: number;
}

export interface OutcomeStat extends OutcomeTally {
  /**
   * Distinct markets behind `total` — the effective sample size for
   * clusteredInterval. Equals `total` when rows carry no clusterKey.
   */
  clusters: number;
  byType: Record<string, OutcomeTally>;
}

export interface OutcomeSummary {
  /** 10 分钟方向档(2026-08-28):价格影响持久性的「初动」读数。 */
  dir10m: OutcomeStat;
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
  /**
   * Clustering key for the effective sample size — the market (conditionId).
   * Deliberately NOT per-outcome or per-side: in a binary market buying Yes
   * and buying No settle in exact opposition, so counting them as two
   * independent observations would double the effective n out of thin air.
   * Absent/null = the row stands alone (pre-upgrade API keeps today's math).
   */
  clusterKey?: string | null;
}

export interface SummaryOutcome {
  price10m?: number | null;
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
  const empty = (): OutcomeStat => ({
    hits: 0,
    total: 0,
    clusters: 0,
    byType: {},
  });
  const summary: OutcomeSummary = {
    dir10m: empty(),
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
    // Cluster AFTER folding, and per stat: the fold removes re-alerts of one
    // signal, the cluster then merges distinct signals that share a market's
    // single settlement. Counted per stat because the three marks backfill
    // independently — a market present in `settled` may have no 1h price yet.
    const markets = new Set<string>();
    for (const g of foldAlertEscalations(
      graded.map((g) => ({
        ...g,
        foldKey: g.a.foldKey,
        createdAt: g.a.createdAt,
      })),
    )) {
      bump(stat, g.a.type, g.hit);
      // No clusterKey ⇒ the row is its own cluster, keyed by id so two
      // unkeyed rows can never collide into one.
      markets.add(g.a.clusterKey || `#${g.a.id}`);
    }
    stat.clusters = markets.size;
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
    summary.dir10m,
    dirGraded((o) => o.price10m ?? null),
  );
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
