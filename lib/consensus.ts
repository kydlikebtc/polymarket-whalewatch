import type { DB } from "./db";
import type { Trade } from "./types";
import type { SmartTag } from "./smartWallets";
import { dedupKey, latestPriceByAsset, notionalUsd } from "./trades";
import { cents, durText, esc, short, urlSeg, usd } from "./tgFormat";
import { isPermanentSendError } from "./telegram";
import { DEFAULT_DISAGREEMENT, detectDisagreement } from "./disagreement";
import { isSettled, type MarketMeta } from "./gamma";
import { avgBuyPrice, exposureUsd, netShares } from "./netPosition";
import { formatRecordLine, typeSignalRecord } from "./signalRecord";
import { recordConsensusCycle } from "./cycleMetrics";
// Runtime-safe despite marketSignals importing FROM this module: that import
// is type-only (erased at compile), so no require cycle exists.
import { excludeContestedFromConsensus } from "./marketSignals";

// One smart wallet's aggregated position inside a consensus group.
export interface ConsensusWallet {
  wallet: string;
  // 成本敞口(P0.6 净股数口径):留存净股数 × 买入均价。等股买卖不同价 → 0,
  // 纯买入(无卖出)时与旧的 buyUsd − sellUsd 现金流口径数值一致。
  netUsd: number;
  buyCount: number;
  avgBuyPrice: number; // size-weighted
  score: number | null;
  winRate: number | null; // settled win rate from the smart tag (0-1)
  // 该钱包累计净买 **最后一次** 从 <minPerWalletUsd 升到 ≥minPerWalletUsd 的那笔
  // 成交 timestamp(last upward crossing,保持到窗口末尾;中途跌回再跨则覆盖)。
  // 只对幸存 qualified 钱包有意义 —— 窗口末尾 net ≥ floor 保证至少跨过一次线。
  qualifiedTs: number;
}

// N distinct smart wallets net-buying the SAME outcome of the SAME market
// inside the window — the "informed consensus" signal.
export interface ConsensusGroup {
  conditionId: string;
  outcome: string;
  title: string;
  // MARKET slug (the per-market key gamma /markets?slug= takes) — drives the
  // dashboard's ⧉ copy / ↗ trade-page affordance; eventSlug is the fallback.
  slug: string;
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
  // 共识「形成时刻」= qualified 钱包 qualifiedTs 升序第 minWallets 个 ——
  // 即"第 N 人到位"时刻;qualified 数 > minWallets 时仍取第 minWallets 个
  // (共识最早成立的时刻不因后来者加入而变晚)。与 lastTs 的关键区别:lastTs 被
  // 组内任何白名单成交(含 SELL、含不达标非成员)刷新,曾把 5 小时前形成的老共识
  // "续命"成新鲜(真实尾部 0~6h);formationTs 只随合格钱包的跨线动作移动,是
  // follow 新鲜度/进场护栏的正确锚点。
  formationTs: number;
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
    sellShares: number;
    buyCount: number;
    // last upward crossing:成本敞口(exposureUsd,P0.6 净股数口径)最后一次从
    // <floor 升到 ≥floor 的成交 ts。null = 从未跨线(或 floor≤0 的退化配置,
    // 见 qualifiedTs 的兜底)。
    crossTs: number | null;
    firstOwnTs: number; // 该钱包在本组的最早成交 ts(退化配置下的兜底锚点)
  };
  const groups = new Map<
    string,
    {
      conditionId: string;
      outcome: string;
      title: string;
      slug: string;
      eventSlug: string;
      asset: string;
      outcomeIndex: number;
      firstTs: number;
      lastTs: number;
      byWallet: Map<string, Acc>;
    }
  >();
  // 白名单过滤 + 去重后自排序(升序):crossing 检测必须按时间正序累计净买,而
  // getTradesWindowDeep 给的是 newest-first,route.ts 等其它调用方又没有顺序契约
  // —— 不能对入参加隐式有序假设,这里自己排。同秒多笔的相对顺序不稳定属已知
  // 限制(上游 timestamp 只有秒级精度),对跨线判定的影响以秒为界。
  const rows: Trade[] = [];
  for (const t of trades) {
    const wallet = t.proxyWallet.toLowerCase();
    // MM disenfranchisement (P0.5): market-maker flow is inventory
    // rebalancing, not a directional opinion — an MM-tagged pool member never
    // votes in consensus (72 of 291 global-board members are MMs; at
    // minWallets=2 two of them could otherwise form a fake consensus).
    const smartTag = smartTags.get(wallet);
    if (!smartTag || smartTag.isMarketMaker) continue;
    const dk = dedupKey(t);
    if (seen.has(dk)) continue;
    seen.add(dk);
    rows.push(t);
  }
  rows.sort((a, b) => a.timestamp - b.timestamp);
  for (const t of rows) {
    const wallet = t.proxyWallet.toLowerCase();
    const key = `${t.conditionId}:${t.outcome}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        conditionId: t.conditionId,
        outcome: t.outcome,
        title: t.title,
        slug: t.slug,
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
      acc = {
        buyUsd: 0,
        sellUsd: 0,
        buyShares: 0,
        sellShares: 0,
        buyCount: 0,
        crossTs: null,
        firstOwnTs: t.timestamp, // rows 已升序,首见即最早
      };
      g.byWallet.set(wallet, acc);
    }
    const tradeUsd = notionalUsd(t);
    // 跨线与资格同用成本敞口口径(P0.6):等股买卖不同价的"USD 假净买"既不能
    // 让钱包合格,也不能制造形成时刻。买入推高敞口,卖出按股数消减 —— 二者
    // 同口径才保住"合格 ⇒ 至少跨线一次 ⇒ crossTs 非空"的不变量。
    const prevNet = exposureUsd(acc);
    if (t.side === "BUY") {
      acc.buyUsd += tradeUsd;
      acc.buyShares += t.size;
      acc.buyCount += 1;
    } else {
      acc.sellUsd += tradeUsd;
      acc.sellShares += t.size;
    }
    const newNet = exposureUsd(acc);
    // upward crossing:每次从线下升到线上都覆盖记录 → 最终保留 last crossing。
    if (prevNet < opts.minPerWalletUsd && newNet >= opts.minPerWalletUsd) {
      acc.crossTs = t.timestamp;
    }
  }

  // Fake-opposition guard, consistent with detectDisagreement: a wallet
  // NET-BUYING >= 2 outcomes of the SAME market is a hedger/market-maker, not a
  // directional opinion. Without dropping it, a hedger inflates BOTH one-sided
  // groups, so a market with hedgers on both sides reads as two separate
  // "consensuses" that detectDisagreement (which DOES exclude hedgers, then
  // needs >=2 surviving sides) never flags as contested — leaking a fake
  // Under+Over double-consensus onto the page (verified live: an O/U 2.5 market
  // whose Under side was ENTIRELY the two wallets that also bought Over).
  // Excluding hedgers from each outcome collapses that to the one genuine side.
  const hedgersByMarket = new Map<string, Set<string>>();
  {
    const perMarket = new Map<string, Map<string, number>>(); // cid -> wallet -> #net-bought outcomes
    for (const g of groups.values()) {
      let perWallet = perMarket.get(g.conditionId);
      if (!perWallet) {
        perWallet = new Map();
        perMarket.set(g.conditionId, perWallet);
      }
      for (const [wallet, acc] of g.byWallet) {
        // 净股数口径(P0.6):在某结果上等股买卖清零的钱包不算"净买了该结果",
        // 只在真实留仓的结果上计数 —— 一边清仓一边留仓是方向性,不是对冲。
        if (netShares(acc) > 0) {
          perWallet.set(wallet, (perWallet.get(wallet) ?? 0) + 1);
        }
      }
    }
    for (const [cid, perWallet] of perMarket) {
      const hedgers = new Set<string>();
      for (const [wallet, n] of perWallet) if (n >= 2) hedgers.add(wallet);
      if (hedgers.size > 0) hedgersByMarket.set(cid, hedgers);
    }
  }

  const out: ConsensusGroup[] = [];
  for (const g of groups.values()) {
    const hedgers = hedgersByMarket.get(g.conditionId);
    const qualified: ConsensusWallet[] = [];
    for (const [wallet, acc] of g.byWallet) {
      if (hedgers?.has(wallet)) continue; // plays both sides — not a directional vote
      // 成本敞口口径(P0.6):netUsd 字段承载"留存净股数 × 买入均价",不再是
      // buyUsd − sellUsd 现金流 —— 等股买卖不同价的钱包敞口为 0,永不合格。
      const netUsd = exposureUsd(acc);
      if (netUsd < opts.minPerWalletUsd) continue;
      const tag = smartTags.get(wallet);
      qualified.push({
        wallet,
        netUsd,
        buyCount: acc.buyCount,
        avgBuyPrice: avgBuyPrice(acc),
        score: tag?.score ?? null,
        winRate: tag?.winRate ?? null,
        // 窗口末尾敞口 ≥ floor(>0)⇒ 至少跨线一次,crossTs 必非 null;
        // firstOwnTs 兜底只保护 floor≤0 的退化配置(敞口 0 也"合格",从未跨线)。
        qualifiedTs: acc.crossTs ?? acc.firstOwnTs,
      });
    }
    if (qualified.length < opts.minWallets) continue;
    // formationTs 先于 netUsd 排序计算:取 qualifiedTs 升序第 minWallets 个
    //(minWallets≤0 的退化配置钳到第 1 个)。
    const crossings = qualified.map((w) => w.qualifiedTs).sort((a, b) => a - b);
    const formationTs =
      crossings[Math.max(1, Math.min(opts.minWallets, crossings.length)) - 1];
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
      slug: g.slug,
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
      formationTs,
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
  // Latest visible trade price for the group's token (from the SAME window the
  // cycle already fetched — zero extra requests). Renders the chase-cost line
  // "现价 X¢ · 较共识均价 ±Y¢"; absent when the window holds no trade for the
  // token, and the line stays silent rather than showing a stale number.
  latestPrice?: number;
  // Deployed dashboard base URL → the push's 🎯 signal-card deep link.
  publicUrl?: string;
  // The consensus signal type's 📐 track-record line (engine-composed, needs
  // db) — passed IN so the sectioned layout can place it before the links
  // block instead of dangling after them.
  recordLine?: string;
}

export function formatConsensusAlert(
  g: ConsensusGroup,
  meta: ConsensusAlertMeta = {},
): string {
  const nowSec = meta.nowSec ?? Math.floor(Date.now() / 1000);
  const blocks: string[] = [];

  // Block 1 — headline carries the OUTCOME (the lock-screen preview alone
  // answers "who's buying what") + title.
  blocks.push(
    `🔥 <b>聪明钱共识</b> · ${g.walletCount} 个白名单钱包买入 <b>${esc(g.outcome)}</b>\n` +
      `<b>${esc(g.title)}</b>`,
  );

  // Block 2 — the numbers: total, timing, chase cost.
  const numbers: string[] = [
    `合计净买入 <b>${usd(g.totalNetUsd)}</b> · 均价 ${cents(g.avgBuyPrice)}`,
    // "15 分钟内集中买入" vs "6 小时里分散各买一笔" are very different signals
    // — and under the rolling window an OLD formation would otherwise push
    // with the same face as a fresh one.
    `⏱ 集中于 ${durText(g.lastTs - g.firstTs)}内 · 最近一笔 ${durText(nowSec - g.lastTs)}前`,
  ];
  if (meta.latestPrice != null && g.avgBuyPrice > 0) {
    // Chase cost, stated neutrally (read-only tool — a fact, not a call):
    // positive = the market already moved past the smart money's entry.
    const d = meta.latestPrice - g.avgBuyPrice;
    numbers.push(
      `现价 ${cents(meta.latestPrice)} · 较共识均价 ${d < 0 ? "-" : "+"}${cents(Math.abs(d))}`,
    );
  }
  blocks.push(numbers.join("\n"));

  // Block 3 — the wallets (dossier deep links when deployed, polymarket
  // profile as fallback).
  const walletLines: string[] = [];
  for (const w of g.wallets.slice(0, 3)) {
    const bits: string[] = [];
    if (w.score != null) bits.push(`评分${Math.round(w.score)}`);
    if (w.winRate != null) bits.push(`胜率${Math.round(w.winRate * 100)}%`);
    const cred = bits.length > 0 ? ` (${bits.join("·")})` : "";
    const href = meta.publicUrl
      ? `${meta.publicUrl}/wallet/${urlSeg(w.wallet)}`
      : `https://polymarket.com/profile/${urlSeg(w.wallet)}`;
    walletLines.push(
      `🏆 <a href="${href}">${short(w.wallet)}</a>` +
        ` 净买 ${usd(w.netUsd)} @${cents(w.avgBuyPrice)}${cred}`,
    );
  }
  if (g.walletCount > 3) {
    walletLines.push(`… 及另外 ${g.walletCount - 3} 个钱包`);
  }
  if (walletLines.length > 0) blocks.push(walletLines.join("\n"));

  // Block 4 — the signal type's own verifiable record (engine-composed).
  if (meta.recordLine) blocks.push(meta.recordLine);

  // Block 5 — links + honesty notes.
  const tail: string[] = [];
  const links: string[] = [];
  if (meta.publicUrl) {
    links.push(
      `<a href="${meta.publicUrl}/market/${urlSeg(g.conditionId)}">🎯 信号卡</a>`,
    );
  }
  links.push(
    `<a href="https://polymarket.com/event/${urlSeg(g.eventSlug)}">市场</a>`,
  );
  tail.push(`🔗 ${links.join(" · ")}`);
  if (meta.coverage) {
    const wh = meta.coverage.windowSec / 3600;
    tail.push(
      `⚠️ 窗口仅覆盖 ~${(meta.coverage.coveredSec / 3600).toFixed(1)}h/` +
        `${Number.isInteger(wh) ? wh : wh.toFixed(1)}h，共识金额为下界`,
    );
  }
  blocks.push(tail.join("\n"));

  return blocks.join("\n\n");
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
  /**
   * 存活组所在市场的元数据,喂给已结算闸门(见 runConsensusCycle 里的
   * 「已结算闸门」段)。
   *
   * **必填,不是可选** —— 与本文件其它 deps(send/opts)的可选纪律刻意不同:
   * send 缺省只是"不推送"(安全降级),这个依赖缺省却是"正确性闸门整个关掉"
   * (不安全降级)。做成必填,漏接就是编译错误而不是线上静默失真 —— 这类
   * 静默失效本仓吃过亏(见 CHANGELOG「落库链路两处静默失效」)。
   *
   * 调用方应传一个**短 TTL** 的 getMarketMeta:默认 1h 缓存能把一个 50 分钟前
   * 就结算了的市场继续报成 open(整整 10 轮虚构)。参照 /api/consensus 对
   * currentPrice 的同一处理(ttlSec=60);closed 市场在 getMarketMeta 内部
   * 是永久缓存,短 TTL 不会带来重复拉取。
   */
  getMeta: (conditionIds: string[]) => Promise<Record<string, MarketMeta>>;
  send?: (html: string) => Promise<void>;
  opts?: ConsensusOptions;
  // A state row older than this is expired: the group left the rolling window
  // and a re-formation counts as NEWS again (also acts as a periodic reminder
  // for a persistently-held consensus).
  stateTtlSec?: number;
  // Requested window length (sec) — denominator of the coverage log.
  windowSec?: number;
  nowSec?: number;
  // Deployed dashboard base URL, forwarded into the push's 🎯 card link.
  publicUrl?: string;
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
 *
 * 组在推送前要过两道互不相干的闸门,顺序固定:
 *   1. 分歧互斥(P0.7):对立结果都有聪明钱 → 单边"共识"是假象,整体沉默。
 *   2. 已结算闸门:市场已终局结算 → 敞口口径失效(赎回不进 /trades),不推。
 * 两道都是"跳过而不预占状态":不落 alerts、不写 consensus_state,所以条件
 * 变化后同一次形成还能作为"新闻"推出去。
 */
export async function runConsensusCycle(
  deps: ConsensusCycleDeps,
): Promise<number> {
  const {
    db,
    fetchWindow,
    getSmart,
    getMeta,
    send,
    opts = DEFAULT_CONSENSUS,
    stateTtlSec = 6 * 3600,
    windowSec = 6 * 3600,
    nowSec = Math.floor(Date.now() / 1000),
    publicUrl,
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
  // Cycle metric (P0.9): decision metadata for every cycle that fetched a
  // window — every exit path below records through `finish`, so "no groups"
  // days are data, not gaps. Window volume is deduped (offset pagination
  // re-serves boundary rows; summing raw rows would inflate the heat proxy).
  const windowUsd = (() => {
    const seenKeys = new Set<string>();
    let sum = 0;
    for (const t of trades) {
      const dk = dedupKey(t);
      if (seenKeys.has(dk)) continue;
      seenKeys.add(dk);
      sum += notionalUsd(t);
    }
    return sum;
  })();
  const finish = (
    rawCount: number,
    contestedDropped: number,
    fired: number,
  ): number => {
    recordConsensusCycle(db, {
      ts: nowSec,
      windowTrades: trades.length,
      windowUsd,
      rawGroups: rawCount,
      contestedDropped,
      fired,
    });
    return fired;
  };

  const rawGroups = detectConsensus(trades, smartTags, opts);
  if (rawGroups.length === 0) return finish(0, 0, 0);
  // Disagreement mutex (P0.7): detectConsensus keys by (conditionId, outcome),
  // so a market with smart money on BOTH opposing outcomes yields two
  // one-sided "consensus" groups — and this push path used to alert on each,
  // contradicting the page API and the follow engine which already exclude
  // contested markets. Same classification everywhere: page, db, Telegram.
  // Skipping (not claiming) is deliberate — when the disagreement later
  // resolves and the group re-forms one-sided, it must still fire as news.
  const contestedMkts = detectDisagreement(
    trades,
    smartTags,
    DEFAULT_DISAGREEMENT,
  );
  const groups = excludeContestedFromConsensus(rawGroups, contestedMkts);
  if (groups.length < rawGroups.length) {
    console.log(
      `[consensus] disagreement mutex: dropped ${rawGroups.length - groups.length} contested group(s) from the push path`,
    );
  }
  if (groups.length === 0)
    return finish(rawGroups.length, rawGroups.length - groups.length, 0);
  // --- 已结算闸门 ---------------------------------------------------------
  // 本模块的资格判据是 exposureUsd(留存净股数 × 买入均价),而它的**唯一**
  // 输入是 BUY/SELL 流水。赎回在 Polymarket 是另一种活动类型(data-api
  // /activity 的 REDEEM),**永远不会**出现在 /trades 里 —— 所以市场一旦结算,
  // netShares 就永久冻结在结算前的水位,敞口从那一刻起是纯虚构。
  //
  // 实测(2026-08-21,7131 条生产告警 × gamma closedTime):
  //   · 73.6% 的市场在 6h 检测窗口**内**结算(体育/电竞开盘到结算常常几小时);
  //   · 结算后中位 1.8 分钟就 REDEEM 完毕 —— 比 5 分钟的巡检节奏还快;
  //   · 输的那一边根本不赎(份额归零),敞口反而**永久**挂在成本价上。
  // 没有这道闸门,一个已结算市场会在 TTL 到期时作为"提醒"再推一次,内容是
  // 一笔谁都不再持有的仓位。
  //
  // 三条纪律:
  //   1. 判据复用 lib/gamma 的 `isSettled`,不在这里重新推导 —— 全站对"已结算"
  //      只能有一个定义。注意它比 follow.ts 开仓处的 `closed === true` **宽**
  //      (争议中的 closed 市场不算结算):争议期赎回被卡住,仓位可能还真在,
  //      不能替人宣布归零。两处问的不是同一个问题,不要"统一"。
  //   2. meta 缺失(冷缓存 + gamma 抖动)= 未知,既不算已结算也不放行,而是
  //      **延到下轮**(与 alertEngine 对 maxHoursToEnd 的 defer 同一套纪律)。
  //      这里 defer 是免费的:没走到下面的 claim,就没写 alerts / consensus_state,
  //      下一轮这次形成照样算"新闻"。
  //   3. 丢弃发生在 claim **之前** —— 落一行 alerts 会污染 typeSignalRecord
  //      算的「共识」30 天战绩,而那个数字就印在推送里。
  const live: ConsensusGroup[] = [];
  {
    const cids = [...new Set(groups.map((g) => g.conditionId))];
    let meta: Record<string, MarketMeta> = {};
    try {
      // 只为**存活组**的市场取 meta(通常个位数),不是整个窗口的几百个市场。
      meta = await getMeta(cids);
    } catch (e) {
      // 真实注入的 getMarketMeta 内部已降级为 cached-only,还能抛说明是注入的
      // 实现出了问题 —— 退化成"全部延到下轮",绝不放行未经检验的组。
      console.warn(
        `[consensus] getMeta failed for ${cids.length} market(s) — 本轮全部延到下轮再判:`,
        e,
      );
    }
    const deferred: string[] = [];
    const settled: string[] = [];
    for (const g of groups) {
      const m = meta[g.conditionId];
      if (!m) {
        deferred.push(`${g.conditionId}/${g.outcome}`);
        continue;
      }
      if (isSettled(m)) {
        settled.push(`${g.conditionId}/${g.outcome}（${g.title}）`);
        continue;
      }
      live.push(g);
    }
    if (settled.length > 0) {
      console.log(
        `[consensus] 已结算闸门: dropped ${settled.length} settled group(s) from the push path — ${settled.join(", ")}`,
      );
    }
    if (deferred.length > 0) {
      // WARN 而非 log:持续出现说明 gamma 侧这些市场取不到 meta,那这些组会
      // **一直**静默 —— 这是可诊断性的最后一道防线,不能只留一行 info。
      console.warn(
        `[consensus] 已结算闸门: market meta missing for ${deferred.length} group(s) — 延到下轮再判(未落 alerts/consensus_state): ${deferred.join(", ")}`,
      );
    }
  }
  if (live.length === 0)
    return finish(rawGroups.length, rawGroups.length - groups.length, 0);
  // Per qualified wallet: the smallest single visible BUY fill (lower bound —
  // fills under the fetch floor are invisible). Minima hugging the floor mean
  // the wallet's real chunks are likely smaller and the floor is masking them
  // ($2k fetch floor vs $5k/wallet qualification mismatch).
  {
    const qualified = new Set<string>();
    for (const g of live) for (const w of g.wallets) qualified.add(w.wallet);
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
      `[consensus] ${live.length} group(s) · qualified-wallet min single fill USD: [${dist.join(", ")}]`,
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
  // One pass over the window for every group's chase-cost line.
  const latestPrices = latestPriceByAsset(trades);
  for (const g of live) {
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
    // params (P0.3): freeze the qualification thresholds that produced this
    // consensus — scorecards bucket by rule version off this snapshot.
    const payloadJson = JSON.stringify({
      ...g,
      params: {
        minWallets: opts.minWallets,
        minPerWalletUsd: opts.minPerWalletUsd,
        windowSec,
      },
    });
    const claimed =
      insAlert.run("consensus", dk, payloadJson, nowSec).changes === 1;
    if (!claimed) {
      const prior = selAlert.get(dk) as { created_at: number } | undefined;
      if (prior && nowSec - prior.created_at <= stateTtlSec) {
        console.log(`[consensus] skip ${dk}: claimed by another process`);
        continue;
      }
    }
    if (send) {
      try {
        // P0.14: the push carries the consensus signal type's own verifiable
        // 30d record — composed here (needs db), placed by the formatter in
        // its own section before the links.
        const html = formatConsensusAlert(g, {
          nowSec,
          coverage,
          // Chase-cost line: latest visible price for the group's token from
          // the window this cycle already fetched (zero extra requests).
          latestPrice: latestPrices.get(g.asset),
          publicUrl,
          recordLine:
            formatRecordLine(
              "共识",
              typeSignalRecord(db, "consensus", { nowSec }),
            ) ?? undefined,
        });
        await send(html);
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
  return finish(rawGroups.length, rawGroups.length - groups.length, fired);
}
