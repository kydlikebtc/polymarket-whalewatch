"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  AgeBadge,
  SideTag,
  StatCard,
  Tag,
  catLabel,
  fmtSignedUsdCompact,
  type SmartInfoLite,
  type WalletStatsLite,
} from "../../ui";

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
type WalletResponse = {
  address: string;
  firstTs: number | null;
  ageDays: number | null;
  stats: WalletStatsLite | null;
  smart: SmartInfoLite | null;
  profile: Profile;
  categories: { category: string; usd: number; share: number }[];
  alertHits: AlertHit[];
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
              <div className="kpi-value">
                {data.stats?.winRate != null
                  ? `${Math.round(data.stats.winRate * 100)}%`
                  : "—"}
              </div>
              <div className="kpi-sub">
                {data.stats
                  ? `${data.stats.settledCount}${data.stats.truncated ? "+" : ""} 个已结算市场`
                  : "无数据"}
              </div>
            </StatCard>
            <StatCard label="已实现盈亏">
              <div
                className={`kpi-value ${
                  (data.stats?.realizedPnl ?? 0) >= 0 ? "up" : "down"
                }`}
              >
                {data.stats ? fmtSignedUsdCompact(data.stats.realizedPnl) : "—"}
              </div>
              <div className="kpi-sub">
                ROI{" "}
                {data.stats?.roi != null
                  ? `${(data.stats.roi * 100).toFixed(1)}%`
                  : "—"}
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
                      <td className="muted">
                        {m.category ? catLabel(m.category) : "—"}
                      </td>
                      <td className="mono is-right up">${fmtUsd(m.buyUsd)}</td>
                      <td className="mono is-right down">
                        ${fmtUsd(m.sellUsd)}
                      </td>
                      <td className="mono is-right">${fmtUsd(m.netUsd)}</td>
                      <td className="mono is-right">{m.trades}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* This tool's alert history for the wallet */}
          <section style={{ marginBottom: "var(--s-5)" }}>
            <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
              本工具历史命中（{data.alertHits.length}）
            </div>
            {data.alertHits.length === 0 ? (
              <div className="ds-empty">该钱包尚未触发过告警</div>
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
                        <td>{ALERT_TYPE_LABEL[h.type] ?? h.type}</td>
                        <td style={{ whiteSpace: "normal", maxWidth: 320 }}>
                          {h.title}
                          <div className="kpi-sub">{h.outcome}</div>
                        </td>
                        <td>
                          <SideTag side={h.side} />
                        </td>
                        <td className="mono is-right">${fmtUsd(h.usd)}</td>
                        <td className="mono is-right">
                          {h.price != null ? h.price.toFixed(3) : "—"}
                        </td>
                        <td className="mono muted">
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
                      <td className="mono muted">{fmtDateTime(t.timestamp)}</td>
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
                      <td>
                        <SideTag side={t.side} />
                      </td>
                      <td className="mono is-right">${fmtUsd(t.usdcSize)}</td>
                      <td className="mono is-right">{t.price.toFixed(3)}</td>
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
