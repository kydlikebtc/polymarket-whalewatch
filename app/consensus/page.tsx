"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Field, Icon, Segmented, StatCard, Tag } from "../ui";
import {
  buildQueryString,
  parseChoiceParam,
  parseNumParam,
  replaceUrlQuery,
} from "../urlQuery";

type ConsensusWallet = {
  wallet: string;
  netUsd: number;
  buyCount: number;
  avgBuyPrice: number;
  score: number | null;
};

type ConsensusGroup = {
  conditionId: string;
  outcome: string;
  title: string;
  eventSlug: string;
  wallets: ConsensusWallet[];
  walletCount: number;
  totalNetUsd: number;
  avgBuyPrice: number;
  firstTs: number;
  lastTs: number;
  currentPrice: number | null;
  category: string | null;
  closed: boolean;
};

type ConsensusResponse = {
  filters: { hours: number; minWallets: number; minPerWalletUsd: number };
  smartCount: number;
  truncated: boolean;
  // Start of the COMPLETE window actually covered (API depth is finite).
  effectiveSinceSec: number | null;
  groups: ConsensusGroup[];
  error?: string;
};

type Hours = 2 | 6 | 12;

const PER_WALLET_PRESETS = [5000, 10000, 25000];
const HOURS_CHOICES = [2, 6, 12] as const;
const MIN_WALLETS_CHOICES = [2, 3, 4] as const;
// Page defaults — doubling as the "omit from URL" baseline so the default
// view serializes to a bare pathname.
const DEFAULTS = { hours: 6 as Hours, minWallets: 2, minPerWalletUsd: 5000 };
// "Still followable": current price within 5¢ of the smart-money entry.
const FOLLOWABLE_GAP = 0.05;

function fmtUsd(usd: number): string {
  return usd.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function shortWallet(w: string): string {
  if (!w) return "";
  return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

function fmtTime(tsSec: number): string {
  return new Date(tsSec * 1000).toLocaleTimeString("zh-CN", { hour12: false });
}

// Human window length between a start timestamp and now.
function fmtWindowSpan(sinceSec: number): string {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - sinceSec) / 60));
  if (mins < 60) return `~${mins} 分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `~${h} 小时` : `~${h} 小时 ${m} 分`;
}

export default function ConsensusPage() {
  const [hours, setHours] = useState<Hours>(DEFAULTS.hours);
  const [minWallets, setMinWallets] = useState<number>(DEFAULTS.minWallets);
  const [minPerWalletUsd, setMinPerWalletUsd] = useState<number>(
    DEFAULTS.minPerWalletUsd,
  );
  const [data, setData] = useState<ConsensusResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Flips true once the URL params have been read into state — the first fetch
  // and the URL write-back both wait for it.
  const [urlReady, setUrlReady] = useState<boolean>(false);

  const activeReq = useRef<number>(0);

  // Hydrate filters from the URL once on mount (client-only, so SSR markup and
  // the first client render agree — no hydration mismatch). Absent or invalid
  // params keep the defaults; the write-back effect below then canonicalizes
  // the address bar.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const qHours = parseChoiceParam(p.get("hours"), HOURS_CHOICES);
    if (qHours != null) setHours(qHours);
    const qMinWallets = parseChoiceParam(
      p.get("minWallets"),
      MIN_WALLETS_CHOICES,
    );
    if (qMinWallets != null) setMinWallets(qMinWallets);
    const qMinPer = parseNumParam(p.get("minPerWalletUsd"), {
      min: 1,
      int: true,
    });
    if (qMinPer != null) setMinPerWalletUsd(qMinPer);
    setUrlReady(true);
  }, []);

  // Mirror the filter state back into the URL (replaceState → no history spam)
  // so a tuned view survives refresh and can be shared as a link.
  useEffect(() => {
    if (!urlReady) return;
    replaceUrlQuery(
      buildQueryString([
        ["hours", hours !== DEFAULTS.hours ? String(hours) : null],
        [
          "minWallets",
          minWallets !== DEFAULTS.minWallets ? String(minWallets) : null,
        ],
        [
          "minPerWalletUsd",
          minPerWalletUsd !== DEFAULTS.minPerWalletUsd
            ? String(minPerWalletUsd)
            : null,
        ],
      ]),
    );
  }, [urlReady, hours, minWallets, minPerWalletUsd]);

  const load = useCallback(async () => {
    const reqId = ++activeReq.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        hours: String(hours),
        minWallets: String(minWallets),
        minPerWalletUsd: String(minPerWalletUsd),
      });
      const res = await fetch(`/api/consensus?${qs.toString()}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as ConsensusResponse;
      if (reqId !== activeReq.current) return;
      setData(json);
      setLastRefreshed(
        new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      );
    } catch (e) {
      if (reqId !== activeReq.current) return;
      setData({
        filters: { hours, minWallets, minPerWalletUsd },
        smartCount: 0,
        truncated: false,
        effectiveSinceSec: null,
        groups: [],
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (reqId === activeReq.current) setLoading(false);
    }
  }, [hours, minWallets, minPerWalletUsd]);

  // Refetch whenever a filter changes. The FIRST fetch waits for the URL
  // hydration above so a shared link never fires a throwaway default query.
  useEffect(() => {
    if (!urlReady) return;
    load();
  }, [urlReady, load]);

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const groups = data?.groups ?? [];
  const totalNet = groups.reduce((s, g) => s + g.totalNetUsd, 0);

  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-4)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", marginBottom: "var(--s-1)" }}>
          🔥 聪明钱共识
        </h1>
        <div className="ds-hint">
          ≥N 个白名单钱包在窗口内同向买入同一结果 — 比任何单笔大单都强的信号
          {lastRefreshed ? ` · 最后刷新 ${lastRefreshed}` : ""}
          {loading ? (
            <span style={{ color: "var(--warn-700)" }}> · 加载中…</span>
          ) : null}
        </div>
      </header>

      {/* Controls */}
      <section
        className="ds-card"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-3)",
          padding: "var(--s-4)",
          marginBottom: "var(--s-5)",
        }}
      >
        <Field label="时间窗">
          <Segmented<Hours>
            ariaLabel="时间窗"
            value={hours}
            onChange={setHours}
            options={([2, 6, 12] as Hours[]).map((h) => ({
              label: `${h}h`,
              value: h,
            }))}
          />
        </Field>
        <Field label="最少钱包">
          <Segmented<number>
            ariaLabel="最少钱包数"
            value={minWallets}
            onChange={setMinWallets}
            options={[2, 3, 4].map((n) => ({ label: `≥${n} 个`, value: n }))}
          />
        </Field>
        <Field label="每钱包净买">
          <Segmented<number>
            ariaLabel="每钱包净买入下限"
            value={minPerWalletUsd}
            onChange={setMinPerWalletUsd}
            options={PER_WALLET_PRESETS.map((p) => ({
              label: <span className="mono">${fmtUsd(p)}</span>,
              value: p,
            }))}
          />
          <span style={{ flex: 1 }} />
          <button className="ds-btn ds-btn--ghost" onClick={() => load()}>
            刷新
          </button>
        </Field>
      </section>

      {data?.error ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-4)" }}
        >
          加载失败: {data.error}
        </div>
      ) : null}

      {data && data.smartCount === 0 ? (
        <div
          className="ds-callout ds-callout--warn"
          style={{ marginBottom: "var(--s-4)" }}
        >
          聪明钱白名单为空 — 引擎启动后每日自动从官方盈利榜播种（首次约 1
          分钟内完成）
        </div>
      ) : null}

      {data ? (
        <section className="kpi" style={{ marginBottom: "var(--s-5)" }}>
          <StatCard label="共识组数">
            <div className="kpi-value">{groups.length}</div>
          </StatCard>
          <StatCard label="合计净买入">
            <div className="kpi-value">${fmtUsd(totalNet)}</div>
          </StatCard>
          <StatCard label="白名单钱包">
            <div className="kpi-value">{data.smartCount}</div>
          </StatCard>
        </section>
      ) : null}

      {data?.truncated && data.effectiveSinceSec ? (
        <div className="ds-callout" style={{ marginBottom: "var(--s-4)" }}>
          ⏱️ 成交太密集，API 回看深度已用满 — 本页基于{" "}
          <strong>完整覆盖的 {fmtWindowSpan(data.effectiveSinceSec)}</strong>
          （自 {fmtTime(data.effectiveSinceSec)} 起，买卖双侧均完整）检测
        </div>
      ) : null}

      {data && groups.length === 0 && !loading ? (
        <div className="ds-empty">
          窗口内暂无聪明钱共识 — 出现时也会推送到实时告警
        </div>
      ) : groups.length > 0 ? (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th style={{ width: 28, padding: "var(--s-2) var(--s-1)" }} />
                <th>市场 · 结果</th>
                <th className="is-right">钱包数</th>
                <th className="is-right">合计净买入</th>
                <th className="is-right" title="按金额加权的聪明钱建仓均价">
                  建仓均价
                </th>
                <th className="is-right" title="Gamma 最新赔率">
                  现价
                </th>
                <th>跟单空间</th>
                <th className="is-right">最新时间</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const key = `${g.conditionId}:${g.outcome}`;
                const isOpen = expanded.has(key);
                const gap =
                  g.currentPrice != null
                    ? g.currentPrice - g.avgBuyPrice
                    : null;
                // A price pinned at 0/1 means the event is decided even when
                // gamma's `closed` flag lags — either way "following" is moot.
                const settled =
                  g.closed ||
                  (g.currentPrice != null &&
                    (g.currentPrice >= 0.999 || g.currentPrice <= 0.001));
                return (
                  <Fragment key={key}>
                    <tr
                      onClick={() => toggleExpand(key)}
                      style={{ cursor: "pointer" }}
                      title={isOpen ? "点击收起钱包明细" : "点击展开钱包明细"}
                    >
                      <td
                        className="muted"
                        style={{
                          padding: "var(--s-3) var(--s-1)",
                          textAlign: "center",
                          userSelect: "none",
                        }}
                      >
                        {isOpen ? "▾" : "▸"}
                      </td>
                      <td style={{ whiteSpace: "normal", maxWidth: 380 }}>
                        {g.eventSlug ? (
                          <a
                            href={`https://polymarket.com/event/${g.eventSlug}`}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {g.title}
                          </a>
                        ) : (
                          g.title
                        )}
                        <div className="kpi-sub">
                          {g.outcome}
                          {g.category ? ` · ${g.category}` : ""}
                        </div>
                      </td>
                      <td className="mono is-right">
                        <span style={{ fontWeight: 700 }}>
                          <Icon s="🔥" /> {g.walletCount}
                        </span>
                      </td>
                      <td className="mono is-right">
                        <span className="up" style={{ fontWeight: 700 }}>
                          ${fmtUsd(g.totalNetUsd)}
                        </span>
                      </td>
                      <td
                        className="mono is-right"
                        style={{ color: "var(--warn-700)", fontWeight: 600 }}
                      >
                        {g.avgBuyPrice.toFixed(3)}
                      </td>
                      <td className="mono is-right">
                        {g.currentPrice != null
                          ? g.currentPrice.toFixed(3)
                          : "…"}
                      </td>
                      <td>
                        {gap == null ? (
                          <span className="muted">—</span>
                        ) : settled ? (
                          // Settled market: following is moot — show whether
                          // the smart-money consensus was RIGHT instead.
                          g.currentPrice != null && g.currentPrice > 0.5 ? (
                            <Tag variant="up">已结算 ✓ 命中</Tag>
                          ) : (
                            <Tag variant="down">已结算 ✗ 落空</Tag>
                          )
                        ) : gap <= FOLLOWABLE_GAP ? (
                          <Tag variant="up">
                            仍可跟 {gap >= 0 ? "+" : ""}
                            {(gap * 100).toFixed(1)}¢
                          </Tag>
                        ) : (
                          <Tag variant="warn">
                            已跑 +{(gap * 100).toFixed(1)}¢
                          </Tag>
                        )}
                      </td>
                      <td className="mono muted is-right">
                        {fmtTime(g.lastTs)}
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr>
                        <td
                          colSpan={8}
                          style={{
                            padding: "0 var(--s-3) var(--s-3) var(--s-10)",
                            borderBottom: "1px solid var(--n-150)",
                            background: "var(--n-50)",
                          }}
                        >
                          <div
                            className="ds-hint"
                            style={{ margin: "var(--s-2) 0 var(--s-1)" }}
                          >
                            共识钱包（按净买入排序）
                          </div>
                          <table
                            className="ds-table--compact"
                            style={{ maxWidth: 560 }}
                          >
                            <thead>
                              <tr>
                                <th>钱包</th>
                                <th className="is-right">评分</th>
                                <th className="is-right">净买入</th>
                                <th className="is-right">笔数</th>
                                <th className="is-right">建仓均价</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.wallets.map((w) => (
                                <tr key={`${key}-${w.wallet}`}>
                                  <td>
                                    <a
                                      className="mono"
                                      href={`/wallet/${w.wallet}`}
                                      title={`${w.wallet} · 点击查看钱包档案`}
                                    >
                                      <Icon s="🏆" /> {shortWallet(w.wallet)}
                                    </a>
                                  </td>
                                  <td className="mono is-right">
                                    {w.score != null
                                      ? Math.round(w.score)
                                      : "—"}
                                  </td>
                                  <td className="mono is-right">
                                    ${fmtUsd(w.netUsd)}
                                  </td>
                                  <td className="mono is-right">
                                    {w.buyCount}
                                  </td>
                                  <td
                                    className="mono is-right"
                                    style={{ color: "var(--warn-700)" }}
                                  >
                                    {w.avgBuyPrice.toFixed(3)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </main>
  );
}
