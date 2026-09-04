"use client";

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AgeBadge,
  HoldingCell,
  Icon,
  MarketSlugActions,
  Segmented,
  SoundToggle,
  StatCard,
  Tag,
  WalletLink,
  WalletStatsBadge,
  type SmartInfoLite,
  type WalletStatsLite,
} from "../ui";
import { useLang } from "../i18n";
import { useMarketPositions } from "../useMarketPositions";
import { useSoundToggle } from "../useSound";
import { useNewRecordChime } from "../useNewRecordChime";
import { useWalletIntel } from "../useWalletIntel";
import { useWalletAges } from "../useWalletAges";
import { useAutoRetryOnError } from "../autoRetry";
import { capRows, tableViewState } from "../tableView";
import {
  buildQueryString,
  parseChoiceParam,
  parseNumParam,
  replaceUrlQuery,
} from "../urlQuery";

type AccumBuy = {
  ts: number;
  usd: number;
  price: number;
};

type AccumGroup = {
  wallet: string;
  conditionId: string;
  outcome: string;
  outcomeIndex: number;
  title: string;
  slug: string;
  eventSlug: string;
  buyUsd: number;
  sellUsd: number;
  // Window cashflow (buyUsd − sellUsd) — display context only.
  netUsd: number;
  buyCount: number;
  sellCount: number;
  maxSingleBuyUsd: number;
  buyShares: number;
  sellShares: number;
  // Cost-basis exposure (P0.6): netShares × avgBuyPrice — the measure the
  // server's floor and default ranking use, and the row's primary figure.
  netShares: number;
  exposureUsd: number;
  avgBuyPrice: number;
  firstTs: number;
  lastTs: number;
  buys: AccumBuy[];
  // Suspicion tags computed server-side (lib/accumulate): suspects sink to
  // the bottom of every sort so clean directional accumulation ranks first.
  hedgeSuspect: boolean;
  hedgeAdjustedNetUsd: number | null;
  flipRate: number;
  mmSuspect: boolean;
};

type AccumStats = {
  groupCount: number;
  totalExposureUsd: number;
  topExposureUsd: number;
};

type AccumResponse = {
  filters: { floor: number; hours: number; minNetUsd: number };
  stats: AccumStats;
  truncated: boolean;
  oldestTs: number | null;
  groups: AccumGroup[];
  error?: string;
};

type Hours = 1 | 2 | 4;
type Floor = 500 | 1000 | 2000;
type SortKey = "net" | "buyCount" | "maxSingle" | "buyUsd";
type SortDir = "asc" | "desc";

const NET_PRESETS = [10000, 25000, 50000];
const FLOOR_PRESETS: Floor[] = [500, 1000, 2000];
const WHALE_NET = 50000;

const HOURS_CHOICES = [1, 2, 4] as const;
const FLOOR_CHOICES = [500, 1000, 2000] as const;
const SORT_KEYS = ["net", "buyCount", "maxSingle", "buyUsd"] as const;
const SORT_DIRS = ["asc", "desc"] as const;
// Page defaults — doubling as the "omit from URL" baseline so the default
// view serializes to a bare pathname.
const DEFAULTS = {
  hours: 4 as Hours,
  floor: 2000 as Floor,
  minNetUsd: 10000,
  sortKey: "net" as SortKey,
  sortDir: "desc" as SortDir,
};

// HH:MM:SS from a unix-seconds timestamp (local time, 24h).
function fmtTime(tsSec: number): string {
  return new Date(tsSec * 1000).toLocaleTimeString("zh-CN", { hour12: false });
}

// Translator signature (useLang().t) — passed into the helpers below so
// module-level formatters stay outside the component without losing i18n.
type TFn = (zh: string, params?: Record<string, string | number>) => string;

// Human window length (minutes/hours) covered between two unix-seconds stamps.
function fmtWindowSpan(oldestSec: number, nowSec: number, t: TFn): string {
  const mins = Math.max(0, Math.round((nowSec - oldestSec) / 60));
  if (mins < 60) return t("~{m} 分钟", { m: mins });
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? t("~{h} 小时", { h }) : t("~{h} 小时 {m} 分", { h, m });
}

function fmtUsd(usd: number): string {
  return usd.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function shortWallet(w: string): string {
  if (!w) return "";
  return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

function rowKey(g: AccumGroup): string {
  return `${g.wallet}:${g.conditionId}:${g.outcome}`;
}

/* --------------------------------------------------------------- Detail */

// Expanded group detail. Mounts only when the row is open, so it lazily
// fetches the wallet's CURRENT position in this market ("stock") to sit above
// the window's underlying buys ("flow") — telling a fresh entry that's still
// held from one that was already flipped. Other-outcome holdings in the same
// market are listed too: they let the 对冲? suspicion be eyeballed directly.
function AccumDetail({ g }: { g: AccumGroup }) {
  const { t } = useLang();
  const { positions, loading } = useMarketPositions(
    g.conditionId,
    [g.wallet],
    true,
  );
  const walletPos = positions?.[g.wallet.toLowerCase()];
  const pos = walletPos?.[g.outcome.toLowerCase()];
  const others = walletPos
    ? Object.values(walletPos).filter(
        (p) => p.outcome.toLowerCase() !== g.outcome.toLowerCase(),
      )
    : [];
  return (
    <>
      <div className="ds-hint" style={{ margin: "var(--s-2) 0 var(--s-1)" }}>
        {t("当前持仓（{outcome}）：", { outcome: g.outcome })}
        <HoldingCell pos={pos} loading={loading} />
        {others.length > 0 ? (
          <span className="muted">
            {t(" · 同市场其他结果：")}
            {others.map((p, i) => (
              <span key={p.outcome} className="mono">
                {i > 0 ? t("、") : ""}
                {p.outcome} $
                {Math.round(p.currentValue).toLocaleString("en-US")}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <div className="ds-hint" style={{ margin: "var(--s-2) 0 var(--s-1)" }}>
        {t("底层买单（共 {n} 笔，最新在前）", { n: g.buys.length })}
      </div>
      <table className="ds-table--compact" style={{ maxWidth: 440 }}>
        <thead>
          <tr>
            <th>{t("时间")}</th>
            <th className="is-right">{t("金额")}</th>
            <th className="is-right">{t("价格(赔率)")}</th>
          </tr>
        </thead>
        <tbody>
          {g.buys.map((b, bi) => (
            <tr key={`buy-${bi}`}>
              <td className="mono" data-label={t("时间")}>
                {fmtTime(b.ts)}
              </td>
              <td className="mono is-right" data-label={t("金额")}>
                ${fmtUsd(b.usd)}
              </td>
              {/* 赔率是价格不是警示 —— 中性色（设计稿 §2.1：琥珀只留给
                  「需留神的口径」，成本/价格类数字一律中性）。 */}
              <td className="mono is-right" data-label={t("价格(赔率)")}>
                {b.price.toFixed(3)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/* ------------------------------------------------------------------ Row */

// One group row (plus its expandable buy-detail row), memoized so the lazy
// age/stats batches only re-render the rows whose wallet data arrived, and an
// expand toggle only re-renders the toggled row instead of the whole table.
type AccumRowProps = {
  g: AccumGroup;
  rk: string;
  isOpen: boolean;
  onToggle: (key: string) => void;
  age: number | null | undefined;
  stats: WalletStatsLite | null | undefined;
  smart: SmartInfoLite | null | undefined;
};

const AccumRow = memo(function AccumRow({
  g,
  rk,
  isOpen,
  onToggle,
  age,
  stats,
  smart,
}: AccumRowProps) {
  const { t } = useLang();
  const whale = g.exposureUsd >= WHALE_NET;
  return (
    <Fragment>
      <tr
        onClick={() => onToggle(rk)}
        style={{ cursor: "pointer" }}
        title={isOpen ? t("点击收起明细") : t("点击展开底层买单")}
      >
        <td
          className="muted col-expand"
          style={{
            padding: "var(--s-3) var(--s-1)",
            textAlign: "center",
            userSelect: "none",
          }}
        >
          {isOpen ? "▾" : "▸"}
        </td>
        {/* 钱包 · 地址年龄同格：地址首尾省略后本来就短，年龄是它的属性
            （这个钱包多新），两者读起来是一件事。合并省下一列的左右内边距，
            宽度还给市场列 —— 见表头注释里的列宽预算。 */}
        <td>
          <WalletLink
            address={g.wallet ?? ""}
            title={t("{address} · 新标签打开钱包档案", { address: g.wallet })}
          >
            {shortWallet(g.wallet)}
          </WalletLink>
          <span style={{ marginLeft: "var(--s-2)" }}>
            <AgeBadge ageDays={age} />
          </span>
        </td>
        <td data-label={t("战绩")} onClick={(e) => e.stopPropagation()}>
          <WalletStatsBadge stats={stats} smart={smart} />
        </td>
        {/* 市场名永不截断（设计稿 §1.1）：换行、顶对齐、overflow-wrap
            anywhere —— 全站只有钱包地址与哈希做首尾省略。 */}
        <td
          className="cell-wrap"
          data-label={t("市场 · 结果")}
          style={{ maxWidth: 360 }}
        >
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
          {/* 结果名 = 灰底名称标签（Etherscan name tag，不表示状态）；
              🐳 巨鲸单只在 ≥$50k 时出现，emoji 收在标签里而不是压在金额上。
              ⧉ copies the MARKET slug, ↗ opens the wired.fund trade page —
              same affordance as the 24h scanner. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "var(--s-2)",
              marginTop: 4,
              fontSize: "var(--t-sm)",
              color: "var(--ww-text-muted)",
            }}
          >
            <Tag>{g.outcome}</Tag>
            {whale ? (
              <Tag>
                <Icon s="🐳" />
                {t("巨鲸单")}
              </Tag>
            ) : null}
            {/* 对冲 / 做市标记从独立的「标记」列挪到这里：它们是对这一笔
                建仓的限定语（"这个方向可能不作数"），本来就该紧挨着市场·结果
                读，独占一列既占宽度又离被限定的对象很远。琥珀 = 需留神的
                口径，与徽章五类语义一致。 */}
            {g.hedgeSuspect ? (
              <span
                title={
                  t(
                    "同钱包在同市场的对侧结果也有净买入——对冲/套利嫌疑，方向意图存疑。",
                  ) +
                  (g.hedgeAdjustedNetUsd != null
                    ? t(
                        "按 1−价格 折算对侧买入后，本方向净买入约 ${n}（仅二元市场折算）。",
                        { n: fmtUsd(g.hedgeAdjustedNetUsd) },
                      )
                    : t("多结果市场仅标记不折算。")) +
                  t("默认沉底")
                }
                style={{ cursor: "help" }}
              >
                <Tag variant="warn">{t("对冲?")}</Tag>
              </span>
            ) : null}
            {g.mmSuspect ? (
              <span
                title={t(
                  "买卖高频交替（换向率 {pct}%，仅统计 ≥floor 的可见单，实际只高不低）——更像做市库存管理而非定向建仓。默认沉底",
                  { pct: Math.round(g.flipRate * 100) },
                )}
                style={{ cursor: "help" }}
              >
                <Tag variant="warn">{t("做市?")}</Tag>
              </span>
            ) : null}
            <span style={{ whiteSpace: "nowrap" }}>
              <MarketSlugActions
                slug={g.slug}
                eventSlug={g.eventSlug}
                conditionId={g.conditionId}
              />
            </span>
          </div>
        </td>
        {/* 赔率 = 价格，不是警示：中性色、常规字重、与正文同字号。 */}
        <td
          className="mono is-right"
          data-label={t("赔率")}
          title={t("按 size 加权的平均买入价（赔率）")}
        >
          {g.avgBuyPrice.toFixed(3)}
        </td>
        <td
          className="mono muted is-right"
          data-label={t("时间")}
          title={t("首笔 {first} → 末笔 {last}", {
            first: fmtTime(g.firstTs),
            last: fmtTime(g.lastTs),
          })}
        >
          {fmtTime(g.lastTs)}
        </td>
        <td
          className="mono is-right"
          data-label={t("净买入")}
          title={t(
            "成本敞口 = 留存净股数 × 买入均价（{shares} 股 × {price}¢）· 窗口现金流 ${cashflow}",
            {
              shares: fmtUsd(g.netShares),
              price: (g.avgBuyPrice * 100).toFixed(1),
              cashflow: fmtUsd(g.netUsd),
            },
          )}
        >
          {/* 金额与正文同字体同字号常规字重，不染色、不放 emoji ——
              轻重由榜的排序与标签承担，行本身没有行级强调。 */}
          ${fmtUsd(g.exposureUsd)}
        </td>
        <td className="mono is-right" data-label={t("笔数")}>
          {t("{n} 买", { n: g.buyCount })}
        </td>
        <td className="mono is-right" data-label={t("单笔最大")}>
          ${fmtUsd(g.maxSingleBuyUsd)}
        </td>
        <td className="mono is-right" data-label={t("毛买入")}>
          ${fmtUsd(g.buyUsd)}
        </td>
        {/* 毛卖出是量级不是方向：红只留给真正的卖出方向徽章，
            这里为 0 时压成 muted，>0 时与其它金额同色。 */}
        <td
          className={g.sellUsd > 0 ? "mono is-right" : "mono is-right muted"}
          data-label={t("毛卖出")}
        >
          ${fmtUsd(g.sellUsd)}
        </td>
      </tr>
      {isOpen ? (
        <tr>
          <td
            colSpan={11}
            style={{
              padding: "0 var(--s-4) var(--s-4) var(--s-10)",
              borderBottom: "1px solid var(--ww-border)",
              background: "var(--ww-surface-muted)",
            }}
          >
            <AccumDetail g={g} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
});

export default function AccumulationPage() {
  const { t } = useLang();
  const [hours, setHours] = useState<Hours>(DEFAULTS.hours);
  const [floor, setFloor] = useState<Floor>(DEFAULTS.floor);
  const [minNetUsd, setMinNetUsd] = useState<number>(DEFAULTS.minNetUsd);
  const [data, setData] = useState<AccumResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
  // Local text state for the custom net input so typing intermediate values
  // doesn't immediately refetch with garbage.
  const [customText, setCustomText] = useState<string>("");
  // Sorting is purely client-side over the already-fetched rows.
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULTS.sortKey);
  const [sortDir, setSortDir] = useState<SortDir>(DEFAULTS.sortDir);
  // Expanded detail rows, keyed by `wallet:conditionId:outcome`. Collapsed by default.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Flips true once the URL params have been read into state — the first fetch
  // and the URL write-back both wait for it.
  const [urlReady, setUrlReady] = useState<boolean>(false);
  // Render cap escape hatch ("显示其余 N 行"). Sticky once expanded.
  const [showAllRows, setShowAllRows] = useState<boolean>(false);

  const activeReq = useRef<number>(0);

  // Hydrate filters from the URL once on mount (client-only, so SSR markup and
  // the first client render agree — no hydration mismatch). Absent or invalid
  // params keep the defaults; the write-back effect below then canonicalizes
  // the address bar.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const qHours = parseChoiceParam(p.get("hours"), HOURS_CHOICES);
    if (qHours != null) setHours(qHours);
    const qFloor = parseChoiceParam(p.get("floor"), FLOOR_CHOICES);
    if (qFloor != null) setFloor(qFloor);
    const qMinNet = parseNumParam(p.get("minNetUsd"), { min: 1, int: true });
    if (qMinNet != null) setMinNetUsd(qMinNet);
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
        ["hours", hours !== DEFAULTS.hours ? String(hours) : null],
        ["floor", floor !== DEFAULTS.floor ? String(floor) : null],
        [
          "minNetUsd",
          minNetUsd !== DEFAULTS.minNetUsd ? String(minNetUsd) : null,
        ],
        ["sort", sortKey !== DEFAULTS.sortKey ? sortKey : null],
        ["dir", sortDir !== DEFAULTS.sortDir ? sortDir : null],
      ]),
    );
  }, [urlReady, hours, floor, minNetUsd, sortKey, sortDir]);

  const load = useCallback(async () => {
    const reqId = ++activeReq.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        hours: String(hours),
        floor: String(floor),
        minNetUsd: String(minNetUsd),
      });
      const res = await fetch(`/api/accumulation?${qs.toString()}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as AccumResponse;
      // Ignore stale responses from superseded filter changes.
      if (reqId !== activeReq.current) return;
      setData(json);
      setLastRefreshed(
        new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      );
    } catch (e) {
      if (reqId !== activeReq.current) return;
      setData({
        filters: { floor, hours, minNetUsd },
        stats: { groupCount: 0, totalExposureUsd: 0, topExposureUsd: 0 },
        truncated: false,
        oldestTs: null,
        groups: [],
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (reqId === activeReq.current) setLoading(false);
    }
  }, [hours, floor, minNetUsd]);

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

  // New-record chime: ring when a same-filter refresh surfaces a new
  // (wallet·market·outcome) accumulation group (a filter change reseeds silently).
  const { soundOn, toggle } = useSoundToggle();
  useNewRecordChime(
    data
      ? `${data.filters.floor}|${data.filters.hours}|${data.filters.minNetUsd}`
      : null,
    (data?.groups ?? []).map(rowKey),
    soundOn,
  );

  // One-shot auto retry: a cold upstream cache 408s the deep pull (first load
  // AND filter switches — a new floor:hours baseKey is a new cold query); our
  // failed attempts warm it, so a single delayed retry usually succeeds.
  const { retrying: autoRetrying, rearm: rearmAutoRetry } = useAutoRetryOnError(
    data,
    data?.groups.length ?? 0,
    load,
  );

  // wallet(lowercased) -> ageDays|null. Filled lazily after the table renders;
  // permanently cached server-side so repeat lookups are instant.
  const ages = useWalletAges((data?.groups ?? []).map((g) => g.wallet));

  function applyCustom() {
    const n = Number(customText);
    if (Number.isFinite(n) && n > 0) {
      setMinNetUsd(Math.floor(n));
      setCustomText("");
    }
  }

  const sortedGroups = useMemo(() => {
    const arr = data?.groups ? [...data.groups] : [];
    const pick = (g: AccumGroup): number => {
      switch (sortKey) {
        case "net":
          return g.exposureUsd;
        case "buyCount":
          return g.buyCount;
        case "maxSingle":
          return g.maxSingleBuyUsd;
        case "buyUsd":
          return g.buyUsd;
      }
    };
    arr.sort((a, b) => {
      // Hedge/market-making suspects sink to the bottom regardless of the
      // active sort — they are noise for the "directional accumulation" lens
      // and must never outrank clean groups (still sorted among themselves).
      const sa = a.hedgeSuspect || a.mmSuspect ? 1 : 0;
      const sb = b.hedgeSuspect || b.mmSuspect ? 1 : 0;
      if (sa !== sb) return sa - sb;
      const av = pick(a);
      const bv = pick(b);
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [data, sortKey, sortDir]);

  // Settled-market track record + smart-wallet flags for the ranked wallets.
  const { stats: walletStats, smart } = useWalletIntel(
    sortedGroups.map((g) => g.wallet),
  );

  // Cap the DOM rows — sorting/stat cards above keep operating on the FULL
  // sortedGroups set; only the rendered row count truncates.
  const { visible: visibleGroups, hiddenCount } = capRows(
    sortedGroups,
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

  // Stable identity so the memoized rows don't all re-render on every toggle.
  const toggleExpand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const stats = data?.stats;

  // KPI「最大净买入」副行用的那一组 —— 一个没有主语的金额没法用，设计稿在
  // 这格底下写的是它落在哪个市场的哪个结果。纯展示派生：扫的是完整的
  // data.groups（不受渲染上限与当前排序影响），不参与排序 / 筛选 / 请求。
  const topGroup = (data?.groups ?? []).reduce<AccumGroup | null>(
    (best, g) => (best == null || g.exposureUsd > best.exposureUsd ? g : best),
    null,
  );

  const view = tableViewState(data != null, data?.groups.length ?? 0, loading);

  return (
    <main className="ds-main">
      {/* 页头 —— 12px 小标（emoji 前缀承担语义）+ 24/600 标题 +
          14px muted 描述（≤700px）+ 右侧动作钮 + 1px 底边。 */}
      <header className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="page-head__eyebrow">{t("🧩 绕过单笔监控的建仓")}</div>
          <h1 className="page-head__title">{t("拆单累计")}</h1>
          <p className="page-head__desc">
            {t(
              "同一钱包在同一市场的多笔小额买入合并成一条 —— 单笔监控看不到的建仓方式。",
            )}
          </p>
        </div>
        <div className="page-head__actions">
          <SoundToggle on={soundOn} onToggle={toggle} />
        </div>
      </header>

      {/* 口径条 —— 统计声明放在数据「前面」，不放脚注（设计稿 §5.3）。
          「净买入为上界」是读数前必须先知道的事，不是表尾小字。 */}
      <div
        className="ds-callout ds-callout--warn"
        style={{ marginBottom: "var(--s-4)" }}
      >
        {t("精度 floor")} ${fmtUsd(floor)}
        {t(
          " · 每笔 < $10k 才算拆单 · ≥3 笔买入 · 低于 floor 的卖出不可见，净买入为上界",
        )}
      </div>

      {/* 覆盖被截断同样是「需留神的口径」，跟在口径条后、数据之前。 */}
      {data?.truncated ? (
        <div
          className="ds-callout ds-callout--warn"
          style={{ marginBottom: "var(--s-4)" }}
        >
          {t("成交太密集，API 回看深度已用满 — 以下为完整覆盖时段")}
          {data.oldestTs ? (
            <>
              {" · "}
              {t("实际覆盖 {span}（自 {time} 起）", {
                span: fmtWindowSpan(
                  data.oldestTs,
                  Math.floor(Date.now() / 1000),
                  t,
                ),
                time: fmtTime(data.oldestTs),
              })}
            </>
          ) : null}
        </div>
      ) : null}

      {/* While the one-shot auto retry is pending, the transient error is
          being handled — show the warm-up notice (below) instead of a scary
          callout. A retry that fails again falls through to this callout. */}
      {data?.error && !autoRetrying ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-4)" }}
        >
          {t("扫描失败: {err}", { err: data.error })}
        </div>
      ) : null}

      {/* KPI 分格卡 —— 一张白卡四等分，格间 1px 竖线；icon 是 20px emoji
          图标位。值 18px 常规字重，与正文同字体，不加粗不放大。 */}
      {stats ? (
        <section className="kpi" style={{ marginBottom: "var(--s-4)" }}>
          <StatCard label={t("累积者数")} icon="🧩">
            <div className="kpi-value">
              {t("{n} 个钱包", { n: stats.groupCount })}
            </div>
            <div className="kpi-sub">{t("当前 {h}H 窗口", { h: hours })}</div>
          </StatCard>
          <StatCard label={t("合计净买入")} icon="💰">
            <div className="kpi-value" style={{ color: "var(--ww-link)" }}>
              ${fmtUsd(stats.totalExposureUsd)}
            </div>
          </StatCard>
          <StatCard label={t("最大净买入")} icon="🐳">
            <div className="kpi-value">${fmtUsd(stats.topExposureUsd)}</div>
            {/* 市场名不截断：这里换行，不做省略号（全站只有地址与哈希做
                首尾省略）。结果名跟在「·」后面，与表内同一读法。 */}
            {topGroup ? (
              <div className="kpi-sub" style={{ overflowWrap: "anywhere" }}>
                {topGroup.title} · {topGroup.outcome}
              </div>
            ) : null}
          </StatCard>
          <StatCard label={t("统计口径")} icon="📐">
            <div className="kpi-value">
              {t("{h}H · floor ${f}", { h: hours, f: fmtUsd(floor) })}
            </div>
            <div className="kpi-sub">
              {t("≥3 笔 · 每笔 <$10k")}
              {data?.oldestTs
                ? t(" · 覆盖自 {time}", { time: fmtTime(data.oldestTs) })
                : ""}
            </div>
          </StatCard>
        </section>
      ) : null}

      {/* 筛选条 —— 一排 32px 控件躺在页面底上，不套卡：它是主表卡的参数，
          加一层框会把它和主表并列成「两块内容」（设计稿 §5.5）。
          三组都是互斥单选，用 Segmented；右侧对齐唯一的主按钮。 */}
      <div className="filter-bar">
        <div className="filter-row">
          <span className="filter-row__label">{t("时间窗")}</span>
          <Segmented<Hours>
            ariaLabel={t("时间窗")}
            value={hours}
            onChange={setHours}
            options={([1, 2, 4] as Hours[]).map((h) => ({
              label: `${h}H`,
              value: h,
            }))}
          />
        </div>

        <div className="filter-row">
          <span className="filter-row__label">{t("精度")}</span>
          <Segmented<Floor>
            ariaLabel={t("精度")}
            value={floor}
            onChange={setFloor}
            options={FLOOR_PRESETS.map((f) => ({
              label: `$${fmtUsd(f)}`,
              value: f,
            }))}
          />
        </div>

        <div className="filter-row">
          <span className="filter-row__label">{t("净买入")}</span>
          <Segmented<number>
            ariaLabel={t("净买入")}
            value={minNetUsd}
            onChange={setMinNetUsd}
            options={NET_PRESETS.map((p) => ({
              label: `$${fmtUsd(p)}`,
              value: p,
            }))}
          />
          {/* 字号由 .ds-input 定死在 15px（readme §3 字阶：正文 / 导航 /
              输入同一档），这里只给宽度 —— 与 24h 扫描页的同一个输入框
              逐字一致（app/page.tsx:657）。 */}
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
            className="ds-input ds-input--mono"
            style={{ width: 130 }}
          />
          {/* 自定义值不落在任何一个预设段上时，当前门槛只有这里说得清。 */}
          <span className="ds-hint">
            {t("当前净买入 ≥")} ${fmtUsd(minNetUsd)}
          </span>
        </div>

        <div className="filter-bar__right">
          <span className="ds-hint">
            {loading
              ? t("加载中…")
              : lastRefreshed
                ? t("最后刷新 {time}", { time: lastRefreshed })
                : ""}
          </span>
          {/* 开关 32×18 胶囊；原生 checkbox 铺在它上面保持键盘与读屏可达
              （与 24h 扫描页同一写法，两页的筛选条右侧要长得一样）。 */}
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
          {/* 每屏至多一个主按钮 —— 这一屏的主按钮就是它。 */}
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
        </div>
      </div>

      {/* 主表卡 —— 卡内：标题条 → 表头 → 行 → 灰色说明条。 */}
      {autoRetrying ? (
        // The pull failed on a cold upstream cache and a one-shot retry is
        // scheduled — show progress instead of an error + empty table.
        <div className="ds-empty">{t("上游缓存预热中，自动重试…")}</div>
      ) : view === "loading" ? (
        // First fetch, nothing to show yet — the deep double-sided window pull
        // can take 5-15s and a blank area reads as "the tool is broken".
        <div className="ds-empty">
          {t(
            "正在聚合 {hours}h 内的拆单买入 — 深度拉取首次约 5-15 秒，请稍候…",
            {
              hours,
            },
          )}
        </div>
      ) : view === "empty" ? (
        // 空态给内容也给出路 —— 空的表格框比一句话更糟。
        <div className="ds-empty">
          <div>{t("该条件下暂无拆单累计")}</div>
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            {t("放宽净买入门槛、降低精度 floor 或拉长时间窗，再看一次。")}
          </div>
        </div>
      ) : view === "rows" ? (
        <div className="ds-card" style={{ overflow: "hidden" }}>
          <div className="card-bar">
            <span style={{ fontWeight: 600 }}>{t("拆单累计榜")}</span>
            <span className="muted">
              {t("· 共 {n} 组", { n: sortedGroups.length })}
            </span>
          </div>
          {/* 表已在卡内，wrap 只留横向滚动，边框/圆角/阴影交给外层卡。 */}
          <div
            className="ds-table-wrap"
            style={{
              border: 0,
              borderRadius: 0,
              boxShadow: "none",
              background: "transparent",
            }}
          >
            <table className="ds-table">
              <thead>
                <tr>
                  <th style={{ width: 28, padding: "var(--s-2) var(--s-1)" }} />
                  {/* 地址年龄并进钱包列、标记并进市场格的 meta 行(设计稿帧 02
                      的处理)。这是列宽预算逼出来的,不是省事:设计系统的硬规则
                      是「固定列之和 + 市场列最小宽 + gap×(n−1) + 32 ≤ 1076」,
                      13 列时实测表宽 1147 > 容器 1078,不但冒出横向滚动条,
                      「市场 · 结果」还只分到 111px —— 市场名被压成七八行,而
                      市场名恰恰是本表唯一永不截断的文本。两处合并各省一列的
                      左右内边距,把宽度还给市场列;没有删任何数据、没有动
                      任何排序键。 */}
                  <th>{t("钱包 · 地址年龄")}</th>
                  <th
                    title={t(
                      "已结算市场胜率 · 已实现盈亏（🏆 = 聪明钱白名单）",
                    )}
                  >
                    {t("战绩")}
                  </th>
                  <th
                    title={t(
                      "结果名与标记跟在市场名下方：对冲嫌疑 = 同钱包也净买入了同市场的对侧结果；做市嫌疑 = 买卖高频交替。两类默认沉底",
                    )}
                  >
                    {t("市场 · 结果")}
                  </th>
                  <th
                    className="is-right"
                    title={t("按 size 加权的平均买入价（赔率）")}
                  >
                    {t("赔率")}
                  </th>
                  <th className="is-right">{t("时间")}</th>
                  <th
                    className="is-sortable is-right"
                    onClick={() => toggleSort("net")}
                    title={t("点击按净买入排序")}
                  >
                    {t("净买入")}
                    {sortArrow("net")}
                  </th>
                  <th
                    className="is-sortable is-right"
                    onClick={() => toggleSort("buyCount")}
                    title={t("点击按笔数排序")}
                  >
                    {t("笔数")}
                    {sortArrow("buyCount")}
                  </th>
                  <th
                    className="is-sortable is-right"
                    onClick={() => toggleSort("maxSingle")}
                    title={t("点击按单笔最大排序")}
                  >
                    {t("单笔最大")}
                    {sortArrow("maxSingle")}
                  </th>
                  <th
                    className="is-sortable is-right"
                    onClick={() => toggleSort("buyUsd")}
                    title={t("点击按毛买入排序")}
                  >
                    {t("毛买入")}
                    {sortArrow("buyUsd")}
                  </th>
                  {/* 口径收进 (?) 的 title：表头永远 nowrap，长口径写进列名
                      会把这一列钉宽到 122px（实测），那份宽度该给市场列。 */}
                  <th
                    className="is-right"
                    title={t(
                      "仅统计 ≥ 精度 floor 的卖出——更小的卖单在此精度下不可见，净买入应视为上界",
                    )}
                  >
                    {t("毛卖出")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleGroups.map((g, i) => {
                  const rk = rowKey(g);
                  return (
                    <AccumRow
                      key={`${rk}-${i}`}
                      g={g}
                      rk={rk}
                      isOpen={expanded.has(rk)}
                      onToggle={toggleExpand}
                      age={ages[g.wallet?.toLowerCase()]}
                      stats={walletStats[g.wallet?.toLowerCase()]}
                      smart={smart[g.wallet?.toLowerCase()]}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
          {hiddenCount > 0 ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--s-3)",
                flexWrap: "wrap",
                padding: "var(--s-3) var(--s-4)",
                borderTop: "1px solid var(--ww-border)",
              }}
            >
              <button
                className="ds-btn ds-btn--sm"
                onClick={() => setShowAllRows(true)}
              >
                {t("显示其余 {n} 行", { n: hiddenCount })}
              </button>
              <span className="ds-hint">
                {t("统计卡已包含全部 {n} 组", { n: sortedGroups.length })}
              </span>
            </div>
          ) : null}
          {/* 卡底说明条 —— 灰 = 口径说明（琥珀留给读前必看的那条）。 */}
          <div className="note-strip">
            {t("floor 越低越能抓到小额拆单，但时间窗越短")}
            {" · "}
            {t(
              "净买入取成本敞口口径（留存净股数 × 买入均价）；带「对冲?」「做市?」标记的组默认沉底，不与干净的定向建仓争排名。",
            )}
          </div>
        </div>
      ) : null}
    </main>
  );
}
