import type { Trade } from "./types";
import type { SmartTag } from "./smartWallets";
import {
  DEFAULT_CONSENSUS,
  detectConsensus,
  type ConsensusGroup,
} from "./consensus";
import {
  DEFAULT_DISAGREEMENT,
  detectDisagreement,
  type DisagreementMarket,
} from "./disagreement";
import { aggregate, type AccumGroup } from "./accumulate";
import { dedupKey } from "./trades";
import {
  avgBuyPrice,
  exposureUsd,
  netShares,
  type PositionAcc,
} from "./netPosition";
import { fetchWithRetry } from "./fetchWithRetry";
import { parseTradeRows } from "./polymarket";

// Single-market signal card (the "10-second conclusion" surface): everything
// this tool knows about ONE market, composed from modules that already exist —
// consensus/disagreement classification (same mutex as the push path), smart
// money's retained exposure per outcome (P0.6 cost-basis measure), split-buy
// accumulators, all off one market-scoped trade window. Pure composition over
// an injected window; the API route owns fetching, ages and alert history.

export interface SmartFlowWallet {
  wallet: string;
  exposureUsd: number;
  netShares: number;
  avgBuyPrice: number;
  score: number | null;
  winRate: number | null;
  isMarketMaker: boolean;
}

export interface SmartOutcomeFlow {
  outcome: string;
  totalExposureUsd: number;
  wallets: SmartFlowWallet[];
}

export type MarketClassification =
  | { kind: "consensus"; group: ConsensusGroup }
  | { kind: "disagreement"; market: DisagreementMarket }
  | { kind: "none" };

export interface MarketBrief {
  classification: MarketClassification;
  smartFlow: SmartOutcomeFlow[];
  accum: AccumGroup[];
}

// Split-buy surfacing floors for the card — looser than the board's default
// $10k (a card about ONE market wants the mid-size accumulators too).
const CARD_ACCUM = { minNetUsd: 2000, minBuyCount: 3, splitCeiling: 10_000 };
const MAX_WALLETS_PER_OUTCOME = 8;
const MAX_ACCUM_ROWS = 5;

export function composeMarketBrief(
  trades: Trade[],
  smartTags: Map<string, SmartTag>,
  conditionId: string,
): MarketBrief {
  const own: Trade[] = [];
  const seen = new Set<string>();
  for (const t of trades) {
    if (t.conditionId !== conditionId) continue;
    const dk = dedupKey(t);
    if (seen.has(dk)) continue;
    seen.add(dk);
    own.push(t);
  }

  // Classification, same order and thresholds as every other surface:
  // contested wins over one-sided (mutex), one-sided consensus over none.
  const contested = detectDisagreement(own, smartTags, DEFAULT_DISAGREEMENT);
  const mine = contested.find((m) => m.conditionId === conditionId);
  let classification: MarketClassification;
  if (mine) {
    classification = { kind: "disagreement", market: mine };
  } else {
    const groups = detectConsensus(own, smartTags, DEFAULT_CONSENSUS)
      .filter((g) => g.conditionId === conditionId)
      .sort((a, b) => b.totalNetUsd - a.totalNetUsd);
    classification =
      groups.length > 0
        ? { kind: "consensus", group: groups[0] }
        : { kind: "none" };
  }

  // Smart-money retained exposure per (outcome, wallet) — every pool member
  // shows here (including MMs, labeled; unlike voting, the card is a ledger).
  const acc = new Map<string, Map<string, PositionAcc>>(); // outcome -> wallet -> acc
  for (const t of own) {
    const wallet = t.proxyWallet.toLowerCase();
    if (!smartTags.has(wallet)) continue;
    let byWallet = acc.get(t.outcome);
    if (!byWallet) {
      byWallet = new Map();
      acc.set(t.outcome, byWallet);
    }
    let a = byWallet.get(wallet);
    if (!a) {
      a = { buyUsd: 0, sellUsd: 0, buyShares: 0, sellShares: 0 };
      byWallet.set(wallet, a);
    }
    const usd = t.size * t.price;
    if (t.side === "BUY") {
      a.buyUsd += usd;
      a.buyShares += t.size;
    } else {
      a.sellUsd += usd;
      a.sellShares += t.size;
    }
  }
  const smartFlow: SmartOutcomeFlow[] = [];
  for (const [outcome, byWallet] of acc) {
    const wallets: SmartFlowWallet[] = [];
    for (const [wallet, a] of byWallet) {
      if (netShares(a) <= 0) continue; // flat/net-short — nothing retained
      const t = smartTags.get(wallet);
      wallets.push({
        wallet,
        exposureUsd: exposureUsd(a),
        netShares: netShares(a),
        avgBuyPrice: avgBuyPrice(a),
        score: t?.score ?? null,
        winRate: t?.winRate ?? null,
        isMarketMaker: t?.isMarketMaker === true,
      });
    }
    if (wallets.length === 0) continue;
    wallets.sort((a, b) => b.exposureUsd - a.exposureUsd);
    smartFlow.push({
      outcome,
      totalExposureUsd: wallets.reduce((s, w) => s + w.exposureUsd, 0),
      wallets: wallets.slice(0, MAX_WALLETS_PER_OUTCOME),
    });
  }
  smartFlow.sort((a, b) => b.totalExposureUsd - a.totalExposureUsd);

  const accum = aggregate(own, CARD_ACCUM)
    .filter((g) => g.conditionId === conditionId)
    .slice(0, MAX_ACCUM_ROWS);

  return { classification, smartFlow, accum };
}

// ---------------------------------------------------------------------------
// Input resolution: conditionId / market slug / pasted Polymarket URL.
// ---------------------------------------------------------------------------

export type MarketInput =
  { kind: "cid"; value: string } | { kind: "slug"; value: string };

export function parseMarketInput(raw: string): MarketInput | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return { kind: "cid", value: s };
  // URL (or path): the last non-empty path segment is the slug; strip query.
  const noQuery = s.split(/[?#]/)[0];
  const segs = noQuery.split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  return last ? { kind: "slug", value: last } : null;
}

// ---------------------------------------------------------------------------
// Market-scoped trade window: /trades?market=<cid> newest-first, early-stopped
// at sinceSec (unlike earlyWinner's full-history sweep — a LIVE card wants the
// recent window, not the archive).
// ---------------------------------------------------------------------------

const DATA_API = "https://data-api.polymarket.com";
const PAGE_LIMIT = 250;
const MAX_OFFSET = 3000; // verified data-api hard cap

export async function fetchMarketWindow(
  conditionId: string,
  opts: {
    minUsd?: number;
    sinceSec: number;
    fetcher?: (url: string) => Promise<Response>;
  },
): Promise<{ trades: Trade[]; truncated: boolean }> {
  const {
    minUsd = 500,
    sinceSec,
    fetcher = (url: string) =>
      fetchWithRetry(url, { timeoutMs: 12_000, label: "fetchMarketWindow" }),
  } = opts;
  const out: Trade[] = [];
  let offset = 0;
  for (;;) {
    if (offset > MAX_OFFSET) return { trades: out, truncated: true };
    const url =
      `${DATA_API}/trades?market=${encodeURIComponent(conditionId)}` +
      `&filterType=CASH&filterAmount=${minUsd}&takerOnly=true&limit=${PAGE_LIMIT}&offset=${offset}`;
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`fetchMarketWindow ${res.status}`);
    const rows = parseTradeRows(await res.json(), "fetchMarketWindow");
    for (const t of rows) if (t.timestamp >= sinceSec) out.push(t);
    const oldest = rows.length > 0 ? rows[rows.length - 1].timestamp : 0;
    if (rows.length < PAGE_LIMIT || oldest < sinceSec) {
      return { trades: out, truncated: false };
    }
    offset += PAGE_LIMIT;
  }
}
