"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AgeBadge,
  CopyButton,
  Field,
  Icon,
  Segmented,
  SideTag,
  SoundToggle,
  StatCard,
  WalletStatsBadge,
  catLabel,
} from "./ui";
import { playBubble } from "./sound";
import { useSoundToggle } from "./useSound";
import { useWalletIntel } from "./useWalletIntel";

type ScanTrade = {
  title: string;
  outcome: string;
  side: "BUY" | "SELL";
  usd: number;
  price: number;
  wallet: string;
  eventSlug: string;
  slug: string;
  txHash: string;
  ts: number;
  category: string | null;
};

type ScanStats = {
  count: number;
  totalUsd: number;
  buyUsd: number;
  sellUsd: number;
  maxTrade: ScanTrade | null;
};

type ScanResponse = {
  filters: { minUsd: number; side: "BUY" | "SELL" | "ALL"; hours: number };
  stats: ScanStats;
  truncated: boolean;
  trades: ScanTrade[];
  error?: string;
};

type Side = "ALL" | "BUY" | "SELL";
type Hours = 1 | 6 | 24;

const AMOUNT_PRESETS = [10000, 50000, 100000];
// Sentinel for the "全部" (no cap) option in the address-age segmented control,
// since the control's value type can't be null.
const AGE_ALL = -1;

function fmtUsd(usd: number): string {
  return usd.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function shortWallet(w: string): string {
  if (!w) return "";
  return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

function fmtClock(sec: number): string {
  if (!sec) return "";
  return new Date(sec * 1000).toLocaleTimeString("zh-CN", { hour12: false });
}

export default function Page() {
  const [minUsd, setMinUsd] = useState<number>(10000);
  const [side, setSide] = useState<Side>("ALL");
  const [hours, setHours] = useState<Hours>(24);
  const [data, setData] = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
  // Local text state for the custom amount input so typing intermediate values
  // (e.g. while clearing the field) doesn't immediately refetch with garbage.
  const [customText, setCustomText] = useState<string>("");
  // Sorting is purely client-side over the already-fetched rows.
  const [sortKey, setSortKey] = useState<"time" | "amount">("time");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // wallet(lowercased) -> ageDays|null. Filled lazily after the table renders;
  // permanently cached server-side so repeat lookups are instant.
  const [ages, setAges] = useState<Record<string, number | null>>({});
  // Client-side insider-pattern filters. Insider-information money tends to buy
  // at FAVORABLE ODDS (a price band) using RELATIVELY NEW wallets, so these two
  // filters let the user isolate that pattern (e.g. price 0.5–0.9 AND age ≤ 7天).
  const [minPrice, setMinPrice] = useState<string>("");
  const [maxPrice, setMaxPrice] = useState<string>("");
  // null = 全部 (no age cap); otherwise keep only confirmed wallets with age ≤ N天.
  const [maxAgeDays, setMaxAgeDays] = useState<number | null>(null);
  // Market-category filter (client-side, over the server-enriched rows).
  // null = 全部; matches on the DISPLAY label so "其他" buckets all unknowns.
  const [category, setCategory] = useState<string | null>(null);

  const activeReq = useRef<number>(0);

  const load = useCallback(async () => {
    const reqId = ++activeReq.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        minUsd: String(minUsd),
        side,
        hours: String(hours),
      });
      const res = await fetch(`/api/scan?${qs.toString()}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as ScanResponse;
      // Ignore stale responses from superseded filter changes.
      if (reqId !== activeReq.current) return;
      setData(json);
      setLastRefreshed(
        new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      );
    } catch (e) {
      if (reqId !== activeReq.current) return;
      setData({
        filters: { minUsd, side, hours },
        stats: { count: 0, totalUsd: 0, buyUsd: 0, sellUsd: 0, maxTrade: null },
        truncated: false,
        trades: [],
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (reqId === activeReq.current) setLoading(false);
    }
  }, [minUsd, side, hours]);

  // Refetch whenever a filter changes (and on mount).
  useEffect(() => {
    load();
  }, [load]);

  // Optional 30s auto-refresh.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  // Lazily enrich rows with address age. Collect distinct wallets not yet resolved,
  // POST them, and merge ageDays into `ages` (keyed by lowercased wallet).
  useEffect(() => {
    const trades = data?.trades;
    if (!trades || trades.length === 0) return;
    const want = [
      ...new Set(
        trades
          .map((t) => t.wallet?.toLowerCase())
          .filter((w): w is string => Boolean(w)),
      ),
    ].filter((w) => !(w in ages));
    if (want.length === 0) return;
    let cancelled = false;
    (async () => {
      // Chunk so every requested wallet stays under the route's cap and resolves
      // (progressive fill for large result sets instead of dropping the overflow).
      const CHUNK = 100;
      for (let i = 0; i < want.length && !cancelled; i += CHUNK) {
        const batch = want.slice(i, i + CHUNK);
        try {
          const res = await fetch("/api/wallet-age", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ wallets: batch }),
          });
          const json = (await res.json()) as {
            ages?: Record<string, { ageDays: number | null }>;
          };
          if (cancelled) return;
          const next: Record<string, number | null> = {};
          for (const w of batch) next[w] = json.ages?.[w]?.ageDays ?? null;
          setAges((prev) => ({ ...prev, ...next }));
        } catch {
          // Best-effort enrichment; leave this batch showing "…".
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, ages]);

  // --- New-trade sound notification --------------------------------------
  // Chime when a refresh (auto/manual) brings genuinely new trades. A change of
  // the server filters (amount/side/hours) reseeds the baseline SILENTLY — that
  // is a new query, not a record arriving — so only same-filter refreshes ring.
  const { soundOn, toggle } = useSoundToggle();
  const seenTradeKeys = useRef<Set<string>>(new Set());
  const lastFilterSig = useRef<string>("");

  useEffect(() => {
    if (!data?.trades) return;
    const f = data.filters;
    const sig = `${f.minUsd}|${f.side}|${f.hours}`;
    const keys = data.trades.map((t) => t.txHash || `${t.wallet}-${t.ts}`);
    if (sig !== lastFilterSig.current) {
      lastFilterSig.current = sig;
      seenTradeKeys.current = new Set(keys);
      return;
    }
    let hasNew = false;
    for (const k of keys) {
      if (!seenTradeKeys.current.has(k)) {
        seenTradeKeys.current.add(k);
        hasNew = true;
      }
    }
    if (hasNew && soundOn) playBubble();
  }, [data, soundOn]);

  function applyCustom() {
    const n = Number(customText);
    if (Number.isFinite(n) && n > 0) {
      setMinUsd(Math.floor(n));
      setCustomText("");
    }
  }

  const sortedTrades = useMemo(() => {
    const arr = data?.trades ? [...data.trades] : [];
    arr.sort((a, b) => {
      const av = sortKey === "time" ? a.ts : a.usd;
      const bv = sortKey === "time" ? b.ts : b.usd;
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [data, sortKey, sortDir]);

  // Apply the client-side insider-pattern filters (price band + young-wallet cap)
  // on top of the sorted rows. Blank/NaN bounds are ignored. The age filter HIDES
  // unknown-age and older rows, so the view converges to confirmed-young wallets
  // as `ages` lazily fills in.
  const displayedTrades = useMemo(() => {
    const min = parseFloat(minPrice);
    const max = parseFloat(maxPrice);
    const hasMin = Number.isFinite(min);
    const hasMax = Number.isFinite(max);
    return sortedTrades.filter((t) => {
      if (hasMin && t.price < min) return false;
      if (hasMax && t.price > max) return false;
      if (category != null && catLabel(t.category) !== category) return false;
      if (maxAgeDays != null) {
        const a = ages[t.wallet?.toLowerCase()];
        if (typeof a !== "number" || !Number.isFinite(a) || a > maxAgeDays) {
          return false;
        }
      }
      return true;
    });
  }, [sortedTrades, minPrice, maxPrice, category, maxAgeDays, ages]);

  // Category chips: the display labels present in the current pull, by row
  // count (max 8 shown) — the taxonomy on screen always matches the data.
  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of data?.trades ?? []) {
      const label = catLabel(t.category);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([label]) => label);
  }, [data]);

  // When the age filter is active, some rows that pass the price band may still
  // have unresolved age (showing "…"); the result keeps converging as ages load.
  const agesStillLoading = useMemo(() => {
    if (maxAgeDays == null) return false;
    const min = parseFloat(minPrice);
    const max = parseFloat(maxPrice);
    const hasMin = Number.isFinite(min);
    const hasMax = Number.isFinite(max);
    return sortedTrades.some((t) => {
      if (hasMin && t.price < min) return false;
      if (hasMax && t.price > max) return false;
      if (category != null && catLabel(t.category) !== category) return false;
      const w = t.wallet?.toLowerCase();
      return !w || !(w in ages);
    });
  }, [sortedTrades, minPrice, maxPrice, category, maxAgeDays, ages]);

  // Settled-market track record + smart-wallet flags, enriched lazily for the
  // rows that survive the client-side filters (the narrowed view fills first).
  const { stats: walletStats, smart } = useWalletIntel(
    displayedTrades.map((t) => t.wallet),
  );

  function toggleSort(key: "time" | "amount") {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const sortArrow = (key: "time" | "amount") =>
    sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  const stats = data?.stats;
  const buyUsd = stats?.buyUsd ?? 0;
  const sellUsd = stats?.sellUsd ?? 0;
  const sideTotal = buyUsd + sellUsd;
  const buyPct = sideTotal > 0 ? (buyUsd / sideTotal) * 100 : 0;
  const sellPct = sideTotal > 0 ? 100 - buyPct : 0;

  return (
    <main className="ds-main">
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "var(--s-4)",
          marginBottom: "var(--s-4)",
        }}
      >
        <div>
          <h1 style={{ fontSize: "var(--t-2xl)", marginBottom: "var(--s-1)" }}>
            🔍 24h 大额成交扫描器
          </h1>
          <div className="ds-hint">
            实时查询 Polymarket 公共 API（不落库）
            {lastRefreshed ? ` · 最后刷新 ${lastRefreshed}` : ""}
            {loading ? (
              <span style={{ color: "var(--warn-700)" }}> · 加载中…</span>
            ) : null}
          </div>
        </div>
        <SoundToggle on={soundOn} onToggle={toggle} />
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
        <Field label="金额">
          <Segmented<number>
            ariaLabel="最低金额"
            value={minUsd}
            onChange={setMinUsd}
            options={AMOUNT_PRESETS.map((p) => ({
              label: <span className="mono">${fmtUsd(p)}</span>,
              value: p,
            }))}
          />
          <input
            type="number"
            min={0}
            placeholder="自定义 USD"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onBlur={applyCustom}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyCustom();
            }}
            className="ds-input ds-input--mono"
            style={{ width: 130 }}
          />
          <span className="ds-hint">
            当前 ≥ <span className="mono">${fmtUsd(minUsd)}</span>
          </span>
        </Field>

        <Field label="方向">
          <Segmented<Side>
            ariaLabel="方向"
            value={side}
            onChange={setSide}
            options={[
              { label: "全部", value: "ALL" },
              { label: "买入 BUY", value: "BUY" },
              { label: "卖出 SELL", value: "SELL" },
            ]}
          />
        </Field>

        <Field label="时间">
          <Segmented<Hours>
            ariaLabel="时间窗"
            value={hours}
            onChange={setHours}
            options={([1, 6, 24] as Hours[]).map((h) => ({
              label: `${h}h`,
              value: h,
            }))}
          />
          <span style={{ flex: 1 }} />
          <button className="ds-btn ds-btn--ghost" onClick={() => load()}>
            刷新
          </button>
          <label
            className="ds-hint"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--s-1)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            自动刷新 30s
          </label>
        </Field>

        {/* Price (odds) band — insider money tends to buy at favorable odds. */}
        <Field label="价格">
          <input
            type="number"
            step={0.01}
            min={0}
            max={1}
            placeholder="0"
            value={minPrice}
            onChange={(e) => setMinPrice(e.target.value)}
            className="ds-input ds-input--mono"
            style={{ width: 70 }}
          />
          <span className="ds-hint">–</span>
          <input
            type="number"
            step={0.01}
            min={0}
            max={1}
            placeholder="1"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            className="ds-input ds-input--mono"
            style={{ width: 70 }}
          />
          {minPrice || maxPrice ? (
            <button
              className="ds-btn ds-btn--subtle ds-btn--sm"
              onClick={() => {
                setMinPrice("");
                setMaxPrice("");
              }}
            >
              清除
            </button>
          ) : null}
          <span className="ds-hint">赔率 0–1</span>
        </Field>

        {/* Market category — from the event's gamma tags, server-enriched. */}
        <Field label="类型">
          <Segmented<string>
            ariaLabel="市场类型"
            value={category ?? "__ALL__"}
            onChange={(v) => setCategory(v === "__ALL__" ? null : v)}
            options={[
              { label: "全部", value: "__ALL__" },
              ...categoryOptions.map((c) => ({ label: c, value: c })),
            ]}
          />
        </Field>

        {/* Address age — insider money tends to use relatively new wallets. */}
        <Field label="地址年龄">
          <Segmented<number>
            ariaLabel="地址年龄"
            value={maxAgeDays ?? AGE_ALL}
            onChange={(v) => setMaxAgeDays(v === AGE_ALL ? null : v)}
            options={[
              { label: "全部", value: AGE_ALL },
              { label: "≤1天", value: 1 },
              { label: "≤7天", value: 7 },
              { label: "≤30天", value: 30 },
            ]}
          />
          <span className="ds-hint">≤</span>
          <input
            type="number"
            min={0}
            placeholder="__"
            value={
              maxAgeDays != null && ![1, 7, 30].includes(maxAgeDays)
                ? String(maxAgeDays)
                : ""
            }
            onChange={(e) => {
              const v = e.target.value.trim();
              if (v === "") {
                setMaxAgeDays(null);
                return;
              }
              const n = Number(v);
              setMaxAgeDays(Number.isFinite(n) && n >= 0 ? n : null);
            }}
            className="ds-input ds-input--mono"
            style={{ width: 56 }}
          />
          <span className="ds-hint">天</span>
        </Field>
      </section>

      {data?.error ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-4)" }}
        >
          扫描失败: {data.error}
        </div>
      ) : null}

      {/* Stats header */}
      {stats ? (
        <section className="kpi" style={{ marginBottom: "var(--s-5)" }}>
          <StatCard label="笔数">
            <div className="kpi-value">{stats.count}</div>
          </StatCard>
          <StatCard label="总额">
            <div className="kpi-value">${fmtUsd(stats.totalUsd)}</div>
          </StatCard>
          <StatCard label="买额 vs 卖额">
            <div
              className="mono"
              style={{ fontSize: "var(--t-md)", margin: "var(--s-2) 0" }}
            >
              <span className="up" style={{ fontWeight: 600 }}>
                买 ${fmtUsd(buyUsd)}
              </span>
              <span className="muted"> · </span>
              <span className="down" style={{ fontWeight: 600 }}>
                卖 ${fmtUsd(sellUsd)}
              </span>
            </div>
            <div
              style={{
                height: 8,
                borderRadius: 4,
                overflow: "hidden",
                display: "flex",
                background: "var(--n-100)",
              }}
            >
              <div
                style={{ width: `${buyPct}%`, background: "var(--up-500)" }}
              />
              <div
                style={{ width: `${sellPct}%`, background: "var(--down-500)" }}
              />
            </div>
          </StatCard>
          <StatCard label="最大单">
            {stats.maxTrade ? (
              <div>
                <div className="kpi-value" style={{ fontSize: 18 }}>
                  ${fmtUsd(stats.maxTrade.usd)}
                </div>
                <div
                  className="kpi-sub"
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={stats.maxTrade.title}
                >
                  {stats.maxTrade.title}
                </div>
              </div>
            ) : (
              <div className="kpi-value muted" style={{ fontSize: 18 }}>
                —
              </div>
            )}
          </StatCard>
        </section>
      ) : null}

      {data?.truncated ? (
        <div
          className="ds-callout ds-callout--warn"
          style={{ marginBottom: "var(--s-4)" }}
        >
          ⏱️ 成交太密集，API 回看深度已用满 — 时间窗尾部的部分成交未覆盖
        </div>
      ) : null}

      {/* Filtered count (reflects the client-side price/age filters) */}
      {data && data.trades.length > 0 ? (
        <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
          符合筛选{" "}
          <strong className="mono" style={{ color: "var(--n-800)" }}>
            {displayedTrades.length}
          </strong>{" "}
          笔
          {agesStillLoading ? (
            <span className="muted"> · 地址年龄加载中，结果将随加载补全</span>
          ) : null}
        </div>
      ) : null}

      {/* Table */}
      {data && data.trades.length === 0 && !loading ? (
        <div className="ds-empty">该筛选条件下 {hours}h 内暂无成交</div>
      ) : data && data.trades.length > 0 ? (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th
                  className="is-sortable"
                  onClick={() => toggleSort("time")}
                  title="点击按时间排序"
                >
                  时间{sortArrow("time")}
                </th>
                <th>市场 / 结果</th>
                <th>方向</th>
                <th
                  className="is-sortable is-right"
                  onClick={() => toggleSort("amount")}
                  title="点击按金额排序"
                >
                  金额{sortArrow("amount")}
                </th>
                <th className="is-right">价格</th>
                <th>钱包</th>
                <th>地址年龄</th>
                <th title="已结算市场胜率 · 已实现盈亏（🏆 = 聪明钱白名单）">
                  战绩
                </th>
                <th>tx</th>
              </tr>
            </thead>
            <tbody>
              {displayedTrades.map((t, i) => {
                const whale = t.usd >= 50000;
                return (
                  <tr key={`${t.txHash}-${t.wallet}-${i}`}>
                    <td className="mono muted">{fmtClock(t.ts)}</td>
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
                      {/* Copy button lives on the (short, single-line) subtitle
                          row so it can never orphan-wrap under a long title.
                          It copies the EVENT slug (the whole markets page, e.g.
                          fifwc-che-alg-2026-07-02) — not the per-outcome market
                          slug (…-che); for standalone markets they're identical. */}
                      <div className="kpi-sub" style={{ whiteSpace: "nowrap" }}>
                        {t.outcome}
                        {t.category ? ` · ${catLabel(t.category)}` : ""}
                        <CopyButton
                          text={t.eventSlug || t.slug}
                          label="复制 slug"
                        />
                      </div>
                    </td>
                    <td>
                      <SideTag side={t.side} />
                    </td>
                    <td className="mono is-right">
                      <Icon s={whale ? "🐳" : "💰"} /> ${fmtUsd(t.usd)}
                    </td>
                    <td className="mono is-right">{t.price.toFixed(3)}</td>
                    <td>
                      <a
                        className="mono"
                        href={`/wallet/${t.wallet?.toLowerCase()}`}
                        title={`${t.wallet} · 点击查看钱包档案`}
                      >
                        {shortWallet(t.wallet)}
                      </a>
                    </td>
                    <td>
                      <AgeBadge ageDays={ages[t.wallet?.toLowerCase()]} />
                    </td>
                    <td>
                      <WalletStatsBadge
                        stats={walletStats[t.wallet?.toLowerCase()]}
                        smart={smart[t.wallet?.toLowerCase()]}
                      />
                    </td>
                    <td>
                      {t.txHash ? (
                        <a
                          href={`https://polygonscan.com/tx/${t.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          ↗
                        </a>
                      ) : (
                        ""
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </main>
  );
}
