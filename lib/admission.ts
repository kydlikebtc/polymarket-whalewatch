import type { DB } from "./db";
import { getWalletStats, type WalletStats } from "./walletStats";
import { MARKET_MAKER_MIN_MARKETS } from "./walletStats";
import { computeScore } from "./smartWallets";
import { evaluateAdmission } from "./admissionGate";
import { runEarlyWinnerScan, type EarlyWinnerScanResult } from "./earlyWinner";

// The quality gate itself lives in lib/admissionGate (shared with the
// category-board seeding — smartWallets importing from HERE would be a
// require cycle); re-exported so gate consumers/tests keep one import site.
export {
  evaluateAdmission,
  ADMIT_MIN_WIN_RATE,
  ADMIT_MIN_SETTLED,
  ADMIT_MIN_ROI,
  ADMIT_MIN_SETTLED_ROI,
  type AdmissionVerdict,
} from "./admissionGate";

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
// Enrichment fans out to network calls (24h-cached per wallet) — bound per run.
export const ADMIT_MAX_ENRICH_PER_RUN = 25;

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
  // (ties → earliest evidence) becomes the source attribution. The window is
  // keyed on evidence_ts (when the BEHAVIOR happened, refreshed on
  // re-observation) — created_at is the frozen first-recorded time and would
  // make a persistently-active wallet look stale after 30 days.
  const rows = db
    .prepare(
      `SELECT address, channel, COUNT(DISTINCT condition_id) AS markets,
              MIN(evidence_ts) AS first_ts
         FROM wallet_candidates
        WHERE evidence_ts >= ?
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
  // Persistent-bot pre-filter: a cached market-maker classification is durable
  // (markets_traded only grows), so re-enriching a known bot every day would
  // let high-evidence bots hog the evaluation slots and starve real
  // candidates. Filter them out BEFORE the slot cap, regardless of cache age.
  const knownBots = new Set(
    (
      db
        .prepare("SELECT wallet FROM wallet_stats WHERE markets_traded >= ?")
        .all(MARKET_MAKER_MIN_MARKETS) as { wallet: string }[]
    ).map((r) => r.wallet.toLowerCase()),
  );
  const candidates = recurrent
    .filter(([addr]) => {
      if (knownBots.has(addr)) return false;
      const src = poolSource.get(addr);
      return src === undefined || src?.startsWith("discovered:");
    })
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, maxEnrichPerRun);

  // Standing members re-qualify on their track record ALONE: recurrence gated
  // their FIRST admission, but once in the pool the detectors skip them
  // (smartTags.has), so no new evidence can accrue — demanding it would
  // starve every member out at the 30-day sweep by construction. Quality
  // decay is still an exit: a failing verdict here skips the refresh and the
  // aging sweep does the rest.
  const inCandidates = new Set(candidates.map(([a]) => a));
  const members: [string, Agg][] = [...poolSource.entries()]
    .filter(
      ([addr, src]) =>
        src?.startsWith("discovered:") &&
        !inCandidates.has(addr) &&
        !knownBots.has(addr),
    )
    .map(([addr, src]) => [
      addr,
      {
        total: 0,
        bestChannel: (src as string).slice("discovered:".length),
        bestMarkets: 0,
        bestFirstTs: 0,
      },
    ]);

  const toEvaluate = [...candidates, ...members];
  if (toEvaluate.length === 0) {
    return { evaluated: 0, admitted: 0, rejectedBot: 0, held: 0 };
  }

  const stats = await getWalletStats(
    db,
    toEvaluate.map(([addr]) => addr),
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
    evaluated: toEvaluate.length,
    admitted: 0,
    rejectedBot: 0,
    held: 0,
  };
  for (const [addr, agg] of toEvaluate) {
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
        `[discovery] ${agg.total > 0 ? `admitted ${addr} via ${agg.bestChannel} · ${agg.total} market(s) of evidence` : `re-qualified standing member ${addr} (${agg.bestChannel})`} · ` +
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
    // The two halves are independent: a gamma outage that kills the settled-
    // market scan must not also swallow the day's admission pass (firehose
    // candidates keep accruing regardless). Failed markets self-heal anyway —
    // no cursor row means tomorrow's 48h listing re-serves them.
    let scan: EarlyWinnerScanResult;
    try {
      scan = await runEarlyWinnerScan(db, { nowSec, ...opts.scan });
    } catch (e) {
      console.error(
        "[discovery] early-winner scan failed — admission still runs:",
        e,
      );
      scan = { candidateMarkets: 0, scanned: 0, evidence: 0, inserted: 0 };
    }
    const admission = await admitCandidates(db, { nowSec, ...opts.admission });
    return { scan, admission };
  })().finally(() => {
    discoveryInFlight = false;
  });
}
