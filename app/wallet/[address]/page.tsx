"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  AgeBadge,
  CopyButton,
  QuietLink,
  SideTag,
  StatCard,
  Tag,
  catLabel,
  fmtSignedUsdCompact,
  type SmartInfoLite,
  type WalletStatsLite,
} from "../../ui";

// External trade page for a market slug (wired.fund) — same as the 24h scanner.
const TRADE_LINK_BASE =
  "https://onchain-dev.wired.fund/polymarket/trade-slug?slug=";

type PriceBand = { from: number; to: number; buyUsd: number; buyCount: number };
type MarketFocus = {
  conditionId: string;
  title: string;
  eventSlug: string;
  buyUsd: number;
  sellUsd: number;
  netUsd: number;
  trades: number;
  lastTs: number;
  category: string | null;
};
type Profile = {
  tradeCount: number;
  buyUsd: number;
  sellUsd: number;
  avgTradeUsd: number;
  smallBuyShare: number | null;
  priceBands: PriceBand[];
  topMarkets: MarketFocus[];
  firstTs: number | null;
  lastTs: number | null;
};
type AlertHit = {
  type: string;
  createdAt: number;
  title: string;
  outcome: string;
  side: string;
  usd: number;
  price: number | null;
  // "" when the recorded payload carried no event slug (very old rows).
  eventSlug: string;
};
type RecentTrade = {
  timestamp: number;
  side: "BUY" | "SELL";
  usdcSize: number;
  price: number;
  title: string;
  outcome: string;
  eventSlug: string;
};
type Holding = {
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  endDate: string | null;
};
type HoldingsSummary = {
  holdings: Holding[];
  totalValue: number;
  totalCashPnl: number;
  count: number;
  truncated: boolean;
};
type WalletResponse = {
  address: string;
  firstTs: number | null;
  ageDays: number | null;
  stats: WalletStatsLite | null;
  smart: SmartInfoLite | null;
  // Live PUSD (Polymarket cash) balance in USD; null = RPC unavailable.
  pusdBalance: number | null;
  profile: Profile;
  // Current live (unresolved) positions — the wallet's active book.
  holdings: HoldingsSummary;
  categories: { category: string; usd: number; share: number }[];
  alertHits: AlertHit[];
  // Coverage window of alertHits in days (the API bounds the LIKE scan).
  alertHitsWindowDays?: number;
  recent: RecentTrade[];
  error?: string;
};

function fmtUsd(usd: number): string {
  return usd.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtDateTime(sec: number): string {
  return new Date(sec * 1000).toLocaleString("zh-CN", { hour12: false });
}

const ALERT_TYPE_LABEL: Record<string, string> = {
  large: "💰 大单",
  smart: "🏆 聪明钱",
  consensus: "🔥 共识",
};

export default function WalletPage() {
  const params = useParams<{ address: string }>();
  const address = (params?.address ?? "").toLowerCase();
  const [data, setData] = useState<WalletResponse | null>(null);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!address) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/wallet/${address}`, {
          cache: "no-store",
        });
        const json = (await res.json()) as WalletResponse;
        if (!active) return;
        if (json.error) setError(json.error);
        else setData(json);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      active = false;
    };
  }, [address]);

  const p = data?.profile;
  const maxBandUsd = p ? Math.max(1, ...p.priceBands.map((b) => b.buyUsd)) : 1;

  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-5)" }}>
        <h1
          style={{
            fontSize: "var(--t-2xl)",
            marginBottom: "var(--s-1)",
            display: "flex",
            alignItems: "center",
            gap: "var(--s-2)",
            flexWrap: "wrap",
          }}
        >
          <span aria-hidden>🕵️</span>
          <span className="mono" style={{ fontSize: "var(--t-xl)" }}>
            {address ? `${address.slice(0, 10)}…${address.slice(-6)}` : ""}
          </span>
          {data ? <AgeBadge ageDays={data.ageDays} /> : null}
          {data?.smart ? (
            <Tag variant="brand">
              🏆 聪明钱
              {data.smart.score != null
                ? ` · 评分 ${Math.round(data.smart.score)}`
                : ""}
              {data.smart.isWhitelist ? " · 手动白名单" : ""}
            </Tag>
          ) : null}
          {data?.stats?.isMarketMaker ? (
            <Tag variant="warn">
              🤖 高频做市 / 机器人
              {data.stats.marketsTraded != null
                ? ` · ${data.stats.marketsTraded.toLocaleString()} 市场`
                : ""}
            </Tag>
          ) : null}
        </h1>
        <div className="ds-hint">
          <a
            href={`https://polymarket.com/profile/${address}`}
            target="_blank"
            rel="noreferrer"
          >
            Polymarket 主页 ↗
          </a>
          {" · "}
          <a
            href={`https://polygonscan.com/address/${address}`}
            target="_blank"
            rel="noreferrer"
          >
            Polygonscan ↗
          </a>
          {p?.firstTs && p?.lastTs ? (
            <span className="muted">
              {" "}
              · 分析窗口：近 {p.tradeCount} 笔成交（
              {fmtDateTime(p.firstTs)} → {fmtDateTime(p.lastTs)}）
            </span>
          ) : null}
        </div>
      </header>

      {error ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-4)" }}
        >
          加载失败: {error}
        </div>
      ) : null}

      {!data && !error ? <div className="ds-empty">档案加载中…</div> : null}

      {data && p ? (
        <>
          {/* KPI: settled record + window flow */}
          <section className="kpi" style={{ marginBottom: "var(--s-5)" }}>
            <StatCard label="已结算胜率">
              <div
                className="kpi-value"
                title={
                  data.stats?.isMarketMaker
                    ? "高频做市/机器人(交易过大量不同市场):做市赚点差、非定向下注,胜率不适用"
                    : data.stats?.truncated
                      ? "已结算市场过多,只能取到按盈亏排序的最赚一部分(赢家偏差),胜率无法可靠统计"
                      : undefined
                }
              >
                {data.stats?.isMarketMaker
                  ? "🤖"
                  : data.stats?.winRate != null
                    ? `${Math.round(data.stats.winRate * 100)}%`
                    : "—"}
              </div>
              <div className="kpi-sub">
                {!data.stats
                  ? "无数据"
                  : data.stats.isMarketMaker
                    ? `高频做市/机器人 · ${data.stats.marketsTraded?.toLocaleString() ?? "海量"} 市场 · 胜率不适用`
                    : data.stats.truncated
                      ? `${data.stats.settledCount}+ 个已结算市场 · 过多,胜率不可靠`
                      : `${data.stats.settledCount} 个已结算市场`}
              </div>
            </StatCard>
            <StatCard label="净盈亏">
              <div
                className={`kpi-value ${
                  data.stats?.netPnl != null && data.stats.netPnl < 0
                    ? "down"
                    : "up"
                }`}
                title="Polymarket 口径净盈亏（已实现 + 当前持仓浮动盈亏），取自官方 user-pnl 曲线，与主页 Profit/loss 一致"
              >
                {data.stats?.netPnl != null
                  ? fmtSignedUsdCompact(data.stats.netPnl)
                  : "—"}
              </div>
              <div className="kpi-sub">
                已结算 ROI{" "}
                {data.stats?.roi != null
                  ? `${(data.stats.roi * 100).toFixed(1)}%`
                  : "—"}
              </div>
            </StatCard>
            <StatCard label="PUSD 现金余额">
              <div className="kpi-value">
                {data.pusdBalance != null
                  ? `$${fmtUsd(data.pusdBalance)}`
                  : "—"}
              </div>
              <div
                className="kpi-sub"
                title="Polymarket 账户内未下注的现金（链上 PUSD 余额，实时查询）"
              >
                {data.pusdBalance != null ? "账户内可用资金" : "RPC 暂不可用"}
              </div>
            </StatCard>
            <StatCard label="近窗买入 / 卖出">
              <div className="kpi-value" style={{ fontSize: 18 }}>
                <span className="up">${fmtUsd(p.buyUsd)}</span>
                <span className="muted"> / </span>
                <span className="down">${fmtUsd(p.sellUsd)}</span>
              </div>
              <div className="kpi-sub">平均每笔 ${fmtUsd(p.avgTradeUsd)}</div>
            </StatCard>
            <StatCard label="拆单倾向">
              <div className="kpi-value">
                {p.smallBuyShare != null
                  ? `${Math.round(p.smallBuyShare * 100)}%`
                  : "—"}
              </div>
              <div className="kpi-sub">买单中 &lt;$1k 的占比</div>
            </StatCard>
          </section>

          {/* Current holdings (live positions) */}
          {data.holdings && data.holdings.count > 0 ? (
            <section style={{ marginBottom: "var(--s-5)" }}>
              <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
                当前持仓（{data.holdings.count} 个活仓 · 总市值 $
                {fmtUsd(data.holdings.totalValue)} · 浮动盈亏{" "}
                <span
                  className={data.holdings.totalCashPnl >= 0 ? "up" : "down"}
                >
                  {fmtSignedUsdCompact(data.holdings.totalCashPnl)}
                </span>
                {data.holdings.truncated ? " · 仅前若干页" : ""}）
              </div>
              <div className="ds-table-wrap">
                <table className="ds-table">
                  <thead>
                    <tr>
                      <th>市场 / 结果</th>
                      <th className="is-right">份额</th>
                      <th className="is-right" title="按金额加权的建仓均价">
                        建仓均价
                      </th>
                      <th className="is-right">现价</th>
                      <th className="is-right">市值</th>
                      <th className="is-right">浮动盈亏</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.holdings.holdings.map((h, i) => (
                      <tr key={`${h.eventSlug}-${h.outcome}-${i}`}>
                        <td style={{ whiteSpace: "normal", maxWidth: 340 }}>
                          {h.eventSlug ? (
                            <a
                              href={`https://polymarket.com/event/${h.eventSlug}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {h.title}
                            </a>
                          ) : (
                            h.title
                          )}
                          {/* Copy/jump on the subtitle row (same as the 24h
                              scanner): ⧉ copies the MARKET slug, ↗ opens the
                              wired.fund trade page. */}
                          <div
                            className="kpi-sub"
                            style={{ whiteSpace: "nowrap" }}
                          >
                            {h.outcome}
                            <CopyButton
                              text={h.slug || h.eventSlug}
                              label="复制 market slug"
                            />
                            {h.slug || h.eventSlug ? (
                              <QuietLink
                                href={`${TRADE_LINK_BASE}${encodeURIComponent(
                                  h.slug || h.eventSlug,
                                )}`}
                                title={`在 wired.fund 打开交易页：${
                                  h.slug || h.eventSlug
                                }`}
                              >
                                ↗
                              </QuietLink>
                            ) : null}
                          </div>
                        </td>
                        <td className="mono is-right" data-label="份额">
                          {fmtUsd(h.size)}
                        </td>
                        <td
                          className="mono is-right"
                          data-label="建仓均价"
                          style={{ color: "var(--warn-700)" }}
                        >
                          {h.avgPrice.toFixed(3)}
                        </td>
                        <td className="mono is-right" data-label="现价">
                          {h.curPrice.toFixed(3)}
                        </td>
                        <td className="mono is-right" data-label="市值">
                          ${fmtUsd(h.currentValue)}
                        </td>
                        <td
                          className={`mono is-right ${
                            h.cashPnl >= 0 ? "up" : "down"
                          }`}
                          data-label="浮动盈亏"
                        >
                          {fmtSignedUsdCompact(h.cashPnl)} (
                          {h.percentPnl >= 0 ? "+" : ""}
                          {h.percentPnl.toFixed(1)}%)
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : data.holdings ? (
            <section style={{ marginBottom: "var(--s-5)" }}>
              <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
                当前持仓
              </div>
              <div className="ds-empty">
                该钱包当前没有活跃持仓（或未查询到）
              </div>
            </section>
          ) : null}

          {/* Category focus */}
          {data.categories.length > 0 ? (
            <section style={{ marginBottom: "var(--s-5)" }}>
              <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
                专攻类别（按头部市场成交额）
              </div>
              <div
                style={{
                  display: "flex",
                  gap: "var(--s-2)",
                  flexWrap: "wrap",
                }}
              >
                {data.categories.map((c) => (
                  <Tag key={c.category} variant="default">
                    {catLabel(c.category)} {Math.round(c.share * 100)}%
                  </Tag>
                ))}
              </div>
            </section>
          ) : null}

          {/* Price-band histogram */}
          <section
            className="ds-card"
            style={{ padding: "var(--s-4)", marginBottom: "var(--s-5)" }}
          >
            <div className="ds-label" style={{ marginBottom: "var(--s-3)" }}>
              买入赔率带分布（近 {p.tradeCount} 笔）
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--s-1)",
              }}
            >
              {p.priceBands.map((b) => (
                <div
                  key={b.from}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--s-2)",
                  }}
                >
                  <span
                    className="mono muted"
                    style={{
                      width: 86,
                      flexShrink: 0,
                      fontSize: "var(--t-sm)",
                    }}
                  >
                    {b.from.toFixed(1)}–{b.to.toFixed(1)}
                  </span>
                  <div
                    style={{
                      flex: 1,
                      height: 14,
                      background: "var(--n-100)",
                      borderRadius: 3,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${(b.buyUsd / maxBandUsd) * 100}%`,
                        height: "100%",
                        background: "var(--up-500)",
                      }}
                    />
                  </div>
                  <span
                    className="mono muted"
                    style={{ width: 120, flexShrink: 0, textAlign: "right" }}
                  >
                    ${fmtUsd(b.buyUsd)} · {b.buyCount}笔
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* Top markets */}
          <section style={{ marginBottom: "var(--s-5)" }}>
            <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
              头部市场（按成交额）
            </div>
            <div className="ds-table-wrap">
              <table className="ds-table">
                <thead>
                  <tr>
                    <th>市场</th>
                    <th>类别</th>
                    <th className="is-right">买入</th>
                    <th className="is-right">卖出</th>
                    <th className="is-right">净买入</th>
                    <th className="is-right">笔数</th>
                  </tr>
                </thead>
                <tbody>
                  {p.topMarkets.map((m) => (
                    <tr key={m.conditionId}>
                      <td style={{ whiteSpace: "normal", maxWidth: 360 }}>
                        {m.eventSlug ? (
                          <a
                            href={`https://polymarket.com/event/${m.eventSlug}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {m.title}
                          </a>
                        ) : (
                          m.title
                        )}
                      </td>
                      <td className="muted" data-label="类别">
                        {m.category ? catLabel(m.category) : "—"}
                      </td>
                      <td className="mono is-right up" data-label="买入">
                        ${fmtUsd(m.buyUsd)}
                      </td>
                      <td className="mono is-right down" data-label="卖出">
                        ${fmtUsd(m.sellUsd)}
                      </td>
                      <td className="mono is-right" data-label="净买入">
                        ${fmtUsd(m.netUsd)}
                      </td>
                      <td className="mono is-right" data-label="笔数">
                        {m.trades}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* This tool's alert history for the wallet */}
          <section style={{ marginBottom: "var(--s-5)" }}>
            <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
              本工具历史命中（近 {data.alertHitsWindowDays ?? 90} 天 ·{" "}
              {data.alertHits.length}）
            </div>
            {data.alertHits.length === 0 ? (
              <div className="ds-empty">
                近 {data.alertHitsWindowDays ?? 90} 天内该钱包未触发过告警
              </div>
            ) : (
              <div className="ds-table-wrap">
                <table className="ds-table">
                  <thead>
                    <tr>
                      <th>类型</th>
                      <th>市场 / 结果</th>
                      <th>方向</th>
                      <th className="is-right">金额</th>
                      <th className="is-right">价格</th>
                      <th>时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.alertHits.map((h, i) => (
                      <tr key={`${h.createdAt}-${i}`}>
                        <td data-label="类型">
                          {ALERT_TYPE_LABEL[h.type] ?? h.type}
                        </td>
                        <td style={{ whiteSpace: "normal", maxWidth: 320 }}>
                          {h.eventSlug ? (
                            <a
                              href={`https://polymarket.com/event/${h.eventSlug}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {h.title}
                            </a>
                          ) : (
                            h.title
                          )}
                          <div className="kpi-sub">{h.outcome}</div>
                        </td>
                        <td data-label="方向">
                          <SideTag side={h.side} />
                        </td>
                        <td className="mono is-right" data-label="金额">
                          ${fmtUsd(h.usd)}
                        </td>
                        <td className="mono is-right" data-label="价格">
                          {h.price != null ? h.price.toFixed(3) : "—"}
                        </td>
                        <td className="mono muted" data-label="时间">
                          {fmtDateTime(h.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Recent trades */}
          <section>
            <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
              最近成交（20）
            </div>
            <div className="ds-table-wrap">
              <table className="ds-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>市场 / 结果</th>
                    <th>方向</th>
                    <th className="is-right">金额</th>
                    <th className="is-right">价格</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((t, i) => (
                    <tr key={`${t.timestamp}-${i}`}>
                      <td className="mono muted" data-label="时间">
                        {fmtDateTime(t.timestamp)}
                      </td>
                      <td style={{ whiteSpace: "normal", maxWidth: 360 }}>
                        {t.eventSlug ? (
                          <a
                            href={`https://polymarket.com/event/${t.eventSlug}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t.title}
                          </a>
                        ) : (
                          t.title
                        )}
                        <div className="kpi-sub">{t.outcome}</div>
                      </td>
                      <td data-label="方向">
                        <SideTag side={t.side} />
                      </td>
                      <td className="mono is-right" data-label="金额">
                        ${fmtUsd(t.usdcSize)}
                      </td>
                      <td className="mono is-right" data-label="价格">
                        {t.price.toFixed(3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}
