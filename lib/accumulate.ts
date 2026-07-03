import type { Trade } from "./types";
import { notionalUsd, dedupKey } from "./trades";

// One BUY trade, kept for the expandable underlying-orders detail.
export interface AccumBuy {
  ts: number;
  usd: number;
  price: number;
}

export interface AccumGroup {
  wallet: string;
  conditionId: string;
  outcome: string;
  outcomeIndex: number;
  title: string;
  eventSlug: string;
  buyUsd: number;
  sellUsd: number;
  netUsd: number;
  buyCount: number;
  sellCount: number;
  maxSingleBuyUsd: number;
  // Size-weighted average BUY price (the odds the wallet accumulated at):
  // buyUsd / buyShares, or 0 when there are no buys.
  buyShares: number;
  avgBuyPrice: number;
  // Timestamp span across ALL trades in the group (buy AND sell).
  firstTs: number;
  lastTs: number;
  // Each BUY trade, sorted newest-first, for the expandable detail row.
  buys: AccumBuy[];
  // --- suspicion tags (derived from already-fetched rows, zero requests) ---
  // The same wallet also net-bought the OPPOSITE outcome of this market:
  // buying both sides has no directional intent — hedge/arb, not conviction.
  hedgeSuspect: boolean;
  // BINARY markets only: netUsd with each opposite-outcome net buy folded in
  // as an equivalent same-side SELL at (1 − price) — buying S shares of the
  // complement at p equals selling S shares of this outcome at 1−p. Null when
  // there is no hedge or the market is multi-outcome (flag only there: the
  // 1−price identity doesn't hold across >2 outcomes).
  hedgeAdjustedNetUsd: number | null;
  // Direction-alternation rate over the group's chronological trades:
  // side flips / (trades − 1). LOWER BOUND — sells under the fetch floor are
  // invisible, so real churn can only be higher.
  flipRate: number;
  // flipRate above MM_FLIP_RATE: BUY/SELL ping-pong looks like taker
  // market-making inventory management, not directional accumulation.
  mmSuspect: boolean;
}

export interface AccumOptions {
  minNetUsd: number; // display/alert floor on net buy-in
  minBuyCount: number; // >= this many BUY trades to qualify as "split"
  splitCeiling: number; // every BUY must be < this (else it'd have fired a single-trade alert)
  sideConsistency?: number; // require buyUsd >= sideConsistency * sellUsd (default 1.5)
}

// Alternation threshold for the market-making suspicion tag. flipRate is a
// lower bound (sub-floor sells are invisible), so 0.4 already means "at least
// two of every five visible trades reversed direction".
export const MM_FLIP_RATE = 0.4;

// Chronological side-flip rate: flips / (trades − 1). Ties keep insertion
// order (Array#sort is stable), which matches the feed's own ordering.
function computeFlipRate(seq: { ts: number; side: string }[]): number {
  if (seq.length < 2) return 0;
  const ordered = [...seq].sort((a, b) => a.ts - b.ts);
  let flips = 0;
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].side !== ordered[i - 1].side) flips++;
  }
  return flips / (ordered.length - 1);
}

// Group the trade feed by (wallet, conditionId, outcome) to surface split-buy accumulation.
// Dedup within the pull first: offset pagination re-serves boundary rows and one tx carries
// multiple fills, so summing raw rows would double-count.
export function aggregate(trades: Trade[], opts: AccumOptions): AccumGroup[] {
  const { minNetUsd, minBuyCount, splitCeiling, sideConsistency = 1.5 } = opts;
  const seen = new Set<string>();
  const groups = new Map<string, AccumGroup>();
  // Chronological (ts, side) sequence per group for the flip-rate math — kept
  // out of AccumGroup so the API payload doesn't ship every raw row twice.
  const seqs = new Map<string, { ts: number; side: string }[]>();
  for (const t of trades) {
    const dk = dedupKey(t);
    if (seen.has(dk)) continue;
    seen.add(dk);
    const key = `${t.proxyWallet}:${t.conditionId}:${t.outcome}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        wallet: t.proxyWallet,
        conditionId: t.conditionId,
        outcome: t.outcome,
        outcomeIndex: t.outcomeIndex,
        title: t.title,
        eventSlug: t.eventSlug,
        buyUsd: 0,
        sellUsd: 0,
        netUsd: 0,
        buyCount: 0,
        sellCount: 0,
        maxSingleBuyUsd: 0,
        buyShares: 0,
        avgBuyPrice: 0,
        firstTs: t.timestamp,
        lastTs: t.timestamp,
        buys: [],
        hedgeSuspect: false,
        hedgeAdjustedNetUsd: null,
        flipRate: 0,
        mmSuspect: false,
      };
      groups.set(key, g);
      seqs.set(key, []);
    }
    // Track the timestamp span across ALL trades (buy and sell).
    if (t.timestamp < g.firstTs) g.firstTs = t.timestamp;
    if (t.timestamp > g.lastTs) g.lastTs = t.timestamp;
    seqs.get(key)!.push({ ts: t.timestamp, side: t.side });
    const usd = notionalUsd(t);
    if (t.side === "BUY") {
      g.buyUsd += usd;
      g.buyCount += 1;
      g.buyShares += t.size;
      g.buys.push({ ts: t.timestamp, usd, price: t.price });
      if (usd > g.maxSingleBuyUsd) g.maxSingleBuyUsd = usd;
    } else {
      g.sellUsd += usd;
      g.sellCount += 1;
    }
  }

  // First pass: derived per-group fields for EVERY group (qualifying or not),
  // plus a (wallet, market) index — hedge detection must see opposite-outcome
  // net buys even when the opposite group itself wouldn't qualify for display.
  const byWalletMarket = new Map<string, AccumGroup[]>();
  for (const [key, g] of groups) {
    g.netUsd = g.buyUsd - g.sellUsd;
    g.avgBuyPrice = g.buyShares > 0 ? g.buyUsd / g.buyShares : 0;
    g.flipRate = computeFlipRate(seqs.get(key)!);
    g.mmSuspect = g.flipRate > MM_FLIP_RATE;
    const wmKey = `${g.wallet}:${g.conditionId}`;
    const list = byWalletMarket.get(wmKey);
    if (list) list.push(g);
    else byWalletMarket.set(wmKey, [g]);
  }

  const out: AccumGroup[] = [];
  for (const g of groups.values()) {
    // Hedge suspicion: the same wallet net-bought ANOTHER outcome of this
    // market inside the window. Deduction only for binary markets (indices
    // 0/1, exactly two outcomes involved): buying the complement at p is a
    // synthetic same-side SELL at 1−p. Net shares are approximated as
    // netUsd / avgBuyPrice (sells assumed near the buy price band).
    const siblings = byWalletMarket.get(`${g.wallet}:${g.conditionId}`) ?? [];
    const opposites = siblings.filter(
      (s) => s.outcome !== g.outcome && s.netUsd > 0,
    );
    if (opposites.length > 0) {
      g.hedgeSuspect = true;
      const binary =
        g.outcomeIndex <= 1 &&
        opposites.length === 1 &&
        opposites[0].outcomeIndex <= 1 &&
        opposites[0].outcomeIndex !== g.outcomeIndex;
      if (binary) {
        const o = opposites[0];
        if (o.avgBuyPrice > 0 && o.avgBuyPrice < 1) {
          const equivalentSellUsd =
            (o.netUsd / o.avgBuyPrice) * (1 - o.avgBuyPrice);
          g.hedgeAdjustedNetUsd = Math.max(0, g.netUsd - equivalentSellUsd);
        }
      }
    }
    if (
      g.netUsd >= minNetUsd &&
      g.buyCount >= minBuyCount &&
      g.maxSingleBuyUsd < splitCeiling &&
      g.buyUsd >= sideConsistency * g.sellUsd
    ) {
      // Surface the underlying BUYs newest-first for the expandable detail.
      g.buys.sort((a, b) => b.ts - a.ts);
      out.push(g);
    }
  }
  // Suspects sink to the bottom by default — a hedge/market-making group is
  // still shown (the tag explains why), it just never outranks clean
  // directional accumulation.
  out.sort((a, b) => {
    const sa = a.hedgeSuspect || a.mmSuspect ? 1 : 0;
    const sb = b.hedgeSuspect || b.mmSuspect ? 1 : 0;
    if (sa !== sb) return sa - sb;
    return b.netUsd - a.netUsd;
  });
  return out;
}
