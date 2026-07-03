import type { DB } from "./db";
import type { Trade } from "./types";
import type { SmartTag } from "./smartWallets";
import { dedupKey, notionalUsd } from "./trades";
import { cents, durText, esc, short, urlSeg, usd } from "./tgFormat";
import { isPermanentSendError } from "./telegram";

// One smart wallet's aggregated position inside a consensus group.
export interface ConsensusWallet {
  wallet: string;
  netUsd: number;
  buyCount: number;
  avgBuyPrice: number; // size-weighted
  score: number | null;
  winRate: number | null; // settled win rate from the smart tag (0-1)
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
    const tradeUsd = notionalUsd(t);
    if (t.side === "BUY") {
      acc.buyUsd += tradeUsd;
      acc.buyShares += t.size;
      acc.buyCount += 1;
    } else {
      acc.sellUsd += tradeUsd;
    }
  }

  const out: ConsensusGroup[] = [];
  for (const g of groups.values()) {
    const qualified: ConsensusWallet[] = [];
    for (const [wallet, acc] of g.byWallet) {
      const netUsd = acc.buyUsd - acc.sellUsd;
      if (netUsd < opts.minPerWalletUsd) continue;
      const tag = smartTags.get(wallet);
      qualified.push({
        wallet,
        netUsd,
        buyCount: acc.buyCount,
        avgBuyPrice: acc.buyShares > 0 ? acc.buyUsd / acc.buyShares : 0,
        score: tag?.score ?? null,
        winRate: tag?.winRate ?? null,
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

// Push-time context for formatConsensusAlert. Everything is computed locally
// from data the cycle already holds — no new queries.
export interface ConsensusAlertMeta {
  // Clock for the "最近一笔 X 前" half of the time-span line; defaults to now.
  nowSec?: number;
  // Present ONLY when the fetch window was truncated at the page cap: the push
  // then carries an honest lower-bound note instead of silently posing as the
  // full requested window (the dashboard has shown this for a while — Telegram
  // readers were the ones left uninformed).
  coverage?: { coveredSec: number; windowSec: number };
}

export function formatConsensusAlert(
  g: ConsensusGroup,
  meta: ConsensusAlertMeta = {},
): string {
  const nowSec = meta.nowSec ?? Math.floor(Date.now() / 1000);
  const lines = [
    `🔥 <b>聪明钱共识</b> · ${g.walletCount} 个白名单钱包同向买入`,
    `<b>${esc(g.title)}</b>`,
    `${esc(g.outcome)} · 合计净买入 <b>${usd(g.totalNetUsd)}</b> · 均价 ${cents(g.avgBuyPrice)}`,
    // "15 分钟内集中买入" vs "6 小时里分散各买一笔" are very different signals
    // — and under the rolling window an OLD formation would otherwise push
    // with the same face as a fresh one.
    `⏱ 集中于 ${durText(g.lastTs - g.firstTs)}内 · 最近一笔 ${durText(nowSec - g.lastTs)}前`,
  ];
  for (const w of g.wallets.slice(0, 3)) {
    const bits: string[] = [];
    if (w.score != null) bits.push(`评分${Math.round(w.score)}`);
    if (w.winRate != null) bits.push(`胜率${Math.round(w.winRate * 100)}%`);
    const cred = bits.length > 0 ? ` (${bits.join("·")})` : "";
    lines.push(
      `🏆 <a href="https://polymarket.com/profile/${urlSeg(w.wallet)}">${short(w.wallet)}</a>` +
        ` 净买 ${usd(w.netUsd)} @${cents(w.avgBuyPrice)}${cred}`,
    );
  }
  if (g.walletCount > 3) lines.push(`… 及另外 ${g.walletCount - 3} 个钱包`);
  if (meta.coverage) {
    const wh = meta.coverage.windowSec / 3600;
    lines.push(
      `⚠️ 窗口仅覆盖 ~${(meta.coverage.coveredSec / 3600).toFixed(1)}h/` +
        `${Number.isInteger(wh) ? wh : wh.toFixed(1)}h，共识金额为下界`,
    );
  }
  lines.push(
    `<a href="https://polymarket.com/event/${urlSeg(g.eventSlug)}">市场</a>`,
  );
  return lines.join("\n");
}

export interface ConsensusCycleDeps {
  db: DB;
  // effectiveSinceSec (when provided — getTradesWindowDeep always returns it)
  // is the REAL start of the complete merged window. It feeds the coverage log
  // below AND, when the window was truncated, the honest coverage note
  // appended to the Telegram push (see ConsensusAlertMeta.coverage).
  fetchWindow: () => Promise<{
    trades: Trade[];
    truncated: boolean;
    effectiveSinceSec?: number;
  }>;
  getSmart: () => Map<string, SmartTag>;
  send?: (html: string) => Promise<void>;
  opts?: ConsensusOptions;
  // A state row older than this is expired: the group left the rolling window
  // and a re-formation counts as NEWS again (also acts as a periodic reminder
  // for a persistently-held consensus).
  stateTtlSec?: number;
  // Requested window length (sec) — denominator of the coverage log.
  windowSec?: number;
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
    windowSec = 6 * 3600,
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
  const { trades, truncated, effectiveSinceSec } = await fetchWindow();
  // Window-coverage quantification: row count + real coverage vs the requested
  // window, every cycle. A week of these lines is the data needed to decide
  // whether the $2k fetch floor has depth headroom to drop to $1k (coverage
  // consistently >80%) or is already depth-bound at the current floor.
  if (effectiveSinceSec != null) {
    const coveredSec = Math.max(0, nowSec - effectiveSinceSec);
    const pct = Math.min(100, Math.round((coveredSec / windowSec) * 100));
    console.log(
      `[consensus] window: ${trades.length} rows · coverage ${(coveredSec / 3600).toFixed(1)}h/${(windowSec / 3600).toFixed(1)}h (${pct}%) · truncated=${truncated}`,
    );
  }
  // Truncated window → the push must say so: relative to the requested 6h the
  // totals are LOWER BOUNDS (older signals simply invisible this cycle).
  const coverage =
    truncated && effectiveSinceSec != null
      ? {
          coveredSec: Math.max(0, nowSec - effectiveSinceSec),
          windowSec,
        }
      : undefined;
  if (truncated) {
    // The deep fetch trims BOTH sides to the newest truncation edge (see
    // getTradesWindowDeep), so the rows form a complete-but-SHORTER window:
    // netting inside it is honest; signals older than effectiveSinceSec are
    // simply not visible this cycle.
    console.warn(
      `[consensus] window truncated at the page cap (${trades.length} rows) — detection runs on the shortened window`,
    );
  }
  const groups = detectConsensus(trades, smartTags, opts);
  if (groups.length === 0) return 0;
  // Per qualified wallet: the smallest single visible BUY fill (lower bound —
  // fills under the fetch floor are invisible). Minima hugging the floor mean
  // the wallet's real chunks are likely smaller and the floor is masking them
  // ($2k fetch floor vs $5k/wallet qualification mismatch).
  {
    const qualified = new Set<string>();
    for (const g of groups) for (const w of g.wallets) qualified.add(w.wallet);
    const minFill = new Map<string, number>();
    for (const t of trades) {
      if (t.side !== "BUY") continue;
      const w = t.proxyWallet.toLowerCase();
      if (!qualified.has(w)) continue;
      const usdVal = notionalUsd(t);
      const prev = minFill.get(w);
      if (prev == null || usdVal < prev) minFill.set(w, usdVal);
    }
    const dist = [...minFill.values()]
      .map((v) => Math.round(v))
      .sort((a, b) => a - b);
    console.log(
      `[consensus] ${groups.length} group(s) · qualified-wallet min single fill USD: [${dist.join(", ")}]`,
    );
  }

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
        await send(formatConsensusAlert(g, { nowSec, coverage }));
      } catch (e) {
        if (isPermanentSendError(e)) {
          // Poison message (non-429 4xx even after the plain-text downgrade):
          // retrying can never succeed — KEEP the claim and the state update
          // below so this group doesn't jam the consensus loop every cycle.
          console.error(
            `[consensus] permanent send failure for ${dk} — keeping claim, state updated without push:`,
            e,
          );
        } else {
          // Transient: roll back a fresh claim so the group re-fires next
          // cycle (at-least-once); a reminder wrote nothing, so nothing to
          // undo. Known tradeoff: a crash BETWEEN claim and send loses that
          // one push.
          if (claimed) delAlert.run(dk);
          throw e;
        }
      }
    }
    ups.run(g.conditionId, g.outcome, g.walletCount, g.totalNetUsd, nowSec);
    fired++;
  }
  return fired;
}
