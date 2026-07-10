import type { Trade } from "./types";
import type { SmartTag } from "./smartWallets";
import { dedupKey, notionalUsd } from "./trades";

/**
 * Per-USD quality multiplier for a wallet's net buy, driven by its smart-money
 * score: score 0 (or unknown) keeps a 0.2 FLOOR so the wallet still counts but
 * is heavily discounted; score 100 saturates at 1.0. This is the "秤砣" that
 * makes the disagreement tilt reflect WHO is buying, not just how much — a
 * top-score wallet's $10k outweighs a fresh wallet's $20k.
 */
export function qualityWeight(score: number | null | undefined): number {
  const s = score == null ? 0 : Math.max(0, Math.min(100, score));
  return 0.2 + 0.8 * (s / 100);
}

// One wallet's net-buy position on a single side of a disagreement.
export interface DisagreementWallet {
  wallet: string;
  netUsd: number;
  score: number | null;
  winRate: number | null;
  avgBuyPrice: number; // size-weighted
}

// All net-buying smart money on ONE outcome of a contested market.
export interface DisagreementSide {
  outcome: string;
  outcomeIndex: number;
  asset: string;
  walletCount: number;
  netUsd: number; // raw net buy-in (for display)
  weightedUsd: number; // Σ netUsd × qualityWeight(score) — drives the tilt
  avgBuyPrice: number; // usd-weighted across the side's buyers
  wallets: DisagreementWallet[]; // net buyers, sorted by netUsd desc
}

// "lopsided" = one side's quality-weight dominates (a "金矿"-shaped split);
// "balanced" = smart money is genuinely split (真·势均力敌).
export type Tilt = "lopsided" | "balanced";

// A market where whitelisted smart money is net-buying >= 2 opposing outcomes.
export interface DisagreementMarket {
  conditionId: string;
  title: string;
  // MARKET slug — drives the dashboard's ⧉ copy / ↗ trade-page affordance.
  slug: string;
  eventSlug: string;
  sides: DisagreementSide[]; // >= 2, sorted by weightedUsd desc
  totalNetUsd: number;
  totalWeightedUsd: number;
  tiltPct: number; // sides[0].weightedUsd / totalWeightedUsd (0.5..1)
  tilt: Tilt;
  excludedWallets: number; // hedgers dropped for playing both sides
  firstTs: number;
  lastTs: number;
}

export interface DisagreementOptions {
  minPerSideUsd: number; // each side's net buy >= this
  minWalletsPerSide: number; // each side needs >= this many net buyers
  lopsidedTiltPct: number; // tiltPct >= this → lopsided, else balanced
}

export const DEFAULT_DISAGREEMENT: DisagreementOptions = {
  minPerSideUsd: 5000,
  minWalletsPerSide: 1,
  lopsidedTiltPct: 0.7,
};

type WalletAcc = { buyUsd: number; sellUsd: number; buyShares: number };

/**
 * Pure detection over a trade window: find markets where whitelisted smart
 * money is NET-BUYING two or more OPPOSING outcomes of the same market — the
 * "smart-money disagreement" signal. Mirrors detectConsensus's per-(market,
 * outcome, wallet) net-buy aggregation, then:
 *  - drops any wallet net-buying >= 2 outcomes of one market (a hedger /
 *    market-maker playing both sides — fake opposition, not an opinion);
 *  - builds a SIDE per outcome from the remaining NET BUYERS (a net seller of
 *    an outcome is exiting, not "buying" that side);
 *  - keeps sides clearing the per-side USD + wallet floors;
 *  - surfaces the market when >= 2 sides qualify, sorted by QUALITY-WEIGHTED
 *    amount, with a tilt (lopsided vs balanced).
 * Read-only monitoring: reports WHO is split and how the weight leans — never a
 * follow/skip recommendation.
 */
export function detectDisagreement(
  trades: Trade[],
  smartTags: Map<string, SmartTag>,
  opts: DisagreementOptions = DEFAULT_DISAGREEMENT,
): DisagreementMarket[] {
  const seen = new Set<string>();
  const markets = new Map<
    string,
    {
      title: string;
      slug: string;
      eventSlug: string;
      firstTs: number;
      lastTs: number;
      byOutcome: Map<
        string,
        {
          outcomeIndex: number;
          asset: string;
          byWallet: Map<string, WalletAcc>;
        }
      >;
    }
  >();

  // Aggregate net buy per (conditionId, outcome, wallet) — smart wallets only,
  // deduped (offset pagination re-serves boundary rows).
  for (const t of trades) {
    const wallet = t.proxyWallet.toLowerCase();
    if (!smartTags.has(wallet)) continue;
    const dk = dedupKey(t);
    if (seen.has(dk)) continue;
    seen.add(dk);

    let m = markets.get(t.conditionId);
    if (!m) {
      m = {
        title: t.title,
        slug: t.slug,
        eventSlug: t.eventSlug,
        firstTs: t.timestamp,
        lastTs: t.timestamp,
        byOutcome: new Map(),
      };
      markets.set(t.conditionId, m);
    }
    if (t.timestamp < m.firstTs) m.firstTs = t.timestamp;
    if (t.timestamp > m.lastTs) m.lastTs = t.timestamp;

    let o = m.byOutcome.get(t.outcome);
    if (!o) {
      o = { outcomeIndex: t.outcomeIndex, asset: t.asset, byWallet: new Map() };
      m.byOutcome.set(t.outcome, o);
    }
    let acc = o.byWallet.get(wallet);
    if (!acc) {
      acc = { buyUsd: 0, sellUsd: 0, buyShares: 0 };
      o.byWallet.set(wallet, acc);
    }
    const usdVal = notionalUsd(t);
    if (t.side === "BUY") {
      acc.buyUsd += usdVal;
      acc.buyShares += t.size;
    } else {
      acc.sellUsd += usdVal;
    }
  }

  const out: DisagreementMarket[] = [];
  for (const [conditionId, m] of markets) {
    // Fake-opposition: a wallet NET-BUYING >= 2 outcomes of this market is a
    // hedger/market-maker, not a directional opinion — exclude from every side.
    // (Net-buying one outcome while net-SELLING another is directionally
    // consistent — e.g. bullish Yes, trimming No — and is NOT excluded.)
    const netBuyOutcomes = new Map<string, number>();
    for (const o of m.byOutcome.values()) {
      for (const [wallet, acc] of o.byWallet) {
        if (acc.buyUsd - acc.sellUsd > 0) {
          netBuyOutcomes.set(wallet, (netBuyOutcomes.get(wallet) ?? 0) + 1);
        }
      }
    }
    const excluded = new Set<string>();
    for (const [wallet, n] of netBuyOutcomes) if (n >= 2) excluded.add(wallet);

    // Build a side per outcome from the remaining NET BUYERS.
    const sides: DisagreementSide[] = [];
    for (const [outcome, o] of m.byOutcome) {
      const wallets: DisagreementWallet[] = [];
      let netUsd = 0;
      let weightedUsd = 0;
      let sumBuyUsd = 0;
      let sumBuyShares = 0;
      for (const [wallet, acc] of o.byWallet) {
        if (excluded.has(wallet)) continue;
        const net = acc.buyUsd - acc.sellUsd;
        if (net <= 0) continue; // net sellers aren't buying this side
        const smart = smartTags.get(wallet);
        const score = smart?.score ?? null;
        netUsd += net;
        weightedUsd += net * qualityWeight(score);
        sumBuyUsd += acc.buyUsd;
        sumBuyShares += acc.buyShares;
        wallets.push({
          wallet,
          netUsd: net,
          score,
          winRate: smart?.winRate ?? null,
          avgBuyPrice: acc.buyShares > 0 ? acc.buyUsd / acc.buyShares : 0,
        });
      }
      if (wallets.length < opts.minWalletsPerSide) continue;
      if (netUsd < opts.minPerSideUsd) continue;
      wallets.sort((a, b) => b.netUsd - a.netUsd);
      sides.push({
        outcome,
        outcomeIndex: o.outcomeIndex,
        asset: o.asset,
        walletCount: wallets.length,
        netUsd,
        weightedUsd,
        avgBuyPrice: sumBuyShares > 0 ? sumBuyUsd / sumBuyShares : 0,
        wallets,
      });
    }

    if (sides.length < 2) continue; // no opposing sides → not a disagreement
    sides.sort((a, b) => b.weightedUsd - a.weightedUsd);
    const totalWeightedUsd = sides.reduce((s, x) => s + x.weightedUsd, 0);
    const totalNetUsd = sides.reduce((s, x) => s + x.netUsd, 0);
    const tiltPct =
      totalWeightedUsd > 0 ? sides[0].weightedUsd / totalWeightedUsd : 0;
    out.push({
      conditionId,
      title: m.title,
      slug: m.slug,
      eventSlug: m.eventSlug,
      sides,
      totalNetUsd,
      totalWeightedUsd,
      tiltPct,
      tilt: tiltPct >= opts.lopsidedTiltPct ? "lopsided" : "balanced",
      excludedWallets: excluded.size,
      firstTs: m.firstTs,
      lastTs: m.lastTs,
    });
  }

  // Biggest quality-weighted contest first — a simple, stable default order.
  out.sort((a, b) => b.totalWeightedUsd - a.totalWeightedUsd);
  return out;
}
