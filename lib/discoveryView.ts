import type { DB } from "./db";
import { ADMIT_EVIDENCE_WINDOW_SEC } from "./admission";
import { getWalletTagsBatch, type WalletTag } from "./walletTags";

// Read-model for the /discovery dashboard: the candidate funnel (evidence →
// recurrence → verdict) plus the discovery program's output (pool members
// whose source is a discovery channel or a category board). Pure SQLite
// reads — one pass over each table, aggregation in JS. Every row carries its
// derived tags (lib/walletTags) and its full in-window evidence detail, so
// the page can filter by tag and expand a wallet without a second request.

export interface DiscoveryEvidenceDetail {
  channel: string;
  conditionId: string;
  ts: number;
  usd: number;
  price: number;
  note: string;
}

export interface DiscoveryChannelStat {
  channel: string;
  markets: number; // distinct markets with evidence in the window
}

export interface DiscoveryCandidateRow {
  address: string;
  channels: DiscoveryChannelStat[];
  totalMarkets: number; // sum across channels (a market seen by two channels counts twice — two signatures beat one)
  lastTs: number;
  latestNote: string;
  status: "candidate" | "admitted" | "bot";
  tags: WalletTag[];
  evidence: DiscoveryEvidenceDetail[]; // newest first, capped
}

export interface DiscoveryAdmittedRow {
  address: string;
  source: string;
  score: number | null;
  winRate: number | null;
  netPnl: number | null;
  updatedAt: number | null;
  tags: WalletTag[];
  evidence: DiscoveryEvidenceDetail[]; // newest first, capped (often empty)
}

export interface DiscoveryView {
  candidates: DiscoveryCandidateRow[];
  admitted: DiscoveryAdmittedRow[];
  counts: { evidenceRows: number; candidateWallets: number; admitted: number };
}

const CANDIDATE_ROW_CAP = 200;
const EVIDENCE_DETAIL_CAP = 30;
const MARKET_MAKER_MIN_MARKETS = 1000; // mirrors lib/walletStats

export function buildDiscoveryView(
  db: DB,
  nowSec: number = Math.floor(Date.now() / 1000),
): DiscoveryView {
  // Window keyed on evidence_ts (behavior freshness, refreshed on
  // re-observation) — the same basis the admission gate uses.
  const evidence = db
    .prepare(
      `SELECT address, channel, condition_id, evidence_ts, usd, price, note
         FROM wallet_candidates
        WHERE evidence_ts >= ?`,
    )
    .all(nowSec - ADMIT_EVIDENCE_WINDOW_SEC) as {
    address: string;
    channel: string;
    condition_id: string;
    evidence_ts: number;
    usd: number | null;
    price: number | null;
    note: string | null;
  }[];

  type Agg = {
    perChannel: Map<string, Set<string>>;
    lastTs: number;
    latestNote: string;
    details: DiscoveryEvidenceDetail[];
  };
  const byWallet = new Map<string, Agg>();
  for (const r of evidence) {
    let agg = byWallet.get(r.address);
    if (!agg) {
      agg = { perChannel: new Map(), lastTs: 0, latestNote: "", details: [] };
      byWallet.set(r.address, agg);
    }
    let set = agg.perChannel.get(r.channel);
    if (!set) {
      set = new Set();
      agg.perChannel.set(r.channel, set);
    }
    set.add(r.condition_id);
    if (r.evidence_ts >= agg.lastTs) {
      agg.lastTs = r.evidence_ts;
      agg.latestNote = r.note ?? "";
    }
    agg.details.push({
      channel: r.channel,
      conditionId: r.condition_id,
      ts: r.evidence_ts,
      usd: r.usd ?? 0,
      price: r.price ?? 0,
      note: r.note ?? "",
    });
  }
  const detailsOf = (address: string): DiscoveryEvidenceDetail[] =>
    (byWallet.get(address)?.details ?? [])
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, EVIDENCE_DETAIL_CAP);

  const poolSource = new Map(
    (
      db
        .prepare(
          "SELECT address, source, score, win_rate, realized_pnl, updated_at FROM smart_wallets",
        )
        .all() as {
        address: string;
        source: string | null;
        score: number | null;
        win_rate: number | null;
        realized_pnl: number | null;
        updated_at: number | null;
      }[]
    ).map((r) => [r.address.toLowerCase(), r]),
  );
  const bots = new Set(
    (
      db
        .prepare("SELECT wallet FROM wallet_stats WHERE markets_traded >= ?")
        .all(MARKET_MAKER_MIN_MARKETS) as { wallet: string }[]
    ).map((r) => r.wallet.toLowerCase()),
  );

  const candidates: DiscoveryCandidateRow[] = [...byWallet.entries()]
    .map(([address, agg]) => {
      const channels = [...agg.perChannel.entries()]
        .map(([channel, set]) => ({ channel, markets: set.size }))
        .sort((a, b) => b.markets - a.markets);
      const totalMarkets = channels.reduce((s, c) => s + c.markets, 0);
      const status: DiscoveryCandidateRow["status"] = poolSource.has(address)
        ? "admitted"
        : bots.has(address)
          ? "bot"
          : "candidate";
      return {
        address,
        channels,
        totalMarkets,
        lastTs: agg.lastTs,
        latestNote: agg.latestNote,
        status,
        tags: [] as WalletTag[], // filled below in one batch
        evidence: detailsOf(address),
      };
    })
    .sort((a, b) => b.totalMarkets - a.totalMarkets || b.lastTs - a.lastTs)
    .slice(0, CANDIDATE_ROW_CAP);

  // The discovery program's output: every pool member that did NOT come from
  // the global boards — graduated candidates and category-board specialists.
  const admitted: DiscoveryAdmittedRow[] = [...poolSource.values()]
    .filter(
      (r) =>
        r.source != null &&
        (r.source.startsWith("discovered:") ||
          r.source.startsWith("category:")),
    )
    .map((r) => {
      const address = r.address.toLowerCase();
      return {
        address,
        source: r.source as string,
        score: r.score,
        winRate: r.win_rate,
        netPnl: r.realized_pnl,
        updatedAt: r.updated_at,
        tags: [] as WalletTag[],
        evidence: detailsOf(address),
      };
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  // One batch tag derivation over every surfaced wallet.
  const tagged = getWalletTagsBatch(
    db,
    [...candidates.map((c) => c.address), ...admitted.map((a) => a.address)],
    nowSec,
  );
  for (const c of candidates) c.tags = tagged.get(c.address) ?? [];
  for (const a of admitted) a.tags = tagged.get(a.address) ?? [];

  return {
    candidates,
    admitted,
    counts: {
      evidenceRows: evidence.length,
      candidateWallets: byWallet.size,
      admitted: admitted.length,
    },
  };
}
