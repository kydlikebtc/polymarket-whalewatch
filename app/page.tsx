"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AgeBadge,
  Icon,
  MarketSlugActions,
  Segmented,
  SideTag,
  SoundToggle,
  StatCard,
  WalletLink,
  WalletStatsBadge,
  catLabel,
  catLabelFine,
  type SmartInfoLite,
  type WalletStatsLite,
} from "./ui";
import { useLang } from "./i18n";
import { useSoundToggle } from "./useSound";
import { useNewRecordChime } from "./useNewRecordChime";
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
  conditionId: string;
  eventSlug: string;
  slug: string;
  txHash: string;
  ts: number;
  category: string | null;
  // 二级分类(体育联盟/加密资产等;null = 无/未知)。行内标签合成
  // 「体育·NBA」;类别筛选刻意保持一级 —— 二级会把 chips 从 ≤8 个炸到
  // 几十个,筛选粒度与展示粒度是两个决定。
  subcategory?: string | null;
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
  // Prop `t` is the trade, so the translator gets aliased to `tr` here. The
  // memo doesn't block language switches: useLang reads context, and context
  // updates re-render memoized consumers regardless of props.
  const { t: tr } = useLang();
  const whale = t.usd >= 50000;
  return (
    <tr>
      <td data-label={tr("时间")}>{fmtClock(t.ts)}</td>
      {/* 市场名永不截断 —— 换行（.cell-wrap：line-height 1.35 +
          overflow-wrap:anywhere），顶对齐。这一格刻意不带 data-label：
          移动端堆叠卡靠「无 label 的格」把它铺满整行当卡头。 */}
      <td className="cell-wrap" style={{ maxWidth: 420 }}>
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
        <div
          className="kpi-sub"
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "var(--s-2)",
          }}
        >
          {/* 结果名走灰底名称标签（Etherscan name tag）—— 灰底不表示状态。
              .ds-tag 默认 nowrap + 22px 定高；结果名不许截断，所以给超长的
              那几个解开换行（短名视觉零变化：minHeight 仍是 22）。 */}
          {t.outcome ? (
            <span
              className="ds-tag"
              style={{
                whiteSpace: "normal",
                overflowWrap: "anywhere",
                maxWidth: "100%",
                height: "auto",
                minHeight: "var(--h-tag)",
                lineHeight: 1.35,
              }}
            >
              {t.outcome}
            </span>
          ) : null}
          {/* 「体育·NBA」的合成/去重仍归 catLabelFine 唯一属主；这里只把
              合成结果按「·」逐段过字典（段=类别词表单词，词表不含「·」，
              未知标签透传英文原文、缺译回退原样）。 */}
          {t.category ? (
            <span>
              {catLabelFine(t.category, t.subcategory)
                .split("·")
                .map((seg) => tr(seg))
                .join("·")}
            </span>
          ) : null}
          <span style={{ display: "inline-flex", alignItems: "center" }}>
            <MarketSlugActions
              slug={t.slug}
              eventSlug={t.eventSlug}
              conditionId={t.conditionId}
            />
          </span>
        </div>
      </td>
      <td data-label={tr("方向")}>
        <SideTag side={t.side} />
      </td>
      {/* 金额只在巨鲸单上带 🐳 —— 每行都挂一个 💰 等于没挂，emoji 要承担语义 */}
      <td className="is-right" data-label={tr("金额")}>
        {whale ? (
          <>
            <Icon s="🐳" />{" "}
          </>
        ) : null}
        ${fmtUsd(t.usd)}
      </td>
      <td className="is-right" data-label={tr("价格")}>
        {t.price.toFixed(3)}
      </td>
      <td data-label={tr("钱包")}>
        {/* No explicit title: WalletLink's default is this exact copy, already
            translated via the common dict shard. */}
        <WalletLink address={t.wallet ?? ""}>
          {shortWallet(t.wallet)}
        </WalletLink>
      </td>
      <td data-label={tr("地址年龄")}>
        <AgeBadge ageDays={age} />
      </td>
      <td data-label={tr("战绩")}>
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
  const { t } = useLang();
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
  // Ring when a same-filter refresh brings genuinely new trades (a change of the
  // server filters reseeds the baseline silently). See useNewRecordChime.
  const { soundOn, toggle } = useSoundToggle();
  useNewRecordChime(
    data
      ? `${data.filters.minUsd}|${data.filters.side}|${data.filters.hours}`
      : null,
    (data?.trades ?? []).map((t) => t.txHash || `${t.wallet}-${t.ts}`),
    soundOn,
  );

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
      {/* 页头 —— 12px 小标（emoji 前缀）+ 24/600 标题 + ≤700px 描述 + 右侧动作钮 */}
      <header className="page-head">
        <div>
          <div className="page-head__eyebrow">
            💰 {t("实时扫描 · 不落库 · 时间 UTC")}
          </div>
          <h1 className="page-head__title">{t("大额成交扫描器")}</h1>
          <p className="page-head__desc">
            {t(
              "按金额、方向、时间窗、赔率与地址年龄筛出单笔大额成交；每一行都能点进钱包档案与市场信号卡。",
            )}
          </p>
        </div>
        <div className="page-head__actions">
          <SoundToggle on={soundOn} onToggle={toggle} />
        </div>
      </header>

      {/* 口径条 —— 统计声明放在数据「前面」，不放脚注。
          While the one-shot auto retry is pending, the transient error is
          being handled — show the warm-up notice (below) instead of a scary
          callout. A retry that fails again falls through to this callout. */}
      {data?.error && !autoRetrying ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-5)" }}
        >
          {t("扫描失败: {msg}", { msg: data.error })}
        </div>
      ) : null}

      {data?.truncated ? (
        <div
          className="ds-callout ds-callout--warn"
          style={{ marginBottom: "var(--s-5)" }}
        >
          {t("成交太密集，API 回看深度已用满 — 时间窗尾部的部分成交未覆盖")}
        </div>
      ) : null}

      {/* KPI 分格卡 —— 一张白卡内 4 等分，格间 1px 竖线 */}
      {stats ? (
        <section className="kpi" style={{ marginBottom: "var(--s-4)" }}>
          <StatCard label={t("笔数")} icon="📋">
            <div className="kpi-value">{fmtUsd(stats.count)}</div>
            {/* 值走 stats.count（服务端口径:只过 minUsd/side/hours）,副行走
                displayedTrades（再过价格区间 / 类型 / 地址年龄三项客户端筛选）。
                两个口径不同源,所以副行必须自报主语 —— 否则「已全部显示」会在
                客户端筛选把 1,911 收到 240 行时,对着 1,911 这个值撒谎。 */}
            <div className="kpi-sub">
              {hiddenCount > 0
                ? t("符合筛选 {m} 笔 · 显示前 {n} 条", {
                    m: fmtUsd(displayedTrades.length),
                    n: fmtUsd(visibleTrades.length),
                  })
                : t("符合筛选 {m} 笔 · 已全部显示", {
                    m: fmtUsd(displayedTrades.length),
                  })}
            </div>
          </StatCard>
          <StatCard label={t("总额")} icon="💰">
            <div className="kpi-value" style={{ color: "var(--ww-link)" }}>
              ${fmtUsd(stats.totalUsd)}
            </div>
            {/* 门槛读 data.filters.minUsd（跟 stats 同一次响应）而不是 minUsd
                这个筛选 state:切金额档后深拉要 5-15 秒,期间 state 已是新门槛、
                总额还是旧门槛的数,副行会先于值改口。 */}
            <div className="kpi-sub">
              {t("单笔 ≥ {amt}", {
                amt: `$${fmtUsd(data?.filters.minUsd ?? minUsd)}`,
              })}
            </div>
          </StatCard>
          {/* 图标位用 📊 —— 买卖双向额的分格,与 /wallet 档案「近窗买入 / 卖出」
              KPI 同一图标、同一语义。不用 ⚖️:它在本站已被「聪明钱分歧」占死
              (glossary.ts、/consensus 与 /pulse 的「方向分歧」KPI、市场信号卡
              「⚖️ 分歧」),一个 emoji 不能背两个含义。 */}
          <StatCard
            label={t("买 / 卖 · 买方占 {pct}%", { pct: buyPct.toFixed(1) })}
            icon="📊"
          >
            <div className="kpi-value" style={{ color: "var(--ww-up)" }}>
              ${fmtUsd(buyUsd)}
            </div>
            <div className="kpi-sub" style={{ color: "var(--ww-down)" }}>
              {t("卖 {amt}", { amt: `$${fmtUsd(sellUsd)}` })}
            </div>
            {/* 比例条 6px / 圆角 99 —— 买绿卖红是真正的方向语义 */}
            <div className="split-bar" style={{ marginTop: "var(--s-2)" }}>
              <span
                style={{
                  flex: `0 0 ${buyPct}%`,
                  background: "var(--ww-up)",
                }}
              />
              <span
                style={{
                  flex: `0 0 ${sellPct}%`,
                  background: "var(--ww-down)",
                }}
              />
            </div>
          </StatCard>
          <StatCard label={t("最大单")} icon="🐳">
            {stats.maxTrade ? (
              <>
                <div className="kpi-value">${fmtUsd(stats.maxTrade.usd)}</div>
                {/* 市场名永不截断 —— 换行，不做省略号 */}
                <div className="kpi-sub" style={{ lineHeight: 1.4 }}>
                  {stats.maxTrade.eventSlug ? (
                    <a
                      href={`https://polymarket.com/event/${stats.maxTrade.eventSlug}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {stats.maxTrade.title}
                    </a>
                  ) : (
                    stats.maxTrade.title
                  )}
                </div>
              </>
            ) : (
              // 「—」是判不了，不是零 —— 走 faint，与真实的 0 严格分家
              <div
                className="kpi-value"
                style={{ color: "var(--ww-text-faint)" }}
              >
                —
              </div>
            )}
          </StatCard>
        </section>
      ) : null}

      {/* 筛选条 —— 摊在页面底上，不装卡：它是主表卡的参数，不是并列的内容块。
          一排 32px 控件，右侧对齐全屏唯一的主按钮。 */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-3)",
          marginBottom: "var(--s-4)",
        }}
      >
        <div className="filter-bar" style={{ marginBottom: 0 }}>
          <span className="filter-row__label">{t("金额")}</span>
          <Segmented<number>
            ariaLabel={t("最低金额")}
            value={minUsd}
            onChange={setMinUsd}
            options={AMOUNT_PRESETS.map((p) => ({
              label: `$${fmtUsd(p)}`,
              value: p,
            }))}
          />
          <input
            type="number"
            min={0}
            placeholder={t("自定义 USD")}
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onBlur={applyCustom}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyCustom();
            }}
            className="ds-input"
            style={{ width: 130 }}
          />
          <span className="ds-hint">
            {t("当前 ≥")} ${fmtUsd(minUsd)}
          </span>

          <span className="filter-bar__right">
            <span className="ds-hint">
              {loading
                ? t("加载中…")
                : lastRefreshed
                  ? t("最后刷新 {time}", { time: lastRefreshed })
                  : ""}
            </span>
            {/* 开关 32×18 胶囊；原生 checkbox 铺在它上面保持键盘与读屏可达 */}
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--s-2)",
                fontSize: "var(--t-base)",
                cursor: "pointer",
              }}
            >
              <span style={{ position: "relative", display: "inline-flex" }}>
                <span
                  className="ds-toggle"
                  data-on={autoRefresh ? "true" : "false"}
                  aria-hidden
                />
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    margin: 0,
                    opacity: 0,
                    cursor: "pointer",
                  }}
                />
              </span>
              {t("自动刷新 30s")}
            </label>
            <button
              className="ds-btn ds-btn--primary"
              onClick={() => {
                // Manual refresh = a fresh user-triggered pull: re-arm the
                // one-shot auto-retry budget before firing.
                rearmAutoRetry();
                load();
              }}
            >
              {t("刷新")}
            </button>
          </span>
        </div>

        <div className="filter-row">
          <span className="filter-row__label">{t("方向")}</span>
          <Segmented<Side>
            ariaLabel={t("方向")}
            value={side}
            onChange={setSide}
            options={[
              { label: t("全部"), value: "ALL" },
              { label: t("买入 BUY"), value: "BUY" },
              { label: t("卖出 SELL"), value: "SELL" },
            ]}
          />
          <span
            className="filter-row__label"
            style={{ marginLeft: "var(--s-3)" }}
          >
            {t("时间")}
          </span>
          <Segmented<Hours>
            ariaLabel={t("时间窗")}
            value={hours}
            onChange={setHours}
            options={([1, 6, 24] as Hours[]).map((h) => ({
              label: `${h}h`,
              value: h,
            }))}
          />
          {/* Price (odds) band — insider money tends to buy at favorable odds. */}
          <span
            className="filter-row__label"
            style={{ marginLeft: "var(--s-3)" }}
          >
            {t("价格")}
          </span>
          <input
            type="number"
            step={0.01}
            min={0}
            max={1}
            placeholder="0"
            value={minPrice}
            onChange={(e) => setMinPrice(e.target.value)}
            className="ds-input"
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
            className="ds-input"
            style={{ width: 70 }}
          />
          {minPrice || maxPrice ? (
            <button
              className="ds-btn ds-btn--sm"
              onClick={() => {
                setMinPrice("");
                setMaxPrice("");
              }}
            >
              {t("清除")}
            </button>
          ) : null}
          <span className="ds-hint">{t("赔率 0–1")}</span>
        </div>

        {/* Market category — from the event's gamma tags, server-enriched. */}
        <div className="filter-row">
          <span className="filter-row__label">{t("类型")}</span>
          <Segmented<string>
            ariaLabel={t("市场类型")}
            className="ds-segmented--wrap"
            value={category ?? "__ALL__"}
            onChange={(v) => setCategory(v === "__ALL__" ? null : v)}
            options={[
              { label: t("全部"), value: "__ALL__" },
              // 筛选比较（catLabel(t.category) !== category）用原中文标签作
              // value；只有展示 label 过字典 —— 逻辑零变化。
              ...categoryOptions.map((c) => ({ label: t(c), value: c })),
            ]}
          />
        </div>

        {/* Address age — insider money tends to use relatively new wallets. */}
        <div className="filter-row">
          <span className="filter-row__label">{t("地址年龄")}</span>
          <Segmented<number>
            ariaLabel={t("地址年龄")}
            value={maxAgeDays ?? AGE_ALL}
            onChange={(v) => setMaxAgeDays(v === AGE_ALL ? null : v)}
            options={[
              { label: t("全部"), value: AGE_ALL },
              { label: t("≤1天"), value: 1 },
              { label: t("≤7天"), value: 7 },
              { label: t("≤30天"), value: 30 },
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
            className="ds-input"
            style={{ width: 56 }}
          />
          <span className="ds-hint">{t("天")}</span>
        </div>
      </div>

      {/* 主表卡 —— 卡内：标题条 → 表头 → 行 → 说明条 */}
      {autoRetrying ? (
        // The pull failed on a cold upstream cache and a one-shot retry is
        // scheduled — show progress instead of an error + empty table.
        <div className="ds-empty">
          <div>{t("上游缓存预热中，自动重试…")}</div>
          <div style={{ marginTop: "var(--s-2)" }}>
            {t(
              "首次深拉会把上游缓存烧热，重试通常就成了；也可以直接点「刷新」。",
            )}
          </div>
        </div>
      ) : view === "loading" ? (
        // First fetch, nothing to show yet — a deep 24h pull can take 5-15s
        // and a blank area reads as "the tool is broken".
        <div className="ds-empty">
          <div>
            {t("正在扫描 {hours}h 成交 — 深度拉取首次约 5-15 秒，请稍候…", {
              hours,
            })}
          </div>
          <div style={{ marginTop: "var(--s-2)" }}>
            {t("嫌慢就把时间窗切到 1h：窗口越短，回看深度越浅。")}
          </div>
        </div>
      ) : view === "empty" ? (
        <div className="ds-empty">
          <div>{t("该筛选条件下 {hours}h 内暂无成交", { hours })}</div>
          <div style={{ marginTop: "var(--s-2)" }}>
            {t(
              "试试降低金额门槛、把时间窗切到 24h，或清掉价格区间 / 类型 / 地址年龄这三项客户端筛选。",
            )}
          </div>
        </div>
      ) : view === "rows" ? (
        <div className="ds-table-wrap">
          {/* 卡内标题条 */}
          <div className="card-bar">
            <span>
              {t("共 {n} 笔符合筛选", { n: fmtUsd(displayedTrades.length) })}
              {hiddenCount > 0 ? (
                <span className="muted">
                  {t("（显示前 {n} 条）", { n: fmtUsd(visibleTrades.length) })}
                </span>
              ) : null}
            </span>
            {agesStillLoading ? (
              <span className="muted">
                {t("地址年龄加载中，结果将随加载补全")}
              </span>
            ) : null}
          </div>
          <table className="ds-table">
            <thead>
              <tr>
                <th
                  className="is-sortable"
                  onClick={() => toggleSort("time")}
                  title={t("点击按时间排序")}
                >
                  {t("时间")}
                  {sortArrow("time")}
                </th>
                <th>{t("市场 / 结果")}</th>
                {/* 有口径的列头把口径写在 title 里（与下方「战绩」同一做法） */}
                <th
                  title={t(
                    "该笔成交的方向：BUY = 买入该结果的份额，SELL = 卖出该结果的份额",
                  )}
                >
                  {t("方向")}
                </th>
                <th
                  className="is-sortable is-right"
                  onClick={() => toggleSort("amount")}
                  title={t("点击按金额排序")}
                >
                  {t("金额")}
                  {sortArrow("amount")}
                </th>
                <th className="is-right">{t("价格")}</th>
                <th>{t("钱包")}</th>
                <th>{t("地址年龄")}</th>
                <th
                  title={t("已结算市场胜率 · 已实现盈亏（🏆 = 聪明钱白名单）")}
                >
                  {t("战绩")}
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
          {hiddenCount > 0 ? (
            <div
              className="note-strip"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--s-3)",
                flexWrap: "wrap",
              }}
            >
              <button
                className="ds-btn ds-btn--sm"
                onClick={() => setShowAllRows(true)}
              >
                {t("显示其余 {n} 行", { n: fmtUsd(hiddenCount) })}
              </button>
              <span>
                {t("统计卡与「符合筛选」计数已包含全部 {n} 笔", {
                  n: fmtUsd(displayedTrades.length),
                })}
              </span>
            </div>
          ) : null}
          {/* 降级态说明 —— 「—」是「判不了」，不是零 */}
          <div className="note-strip note-strip--warn">
            {t(
              "「…」= 地址年龄 / 战绩仍在后台补齐，结果会自己填上；「—」= 判不了，不是零 —— 战绩列的「—」表示该钱包没有可统计的已结算市场，不代表 0 胜率。",
            )}
          </div>
        </div>
      ) : (
        // view === "idle" —— 还没发出第一次请求（URL 参数尚未读入）。
        // 空态绝不返回 null：给内容，也给出路。
        <div className="ds-empty">
          <div>{t("正在准备扫描…")}</div>
          <div style={{ marginTop: "var(--s-2)" }}>
            {t("如果这里一直停着，点筛选条右侧的「刷新」重新发起一次拉取。")}
          </div>
        </div>
      )}
    </main>
  );
}
