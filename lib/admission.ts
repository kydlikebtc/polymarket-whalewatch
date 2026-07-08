import type { DB } from "./db";
import { getWalletStats, type WalletStats } from "./walletStats";
import { computeScore } from "./smartWallets";
import { runEarlyWinnerScan, type EarlyWinnerScanResult } from "./earlyWinner";

// ---------------------------------------------------------------------------
// Admission gate: the ONLY path from wallet_candidates into smart_wallets.
// This gate exists because pool membership IS the consensus whitelist —
// smartOnly and detectConsensus check "is the wallet in the table", never a
// score threshold — so an ungated discovery channel would silently redefine
// every downstream signal. Candidacy is free; membership is earned:
//   recurrence (>=3 distinct markets in the window)
//   → enrichment (walletStats: the same due-diligence pipeline seeding uses)
//   → verdict (bots hard-rejected; the record must show real skill).
// Admitted wallets enter as ordinary aging pool members (is_whitelist=0):
// they must keep re-qualifying or the 30-day retention sweep removes them.
// ---------------------------------------------------------------------------

// Recurrence: evidence in >=3 distinct markets inside the window. One market
// can be luck or a single leak; three starts to look like a process.
export const ADMIT_MIN_DISTINCT_MARKETS = 3;
export const ADMIT_EVIDENCE_WINDOW_SEC = 30 * 86_400;
// Quality bar, deliberately NOT the 0-100 score: the score's profit axis
// saturates at $1M and would re-introduce exactly the size bias these
// channels exist to escape. Either a trustworthy settled win rate…
export const ADMIT_MIN_WIN_RATE = 0.55;
export const ADMIT_MIN_SETTLED = 10;
// …or genuine capital efficiency on a profitable book.
export const ADMIT_MIN_ROI = 0.05;
// Enrichment fans out to network calls (24h-cached per wallet) — bound per run.
export const ADMIT_MAX_ENRICH_PER_RUN = 25;

export type AdmissionVerdict = "admit" | "reject_bot" | "hold";

export function evaluateAdmission(stats: WalletStats | null): AdmissionVerdict {
  if (!stats) return "hold"; // enrichment failed — re-evaluated tomorrow
  if (stats.isMarketMaker) return "reject_bot";
  if (
    stats.winRate != null &&
    stats.settledCount >= ADMIT_MIN_SETTLED &&
    stats.winRate >= ADMIT_MIN_WIN_RATE
  ) {
    return "admit";
  }
  if (
    stats.netPnl != null &&
    stats.netPnl > 0 &&
    stats.roi != null &&
    stats.roi >= ADMIT_MIN_ROI
  ) {
    return "admit";
  }
  return "hold";
}

export interface AdmissionResult {
  evaluated: number;
  admitted: number;
  rejectedBot: number;
  held: number;
}

/**
 * One admission pass. Aggregates the evidence window per wallet, enriches the
 * recurrent ones (skipping wallets other pipelines already track), and upserts
 * qualifiers into smart_wallets with source='discovered:<majority channel>'.
 * Re-running is cheap (walletStats 24h cache) and REQUIRED: a still-qualifying
 * discovered wallet has its updated_at renewed here, which is what keeps it
 * ahead of the 30-day aging sweep.
 */
export async function admitCandidates(
  db: DB,
  opts: {
    nowSec?: number;
    evidenceWindowSec?: number;
    minDistinctMarkets?: number;
    maxEnrichPerRun?: number;
    statsFetcher?: (w: string) => Promise<WalletStats>;
  } = {},
): Promise<AdmissionResult> {
  const {
    nowSec = Math.floor(Date.now() / 1000),
    evidenceWindowSec = ADMIT_EVIDENCE_WINDOW_SEC,
    minDistinctMarkets = ADMIT_MIN_DISTINCT_MARKETS,
    maxEnrichPerRun = ADMIT_MAX_ENRICH_PER_RUN,
    statsFetcher,
  } = opts;

  // Per (wallet, channel) recurrence inside the window; the majority channel
  // (ties → earliest evidence) becomes the source attribution.
  const rows = db
    .prepare(
      `SELECT address, channel, COUNT(DISTINCT condition_id) AS markets,
              MIN(evidence_ts) AS first_ts
         FROM wallet_candidates
        WHERE created_at >= ?
        GROUP BY address, channel`,
    )
    .all(nowSec - evidenceWindowSec) as {
    address: string;
    channel: string;
    markets: number;
    first_ts: number;
  }[];
  type Agg = {
    total: number;
    bestChannel: string;
    bestMarkets: number;
    bestFirstTs: number;
  };
  const byWallet = new Map<string, Agg>();
  for (const r of rows) {
    let agg = byWallet.get(r.address);
    if (!agg) {
      agg = {
        total: 0,
        bestChannel: r.channel,
        bestMarkets: 0,
        bestFirstTs: r.first_ts,
      };
      byWallet.set(r.address, agg);
    }
    agg.total += r.markets;
    if (
      r.markets > agg.bestMarkets ||
      (r.markets === agg.bestMarkets && r.first_ts < agg.bestFirstTs)
    ) {
      agg.bestChannel = r.channel;
      agg.bestMarkets = r.markets;
      agg.bestFirstTs = r.first_ts;
    }
  }

  // NOTE: `total` sums distinct markets per channel — the same market seen by
  // two channels counts twice, which is intended (two independent behavioral
  // signatures are stronger evidence than one).
  const recurrent = [...byWallet.entries()].filter(
    ([, agg]) => agg.total >= minDistinctMarkets,
  );
  if (recurrent.length === 0) {
    return { evaluated: 0, admitted: 0, rejectedBot: 0, held: 0 };
  }

  // Wallets other pipelines already track are not discoveries; our own
  // discovered rows ARE re-evaluated (their aging clock renews on re-admit).
  const poolSource = new Map(
    (
      db.prepare("SELECT address, source FROM smart_wallets").all() as {
        address: string;
        source: string | null;
      }[]
    ).map((r) => [r.address.toLowerCase(), r.source]),
  );
  const candidates = recurrent
    .filter(([addr]) => {
      const src = poolSource.get(addr);
      return src === undefined || src?.startsWith("discovered:");
    })
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, maxEnrichPerRun);
  if (candidates.length === 0) {
    return { evaluated: 0, admitted: 0, rejectedBot: 0, held: 0 };
  }

  const stats = await getWalletStats(
    db,
    candidates.map(([addr]) => addr),
    {
      concurrency: 3,
      nowSec,
      ...(statsFetcher ? { fetcher: statsFetcher } : {}),
    },
  );

  const upsert = db.prepare(
    `INSERT INTO smart_wallets (address, score, realized_pnl, win_rate, roi, volume, consistency, is_whitelist, updated_at, source)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       score = excluded.score,
       realized_pnl = excluded.realized_pnl,
       win_rate = excluded.win_rate,
       roi = excluded.roi,
       updated_at = excluded.updated_at,
       source = COALESCE(source, excluded.source)`,
  );
  const result: AdmissionResult = {
    evaluated: candidates.length,
    admitted: 0,
    rejectedBot: 0,
    held: 0,
  };
  for (const [addr, agg] of candidates) {
    const s = stats[addr] ?? null;
    const verdict = evaluateAdmission(s);
    if (verdict === "admit" && s) {
      // No leaderboard vol exists for a discovered wallet: the efficiency
      // axis rides the settled roi (computeScore's preferred input) and the
      // pnl/vol fallback contributes 0 — honest, if conservative.
      const score = computeScore({
        pnl: s.netPnl ?? 0,
        vol: 0,
        winRate: s.winRate,
        roi: s.roi,
        truncated: s.truncated,
      });
      upsert.run(
        addr,
        score,
        s.netPnl,
        s.winRate,
        s.roi,
        nowSec,
        `discovered:${agg.bestChannel}`,
      );
      result.admitted++;
      console.log(
        `[discovery] admitted ${addr} via ${agg.bestChannel} · ${agg.total} market(s) of evidence · ` +
          `wr ${s.winRate != null ? Math.round(s.winRate * 100) + "%" : "—"} · roi ${
            s.roi != null ? Math.round(s.roi * 100) + "%" : "—"
          } · score ${score}`,
      );
    } else if (verdict === "reject_bot") {
      result.rejectedBot++;
    } else {
      result.held++;
    }
  }
  console.log(
    `[discovery] admission: ${result.evaluated} evaluated → ${result.admitted} admitted · ${result.rejectedBot} bot(s) rejected · ${result.held} held`,
  );
  return result;
}

// --- Daily gate ------------------------------------------------------------

const DISCOVERY_DAY_KEY = "discovery_last_day";

const utcDay = (nowSec: number) =>
  new Date(nowSec * 1000).toISOString().slice(0, 10);

// In-process guard: the 4s poll loop calls maybeDailyDiscovery every cycle and
// a scan takes minutes — the day marker is claimed BEFORE the async work for
// the same reason maybeDailySeed's is (a post-hoc marker re-triggers dozens of
// parallel runs). Tradeoff vs seeding: no intra-day failure retry — discovery
// is additive (a lost day costs one day's candidates, not an empty whitelist),
// and per-market failures already self-heal via the un-cursored retry.
let discoveryInFlight = false;

export interface DiscoveryRunResult {
  scan: EarlyWinnerScanResult;
  admission: AdmissionResult;
}

export function maybeDailyDiscovery(
  db: DB,
  opts: {
    nowSec?: number;
    scan?: Parameters<typeof runEarlyWinnerScan>[1];
    admission?: Parameters<typeof admitCandidates>[1];
  } = {},
): Promise<DiscoveryRunResult> | null {
  if (discoveryInFlight) return null;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const today = utcDay(nowSec);
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(DISCOVERY_DAY_KEY) as { value: string | null } | undefined;
  if (row?.value === today) return null;
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    DISCOVERY_DAY_KEY,
    today,
  );
  discoveryInFlight = true;
  return (async () => {
    const scan = await runEarlyWinnerScan(db, { nowSec, ...opts.scan });
    const admission = await admitCandidates(db, { nowSec, ...opts.admission });
    return { scan, admission };
  })().finally(() => {
    discoveryInFlight = false;
  });
}
