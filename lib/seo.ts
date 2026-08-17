// 程序化 SEO / GEO 的数据层 —— 全部只读本地 SQLite。
//
// 红线(设计文档 §1):本模块与消费它的服务端组件/路由严禁触发上游请求。
// /api/wallet 每次 1-2+ 个上游调用,爬虫一天爬几千页会把 Polymarket API
// 打爆 —— SEO 层的一切数据都来自引擎已经落库的表(wallet_stats/
// smart_wallets/wallet_age/alerts/market_meta/token_map/consensus_state)。
//
// 质量门(设计文档 §D):本地查无数据的钱包/市场 hasData=false,消费方
// 据此 noindex;sitemap 只收有实质内容的页 —— 薄页交给索引只会拉低全站。
import type { DB } from "./db";
import { getWalletTags, type WalletTag } from "./walletTags";

const DAY_SEC = 86400;
const ALERT_WINDOW_SEC = 30 * DAY_SEC;
const SITEMAP_MARKET_WINDOW_SEC = 180 * DAY_SEC;
export const SITEMAP_WALLET_CAP = 10_000;
export const SITEMAP_MARKET_CAP = 5_000;
// wallet_stats 有战绩但不在白名单的钱包,至少要有这么多已结算仓才值得
// 一个独立索引页(与 /follow 小样本警示同一哲学)。
export const SITEMAP_MIN_SETTLED = 5;

/** PUBLIC_URL(生产默认)去尾斜杠 —— 与 lib/config 的 publicUrl 同语义。 */
export function siteBase(): string {
  return (process.env.PUBLIC_URL ?? "https://whalewatch.wired.fund").replace(
    /\/+$/,
    "",
  );
}

export function isValidWalletAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

export function isValidConditionId(s: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(s);
}

// ---------------------------------------------------------------------------
// 钱包摘要
// ---------------------------------------------------------------------------

export interface WalletSeoSummary {
  address: string; // 小写归一(canonical 用它收敛大小写重复收录)
  hasData: boolean;
  winRatePct: number | null;
  realizedPnlUsd: number | null;
  roiPct: number | null;
  settledCount: number | null;
  isWhitelist: boolean;
  score: number | null;
  source: string | null;
  firstSeenTs: number | null;
  alerts30d: number;
  tags: WalletTag[];
}

export function buildWalletSeoSummary(
  db: DB,
  address: string,
  nowSec: number,
): WalletSeoSummary {
  const addr = address.toLowerCase();
  const stats = db
    .prepare(
      "SELECT win_rate, realized_pnl, roi, settled_count FROM wallet_stats WHERE wallet = ?",
    )
    .get(addr) as
    | {
        win_rate: number | null;
        realized_pnl: number | null;
        roi: number | null;
        settled_count: number | null;
      }
    | undefined;
  const smart = db
    .prepare(
      "SELECT score, is_whitelist, source, win_rate, realized_pnl FROM smart_wallets WHERE address = ?",
    )
    .get(addr) as
    | {
        score: number | null;
        is_whitelist: number | null;
        source: string | null;
        win_rate: number | null;
        realized_pnl: number | null;
      }
    | undefined;
  const age = db
    .prepare("SELECT first_ts FROM wallet_age WHERE wallet = ?")
    .get(addr) as { first_ts: number | null } | undefined;
  // 与 alertEngine 冷却探针同款 json_extract 探法:created_at 索引先收窄
  // 到 30 天窗,残余扫描量很小。
  const alerts30d = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM alerts
          WHERE created_at >= ? AND type IN ('large','smart')
            AND lower(json_extract(payload, '$.proxyWallet')) = ?`,
      )
      .get(nowSec - ALERT_WINDOW_SEC, addr) as { n: number }
  ).n;

  const winRate = stats?.win_rate ?? smart?.win_rate ?? null;
  const pnl = stats?.realized_pnl ?? smart?.realized_pnl ?? null;
  return {
    address: addr,
    hasData: !!stats || !!smart || !!age || alerts30d > 0,
    winRatePct: winRate != null ? winRate * 100 : null,
    realizedPnlUsd: pnl,
    roiPct: stats?.roi != null ? stats.roi * 100 : null,
    settledCount: stats?.settled_count ?? null,
    isWhitelist: (smart?.is_whitelist ?? 0) === 1,
    score: smart?.score ?? null,
    source: smart?.source ?? null,
    firstSeenTs: age?.first_ts ?? null,
    alerts30d,
    tags: getWalletTags(db, addr, nowSec),
  };
}

// ---------------------------------------------------------------------------
// 市场摘要
// ---------------------------------------------------------------------------

export interface MarketSeoSummary {
  conditionId: string;
  hasData: boolean;
  title: string | null;
  slug: string | null;
  eventSlug: string | null;
  category: string | null;
  closed: boolean | null;
  endDate: string | null;
  outcomes: string[];
  outcomePrices: number[];
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  alerts30d: number;
  alertUsd30d: number;
  lastAlertTs: number | null;
  consensus: { outcome: string; walletCount: number; totalUsd: number }[];
}

export function buildMarketSeoSummary(
  db: DB,
  conditionId: string,
  nowSec: number,
): MarketSeoSummary {
  const cid = conditionId.toLowerCase();
  const metaRow = db
    .prepare("SELECT meta_json FROM market_meta WHERE condition_id = ?")
    .get(cid) as { meta_json: string } | undefined;
  let meta: Record<string, unknown> | null = null;
  if (metaRow) {
    try {
      meta = JSON.parse(metaRow.meta_json) as Record<string, unknown>;
    } catch {
      meta = null;
    }
  }
  const token = db
    .prepare(
      "SELECT question, slug, event_slug FROM token_map WHERE condition_id = ? AND question IS NOT NULL LIMIT 1",
    )
    .get(cid) as
    | {
        question: string | null;
        slug: string | null;
        event_slug: string | null;
      }
    | undefined;

  // 30 天告警聚合:payload 是 JSON,JS 侧聚合(与 xPregame 同理由)。
  const rows = db
    .prepare(
      `SELECT type, payload, created_at FROM alerts
        WHERE created_at >= ? AND type IN ('large','smart','consensus')
          AND lower(json_extract(payload, '$.conditionId')) = ?`,
    )
    .all(nowSec - ALERT_WINDOW_SEC, cid) as {
    type: string;
    payload: string;
    created_at: number;
  }[];
  let alertUsd = 0;
  let lastAlertTs: number | null = null;
  let fallbackTitle: string | null = null;
  for (const r of rows) {
    lastAlertTs = Math.max(lastAlertTs ?? 0, r.created_at);
    try {
      const p = JSON.parse(r.payload) as Record<string, unknown>;
      if (typeof p.title === "string" && fallbackTitle == null) {
        fallbackTitle = p.title;
      }
      if (r.type === "consensus") {
        if (typeof p.totalNetUsd === "number") alertUsd += p.totalNetUsd;
      } else if (typeof p.size === "number" && typeof p.price === "number") {
        alertUsd += p.size * p.price;
      }
    } catch {
      // 坏 payload 只影响聚合数字,不影响页面存在性。
    }
  }

  const consensus = (
    db
      .prepare(
        "SELECT outcome, wallet_count, total_usd FROM consensus_state WHERE condition_id = ? ORDER BY wallet_count DESC",
      )
      .all(cid) as {
      outcome: string;
      wallet_count: number;
      total_usd: number;
    }[]
  ).map((r) => ({
    outcome: r.outcome,
    walletCount: r.wallet_count,
    totalUsd: r.total_usd,
  }));

  const outcomes = Array.isArray(meta?.outcomes)
    ? (meta.outcomes as unknown[]).filter(
        (o): o is string => typeof o === "string",
      )
    : [];
  const outcomePrices = Array.isArray(meta?.outcomePrices)
    ? (meta.outcomePrices as unknown[]).filter(
        (p): p is number => typeof p === "number",
      )
    : [];
  return {
    conditionId: cid,
    hasData: !!meta || !!token || rows.length > 0 || consensus.length > 0,
    title: token?.question ?? fallbackTitle,
    slug: token?.slug ?? null,
    eventSlug: token?.event_slug ?? null,
    category: typeof meta?.category === "string" ? meta.category : null,
    closed: typeof meta?.closed === "boolean" ? meta.closed : null,
    endDate: typeof meta?.endDate === "string" ? meta.endDate : null,
    outcomes,
    outcomePrices,
    volume24hUsd: typeof meta?.volume24hr === "number" ? meta.volume24hr : null,
    liquidityUsd: typeof meta?.liquidity === "number" ? meta.liquidity : null,
    alerts30d: rows.length,
    alertUsd30d: alertUsd,
    lastAlertTs,
    consensus,
  };
}

// ---------------------------------------------------------------------------
// 站点地图
// ---------------------------------------------------------------------------

export interface SitemapEntry {
  url: string;
  lastModified?: Date;
}

/** smart_wallets 全体 ∪ wallet_stats(settled≥N),小写去重 + 格式校验。 */
export function sitemapWalletEntries(
  db: DB,
  base: string,
  _nowSec: number,
): SitemapEntry[] {
  const byAddr = new Map<string, number | null>();
  const smart = db
    .prepare("SELECT address, updated_at FROM smart_wallets")
    .all() as { address: string; updated_at: number | null }[];
  for (const r of smart) {
    const a = r.address.toLowerCase();
    if (isValidWalletAddress(a)) byAddr.set(a, r.updated_at);
  }
  const stats = db
    .prepare(
      "SELECT wallet, fetched_at FROM wallet_stats WHERE settled_count >= ?",
    )
    .all(SITEMAP_MIN_SETTLED) as {
    wallet: string;
    fetched_at: number | null;
  }[];
  for (const r of stats) {
    const a = r.wallet.toLowerCase();
    if (!isValidWalletAddress(a)) continue;
    if (!byAddr.has(a)) byAddr.set(a, r.fetched_at);
  }
  return [...byAddr.entries()].slice(0, SITEMAP_WALLET_CAP).map(([a, ts]) => ({
    url: `${base}/wallet/${a}`,
    ...(ts ? { lastModified: new Date(ts * 1000) } : {}),
  }));
}

/** 近 180 天出过告警的市场(活跃证明),按最近告警时间降序。 */
export function sitemapMarketEntries(
  db: DB,
  base: string,
  nowSec: number,
): SitemapEntry[] {
  const rows = db
    .prepare(
      `SELECT lower(json_extract(payload, '$.conditionId')) AS cid,
              MAX(created_at) AS last_ts
         FROM alerts
        WHERE created_at >= ? AND type IN ('large','smart','consensus')
        GROUP BY cid
        ORDER BY last_ts DESC
        LIMIT ?`,
    )
    .all(nowSec - SITEMAP_MARKET_WINDOW_SEC, SITEMAP_MARKET_CAP) as {
    cid: string | null;
    last_ts: number;
  }[];
  return rows
    .filter((r): r is { cid: string; last_ts: number } =>
      typeof r.cid === "string" ? isValidConditionId(r.cid) : false,
    )
    .map((r) => ({
      url: `${base}/market/${r.cid}`,
      lastModified: new Date(r.last_ts * 1000),
    }));
}

// ---------------------------------------------------------------------------
// llms.txt(GEO)
// ---------------------------------------------------------------------------

/**
 * llms.txt 规范形态:H1 + 一段引言 blockquote + 分节链接列表。英文
 * (AI 引用场景的主语言),带少量活数示新鲜度。内容刻意稳定 —— 这是给
 * AI 爬虫的站点说明书,不是营销页。
 */
export function llmsTxt(db: DB, base: string): string {
  const wallets = (
    db.prepare("SELECT COUNT(*) AS n FROM smart_wallets").get() as { n: number }
  ).n;
  const alerts = (
    db.prepare("SELECT COUNT(*) AS n FROM alerts").get() as { n: number }
  ).n;
  return `# WhaleWatch — Polymarket Whale & Smart-Money Monitor

> Real-time, read-only monitoring of Polymarket prediction markets: large executed fills, split-buy accumulation, fresh-wallet activity and smart-money consensus — with a public validation loop that backfills 1h/24h price follow-through and the final settlement result for every alert it fired. Currently tracking ${wallets} tracked smart-money wallets and ${alerts} recorded alerts.

## Key pages

- [Dashboard](${base}/): 24h large-trade scanner with odds, wallet-age and track-record badges
- [Strategy Center](${base}/follow): 19 paper-trading strategies with verified equity curves, drawdowns and per-track edge analysis (real data, simulated execution)
- [Consensus](${base}/consensus): markets where ≥2 whitelisted smart-money wallets bought the same outcome, plus disagreement detection
- [Accumulation](${base}/accumulation): split-buy positions built from many small orders
- [Discovery](${base}/discovery): skilled-but-small wallets found by behavior channels, gated by a quality admission funnel
- [Glossary](${base}/glossary): every symbol, tag and metric definition used across the site

## Programmatic pages

- Wallet dossiers at ${base}/wallet/{address}: settled win rate, realized PnL (matches Polymarket's official user-pnl curve), odds-band histogram, category focus, split-buy tendency
- Market pages at ${base}/market/{conditionId}: smart-money flow, whale alerts and consensus state per market

## Methodology

- Signals come only from public Polymarket APIs; no authentication, no trading, no order flow of our own
- Every alert is validated after the fact: 1h/24h price movement plus settlement outcome — hit rates are computed over the FULL alert history, not a curated sample
- Paper-trading strategies enter at market price at signal time and hold to settlement; execution cost is modeled from CLOB order-book snapshots

## Notes

- Research tool only. Not financial advice. No user accounts, no tracking of visitors.
- Data updates continuously (worker polls every few seconds; leaderboard reseeded daily).
`;
}
