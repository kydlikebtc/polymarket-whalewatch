"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AgeBadge,
  CopyButton,
  Field,
  Icon,
  QuietLink,
  Segmented,
  SideTag,
  SoundToggle,
  StatCard,
  WalletStatsBadge,
  catLabel,
  type SmartInfoLite,
  type WalletStatsLite,
} from "./ui";
import { playBubble } from "./sound";
import { useSoundToggle } from "./useSound";
import { useAutoRetryOnError } from "./autoRetry";
import { useWalletIntel } from "./useWalletIntel";
import { useWalletAges } from "./useWalletAges";
import { capRows, tableViewState } from "./tableView";
import {
  buildQueryString,
  parseChoiceParam,
  parseNumParam,
  replaceUrlQuery,
} from "./urlQuery";

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
type SortKey = "time" | "amount";
type SortDir = "asc" | "desc";

const AMOUNT_PRESETS = [10000, 50000, 100000];

// External trade page for a market slug (wired.fund tooling).
const TRADE_LINK_BASE =
  "https://onchain-dev.wired.fund/polymarket/trade-slug?slug=";
// Sentinel for the "全部" (no cap) option in the address-age segmented control,
// since the control's value type can't be null.
const AGE_ALL = -1;

const SIDES = ["ALL", "BUY", "SELL"] as const;
const HOURS_CHOICES = [1, 6, 24] as const;
const SORT_KEYS = ["time", "amount"] as const;
const SORT_DIRS = ["asc", "desc"] as const;
// Page defaults — doubling as the "omit from URL" baseline so the default
// view serializes to a bare pathname.
const DEFAULTS = {
  minUsd: 10000,
  side: "ALL" as Side,
  hours: 24 as Hours,
  sortKey: "time" as SortKey,
  sortDir: "desc" as SortDir,
};

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

/* ------------------------------------------------------------------ Row */

// One table row, memoized so the lazy age/stats batches (100 / 50 wallets per
// chunk) only re-render the rows whose wallet data actually arrived — without
// this every merged batch re-rendered ALL rows (~6000 on a low-floor scan).
type ScanRowProps = {
  t: ScanTrade;
  age: number | null | undefined;
  stats: WalletStatsLite | null | undefined;
  smart: SmartInfoLite | null | undefined;
};

const ScanRow = memo(function ScanRow({ t, age, stats, smart }: ScanRowProps) {
  const whale = t.usd >= 50000;
  return (
    <tr>
      <td className="mono muted" data-label="时间">
        {fmtClock(t.ts)}
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
        {/* Copy button lives on the (short, single-line) subtitle row so it
            can never orphan-wrap under a long title. It copies the MARKET slug
            (the per-market key gamma /markets?slug= takes) — not the event
            slug. */}
        <div className="kpi-sub" style={{ whiteSpace: "nowrap" }}>
          {t.outcome}
          {t.category ? ` · ${catLabel(t.category)}` : ""}
          <CopyButton text={t.slug || t.eventSlug} label="复制 market slug" />
          {t.slug || t.eventSlug ? (
            <QuietLink
              href={`${TRADE_LINK_BASE}${encodeURIComponent(t.slug || t.eventSlug)}`}
              title={`在 wired.fund 打开交易页：${t.slug || t.eventSlug}`}
            >
              ↗
            </QuietLink>
          ) : null}
        </div>
      </td>
      <td data-label="方向">
        <SideTag side={t.side} />
      </td>
      <td className="mono is-right" data-label="金额">
        <Icon s={whale ? "🐳" : "💰"} /> ${fmtUsd(t.usd)}
      </td>
      <td className="mono is-right" data-label="价格">
        {t.price.toFixed(3)}
      </td>
      <td data-label="钱包">
        <a
          className="mono"
          href={`/wallet/${t.wallet?.toLowerCase()}`}
          target="_blank"
          rel="noreferrer"
          title={`${t.wallet} · 新标签打开钱包档案`}
        >
          {shortWallet(t.wallet)}
        </a>
      </td>
      <td data-label="地址年龄">
        <AgeBadge ageDays={age} />
      </td>
      <td data-label="战绩">
        <WalletStatsBadge stats={stats} smart={smart} />
      </td>
      <td data-label="tx">
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
});

export default function Page() {
  const [minUsd, setMinUsd] = useState<number>(DEFAULTS.minUsd);
  const [side, setSide] = useState<Side>(DEFAULTS.side);
  const [hours, setHours] = useState<Hours>(DEFAULTS.hours);
  const [data, setData] = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
  // Local text state for the custom amount input so typing intermediate values
  // (e.g. while clearing the field) doesn't immediately refetch with garbage.
  const [customText, setCustomText] = useState<string>("");
  // Sorting is purely client-side over the already-fetched rows.
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULTS.sortKey);
  const [sortDir, setSortDir] = useState<SortDir>(DEFAULTS.sortDir);
  // Client-side insider-pattern filters. Insider-information money tends to buy
  // at FAVORABLE ODDS (a price band) using RELATIVELY NEW wallets, so these two
  // filters let the user isolate that pattern (e.g. price 0.5–0.9 AND age ≤ 7天).
  const [minPrice, setMinPrice] = useState<string>("");
  const [maxPrice, setMaxPrice] = useState<string>("");
  // null = 全部 (no age cap); otherwise keep only confirmed wallets with age ≤ N天.
  const [maxAgeDays, setMaxAgeDays] = useState<number | null>(null);
  // Flips true once the URL params have been read into state — the first fetch
  // and the URL write-back both wait for it.
  const [urlReady, setUrlReady] = useState<boolean>(false);
  // Render cap escape hatch ("显示其余 N 行"). Sticky once expanded so the 30s
  // auto-refresh doesn't collapse the table under the user.
  const [showAllRows, setShowAllRows] = useState<boolean>(false);
  // Market-category filter (client-side, over the server-enriched rows).
  // null = 全部; matches on the DISPLAY label so "其他" buckets all unknowns.
  const [category, setCategory] = useState<string | null>(null);

  const activeReq = useRef<number>(0);

  // Hydrate filters from the URL once on mount (client-only, so SSR markup and
  // the first client render agree — no hydration mismatch). Absent or invalid
  // params keep the defaults; the write-back effect below then canonicalizes
  // the address bar.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const qMinUsd = parseNumParam(p.get("minUsd"), { min: 1, int: true });
    if (qMinUsd != null) setMinUsd(qMinUsd);
    const qSide = parseChoiceParam(p.get("side"), SIDES);
    if (qSide != null) setSide(qSide);
    const qHours = parseChoiceParam(p.get("hours"), HOURS_CHOICES);
    if (qHours != null) setHours(qHours);
    if (parseNumParam(p.get("minPrice"), { min: 0, max: 1 }) != null) {
      setMinPrice(p.get("minPrice") as string);
    }
    if (parseNumParam(p.get("maxPrice"), { min: 0, max: 1 }) != null) {
      setMaxPrice(p.get("maxPrice") as string);
    }
    const qMaxAge = parseNumParam(p.get("maxAgeDays"), { min: 0, int: true });
    if (qMaxAge != null) setMaxAgeDays(qMaxAge);
    const qSort = parseChoiceParam(p.get("sort"), SORT_KEYS);
    if (qSort != null) setSortKey(qSort);
    const qDir = parseChoiceParam(p.get("dir"), SORT_DIRS);
    if (qDir != null) setSortDir(qDir);
    setUrlReady(true);
  }, []);

  // Mirror the filter state back into the URL (replaceState → no history spam)
  // so a tuned view survives refresh and can be shared as a link.
  useEffect(() => {
    if (!urlReady) return;
    replaceUrlQuery(
      buildQueryString([
        ["minUsd", minUsd !== DEFAULTS.minUsd ? String(minUsd) : null],
        ["side", side !== DEFAULTS.side ? side : null],
        ["hours", hours !== DEFAULTS.hours ? String(hours) : null],
        ["minPrice", minPrice || null],
        ["maxPrice", maxPrice || null],
        ["maxAgeDays", maxAgeDays != null ? String(maxAgeDays) : null],
        ["sort", sortKey !== DEFAULTS.sortKey ? sortKey : null],
        ["dir", sortDir !== DEFAULTS.sortDir ? sortDir : null],
      ]),
    );
  }, [
    urlReady,
    minUsd,
    side,
    hours,
    minPrice,
    maxPrice,
    maxAgeDays,
    sortKey,
    sortDir,
  ]);

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

  // Refetch whenever a filter changes. The FIRST fetch waits for the URL
  // hydration above so a shared link never fires a throwaway default query.
  useEffect(() => {
    if (!urlReady) return;
    load();
  }, [urlReady, load]);

  // Optional 30s auto-refresh.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  // One-shot auto retry: a cold upstream cache 408s the deep pull (first load
  // AND filter switches — a new baseKey is a new cold query); our failed
  // attempts warm it, so a single delayed retry usually succeeds. While
  // pending, the error callout is swapped for a warm-up notice.
  const { retrying: autoRetrying, rearm: rearmAutoRetry } = useAutoRetryOnError(
    data,
    data?.trades.length ?? 0,
    load,
  );

  // wallet(lowercased) -> ageDays|null. Filled lazily after the table renders;
  // permanently cached server-side so repeat lookups are instant.
  const ages = useWalletAges((data?.trades ?? []).map((t) => t.wallet));

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

  // Cap the DOM rows — sorting/filtering/stat cards above all keep operating
  // on the FULL displayedTrades set; only the rendered row count truncates.
  const { visible: visibleTrades, hiddenCount } = capRows(
    displayedTrades,
    showAllRows,
  );

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  const stats = data?.stats;
  const buyUsd = stats?.buyUsd ?? 0;
  const sellUsd = stats?.sellUsd ?? 0;
  const sideTotal = buyUsd + sellUsd;
  const buyPct = sideTotal > 0 ? (buyUsd / sideTotal) * 100 : 0;
  const sellPct = sideTotal > 0 ? 100 - buyPct : 0;

  const view = tableViewState(data != null, data?.trades.length ?? 0, loading);

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
          <button
            className="ds-btn ds-btn--ghost"
            onClick={() => {
              // Manual refresh = a fresh user-triggered pull: re-arm the
              // one-shot auto-retry budget before firing.
              rearmAutoRetry();
              load();
            }}
          >
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

      {/* While the one-shot auto retry is pending, the transient error is
          being handled — show the warm-up notice (below) instead of a scary
          callout. A retry that fails again falls through to this callout. */}
      {data?.error && !autoRetrying ? (
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
      {autoRetrying ? (
        // The pull failed on a cold upstream cache and a one-shot retry is
        // scheduled — show progress instead of an error + empty table.
        <div className="ds-empty">⏳ 上游缓存预热中，自动重试…</div>
      ) : view === "loading" ? (
        // First fetch, nothing to show yet — a deep 24h pull can take 5-15s
        // and a blank area reads as "the tool is broken".
        <div className="ds-empty">
          ⏳ 正在扫描 {hours}h 成交 — 深度拉取首次约 5-15 秒，请稍候…
        </div>
      ) : view === "empty" ? (
        <div className="ds-empty">该筛选条件下 {hours}h 内暂无成交</div>
      ) : view === "rows" ? (
        <>
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
                {visibleTrades.map((t, i) => (
                  <ScanRow
                    key={`${t.txHash}-${t.wallet}-${i}`}
                    t={t}
                    age={ages[t.wallet?.toLowerCase()]}
                    stats={walletStats[t.wallet?.toLowerCase()]}
                    smart={smart[t.wallet?.toLowerCase()]}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {hiddenCount > 0 ? (
            <div style={{ textAlign: "center", marginTop: "var(--s-3)" }}>
              <button
                className="ds-btn ds-btn--ghost"
                onClick={() => setShowAllRows(true)}
              >
                显示其余 {hiddenCount} 行
              </button>
              <div className="ds-hint" style={{ marginTop: "var(--s-1)" }}>
                统计卡与「符合筛选」计数已包含全部 {displayedTrades.length} 笔
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
