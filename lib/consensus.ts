import type { DB } from "./db";
import type { Trade } from "./types";
import type { SmartTag } from "./smartWallets";
import { dedupKey, notionalUsd } from "./trades";

// One smart wallet's aggregated position inside a consensus group.
export interface ConsensusWallet {
  wallet: string;
  netUsd: number;
  buyCount: number;
  avgBuyPrice: number; // size-weighted
  score: number | null;
}

// N distinct smart wallets net-buying the SAME outcome of the SAME market
// inside the window — the "informed consensus" signal.
export interface ConsensusGroup {
  conditionId: string;
  outcome: string;
  title: string;
  eventSlug: string;
  // Token identity for the alert_outcomes validation loop: every member trade
  // of a (conditionId, outcome) group fills the SAME token, so any member's
  // asset/outcomeIndex identify the group's token.
  asset: string;
  outcomeIndex: number;
  wallets: ConsensusWallet[]; // qualified only, sorted by netUsd desc
  walletCount: number;
  totalNetUsd: number;
  avgBuyPrice: number; // usd-weighted across qualified wallets
  firstTs: number;
  lastTs: number;
}

export interface ConsensusOptions {
  minWallets: number; // >= N distinct smart wallets per group
  minPerWalletUsd: number; // each wallet's NET buy >= this
}

export const DEFAULT_CONSENSUS: ConsensusOptions = {
  minWallets: 2,
  minPerWalletUsd: 5000,
};

/**
 * Pure detection over a trade window: keep smart-wallet trades, aggregate net
 * buy-in per (conditionId, outcome, wallet), then surface groups where at
 * least `minWallets` DISTINCT smart wallets each net-bought >= the floor.
 * Rows are deduped first (offset pagination re-serves boundary rows).
 * Two or three unrelated high-win-rate wallets converging on one outcome is a
 * far stronger signal than any single whale fill.
 */
export function detectConsensus(
  trades: Trade[],
  smartTags: Map<string, SmartTag>,
  opts: ConsensusOptions = DEFAULT_CONSENSUS,
): ConsensusGroup[] {
  const seen = new Set<string>();
  type Acc = {
    buyUsd: number;
    sellUsd: number;
    buyShares: number;
    buyCount: number;
  };
  const groups = new Map<
    string,
    {
      conditionId: string;
      outcome: string;
      title: string;
      eventSlug: string;
      asset: string;
      outcomeIndex: number;
      firstTs: number;
      lastTs: number;
      byWallet: Map<string, Acc>;
    }
  >();
  for (const t of trades) {
    const wallet = t.proxyWallet.toLowerCase();
    if (!smartTags.has(wallet)) continue;
    const dk = dedupKey(t);
    if (seen.has(dk)) continue;
    seen.add(dk);
    const key = `${t.conditionId}:${t.outcome}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        conditionId: t.conditionId,
        outcome: t.outcome,
        title: t.title,
        eventSlug: t.eventSlug,
        asset: t.asset,
        outcomeIndex: t.outcomeIndex,
        firstTs: t.timestamp,
        lastTs: t.timestamp,
        byWallet: new Map(),
      };
      groups.set(key, g);
    }
    if (t.timestamp < g.firstTs) g.firstTs = t.timestamp;
    if (t.timestamp > g.lastTs) g.lastTs = t.timestamp;
    let acc = g.byWallet.get(wallet);
    if (!acc) {
      acc = { buyUsd: 0, sellUsd: 0, buyShares: 0, buyCount: 0 };
      g.byWallet.set(wallet, acc);
    }
    const usd = notionalUsd(t);
    if (t.side === "BUY") {
      acc.buyUsd += usd;
      acc.buyShares += t.size;
      acc.buyCount += 1;
    } else {
      acc.sellUsd += usd;
    }
  }

  const out: ConsensusGroup[] = [];
  for (const g of groups.values()) {
    const qualified: ConsensusWallet[] = [];
    for (const [wallet, acc] of g.byWallet) {
      const netUsd = acc.buyUsd - acc.sellUsd;
      if (netUsd < opts.minPerWalletUsd) continue;
      qualified.push({
        wallet,
        netUsd,
        buyCount: acc.buyCount,
        avgBuyPrice: acc.buyShares > 0 ? acc.buyUsd / acc.buyShares : 0,
        score: smartTags.get(wallet)?.score ?? null,
      });
    }
    if (qualified.length < opts.minWallets) continue;
    qualified.sort((a, b) => b.netUsd - a.netUsd);
    const totalNetUsd = qualified.reduce((s, w) => s + w.netUsd, 0);
    const totalShareWeighted = qualified.reduce(
      (s, w) => s + (w.avgBuyPrice > 0 ? w.netUsd / w.avgBuyPrice : 0),
      0,
    );
    out.push({
      conditionId: g.conditionId,
      outcome: g.outcome,
      title: g.title,
      eventSlug: g.eventSlug,
      asset: g.asset,
      outcomeIndex: g.outcomeIndex,
      wallets: qualified,
      walletCount: qualified.length,
      totalNetUsd,
      // USD-weighted average of the wallets' average buy prices.
      avgBuyPrice:
        totalShareWeighted > 0 ? totalNetUsd / totalShareWeighted : 0,
      firstTs: g.firstTs,
      lastTs: g.lastTs,
    });
  }
  out.sort((a, b) => b.totalNetUsd - a.totalNetUsd);
  return out;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function formatConsensusAlert(g: ConsensusGroup): string {
  const lines = [
    `🔥 <b>聪明钱共识</b> · ${g.walletCount} 个白名单钱包同向买入`,
    `<b>${esc(g.title)}</b>`,
    `${esc(g.outcome)} · 合计净买入 ${usd(g.totalNetUsd)} · 均价 ${g.avgBuyPrice.toFixed(3)}`,
  ];
  for (const w of g.wallets.slice(0, 3)) {
    const score = w.score != null ? ` (评分${Math.round(w.score)})` : "";
    lines.push(
      `🏆 <a href="https://polymarket.com/profile/${w.wallet}">${short(w.wallet)}</a>` +
        ` 净买 ${usd(w.netUsd)} @${w.avgBuyPrice.toFixed(3)}${score}`,
    );
  }
  if (g.walletCount > 3) lines.push(`… 及另外 ${g.walletCount - 3} 个钱包`);
  lines.push(`<a href="https://polymarket.com/event/${g.eventSlug}">市场</a>`);
  return lines.join("\n");
}

export interface ConsensusCycleDeps {
  db: DB;
  fetchWindow: () => Promise<{ trades: Trade[]; truncated: boolean }>;
  getSmart: () => Map<string, SmartTag>;
  send?: (html: string) => Promise<void>;
  opts?: ConsensusOptions;
  // A state row older than this is expired: the group left the rolling window
  // and a re-formation counts as NEWS again (also acts as a periodic reminder
  // for a persistently-held consensus).
  stateTtlSec?: number;
  nowSec?: number;
}

// With an empty whitelist every consensus cycle silently no-ops on a 5-min
// cadence — an all-day-blank pool (seed never ran, or failed and is pending
// retry) would be indistinguishable from "no signal". Warn hourly, not per
// cycle, so the cause is diagnosable from the logs without spamming them.
const EMPTY_WHITELIST_WARN_INTERVAL_SEC = 3600;
let lastEmptyWhitelistWarnTs = -Infinity;

/**
 * One consensus detection cycle. Fires an alert when a group FORMS or grows to
 * more wallets than previously alerted (escalation); a same-or-smaller group
 * within the state TTL stays silent. Returns alerts fired.
 */
export async function runConsensusCycle(
  deps: ConsensusCycleDeps,
): Promise<number> {
  const {
    db,
    fetchWindow,
    getSmart,
    send,
    opts = DEFAULT_CONSENSUS,
    stateTtlSec = 6 * 3600,
    nowSec = Math.floor(Date.now() / 1000),
  } = deps;
  const smartTags = getSmart();
  if (smartTags.size === 0) {
    // Whitelist not seeded yet (or the daily seed failed — see maybeDailySeed
    // retry markers in the same logs).
    if (
      nowSec - lastEmptyWhitelistWarnTs >=
      EMPTY_WHITELIST_WARN_INTERVAL_SEC
    ) {
      lastEmptyWhitelistWarnTs = nowSec;
      console.warn(
        "[consensus] whitelist empty — smart-wallet seed has not completed (or failed); consensus detection is idle",
      );
    }
    return 0;
  }
  const { trades, truncated } = await fetchWindow();
  if (truncated) {
    // Newest-first pagination hit its page cap: the fetched prefix is still a
    // complete, self-consistent (shorter) window, but early SELL legs beyond
    // it are missing — netUsd for long-running accumulators may be overstated.
    console.warn(
      `[consensus] window truncated at the page cap (${trades.length} rows) — detection runs on the shortened window`,
    );
  }
  const groups = detectConsensus(trades, smartTags, opts);
  if (groups.length === 0) return 0;

  const sel = db.prepare(
    "SELECT wallet_count, last_alert_ts FROM consensus_state WHERE condition_id = ? AND outcome = ?",
  );
  const ups = db.prepare(
    `INSERT OR REPLACE INTO consensus_state (condition_id, outcome, wallet_count, total_usd, last_alert_ts)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insAlert = db.prepare(
    "INSERT OR IGNORE INTO alerts (type, dedup_key, payload, created_at) VALUES (?, ?, ?, ?)",
  );
  const selAlert = db.prepare(
    "SELECT created_at FROM alerts WHERE type = 'consensus' AND dedup_key = ?",
  );
  const delAlert = db.prepare(
    "DELETE FROM alerts WHERE type = 'consensus' AND dedup_key = ?",
  );
  let fired = 0;
  for (const g of groups) {
    const row = sel.get(g.conditionId, g.outcome) as
      { wallet_count: number; last_alert_ts: number } | undefined;
    const expired = row ? nowSec - row.last_alert_ts > stateTtlSec : false;
    const isNews = !row || expired || g.walletCount > row.wallet_count;
    if (!isNews) continue;
    const dk = `consensus:${g.conditionId}:${g.outcome}:${g.walletCount}`;
    // Claim-then-send: the unique (type, dedup_key) index makes this INSERT a
    // cross-process preemption lock (embedded engine + standalone worker on
    // one db). changes === 0 means the row already exists — two very
    // different cases:
    //  (a) a RECENT row: the other process claimed this exact formation/
    //      escalation moments ago and owns the push + state update → skip;
    //  (b) an OLD row (> stateTtlSec): that is OUR OWN original alert and this
    //      is the TTL-expiry reminder — no new alerts row (matches the old OR
    //      IGNORE semantics), push proceeds. Reminder pushes are the one path
    //      two processes can still rarely both take.
    const claimed =
      insAlert.run("consensus", dk, JSON.stringify(g), nowSec).changes === 1;
    if (!claimed) {
      const prior = selAlert.get(dk) as { created_at: number } | undefined;
      if (prior && nowSec - prior.created_at <= stateTtlSec) {
        console.log(`[consensus] skip ${dk}: claimed by another process`);
        continue;
      }
    }
    if (send) {
      try {
        await send(formatConsensusAlert(g));
      } catch (e) {
        // Roll back a fresh claim so the group re-fires next cycle
        // (at-least-once); a reminder wrote nothing, so nothing to undo.
        // Known tradeoff: a crash BETWEEN claim and send loses that one push.
        if (claimed) delAlert.run(dk);
        throw e;
      }
    }
    ups.run(g.conditionId, g.outcome, g.walletCount, g.totalNetUsd, nowSec);
    fired++;
  }
  return fired;
}
