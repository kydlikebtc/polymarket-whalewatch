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
  Field,
  Icon,
  Segmented,
  StatCard,
  Tag,
  WalletStatsBadge,
  type SmartInfoLite,
  type WalletStatsLite,
} from "../ui";
import { useWalletIntel } from "../useWalletIntel";
import { useWalletAges } from "../useWalletAges";
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
  eventSlug: string;
  buyUsd: number;
  sellUsd: number;
  netUsd: number;
  buyCount: number;
  sellCount: number;
  maxSingleBuyUsd: number;
  buyShares: number;
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
  totalNetUsd: number;
  topNetUsd: number;
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

// Human window length (minutes/hours) covered between two unix-seconds stamps.
function fmtWindowSpan(oldestSec: number, nowSec: number): string {
  const mins = Math.max(0, Math.round((nowSec - oldestSec) / 60));
  if (mins < 60) return `~${mins} 分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `~${h} 小时` : `~${h} 小时 ${m} 分`;
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
  const whale = g.netUsd >= WHALE_NET;
  return (
    <Fragment>
      <tr
        onClick={() => onToggle(rk)}
        style={{ cursor: "pointer" }}
        title={isOpen ? "点击收起明细" : "点击展开底层买单"}
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
        <td>
          <a
            className="mono"
            href={`/wallet/${g.wallet?.toLowerCase()}`}
            title={`${g.wallet} · 点击查看钱包档案`}
            onClick={(e) => e.stopPropagation()}
          >
            {shortWallet(g.wallet)}
          </a>
        </td>
        <td>
          <AgeBadge ageDays={age} />
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          <WalletStatsBadge stats={stats} smart={smart} />
        </td>
        <td style={{ whiteSpace: "normal", maxWidth: 360 }}>
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
          <div className="kpi-sub">{g.outcome}</div>
        </td>
        <td>
          {g.hedgeSuspect || g.mmSuspect ? (
            <span
              style={{
                display: "flex",
                gap: "var(--s-1)",
                flexWrap: "wrap",
              }}
            >
              {g.hedgeSuspect ? (
                <span
                  title={
                    "同钱包在同市场的对侧结果也有净买入——对冲/套利嫌疑，方向意图存疑。" +
                    (g.hedgeAdjustedNetUsd != null
                      ? `按 1−价格 折算对侧买入后，本方向净买入约 $${fmtUsd(
                          g.hedgeAdjustedNetUsd,
                        )}（仅二元市场折算）。`
                      : "多结果市场仅标记不折算。") +
                    "默认沉底"
                  }
                  style={{ cursor: "help" }}
                >
                  <Tag variant="warn">对冲?</Tag>
                </span>
              ) : null}
              {g.mmSuspect ? (
                <span
                  title={`买卖高频交替（换向率 ${Math.round(
                    g.flipRate * 100,
                  )}%，仅统计 ≥floor 的可见单，实际只高不低）——更像做市库存管理而非定向建仓。默认沉底`}
                  style={{ cursor: "help" }}
                >
                  <Tag variant="warn">做市?</Tag>
                </span>
              ) : null}
            </span>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td
          className="mono is-right"
          style={{ color: "var(--warn-700)", fontWeight: 600 }}
          title="按 size 加权的平均买入价（赔率）"
        >
          {g.avgBuyPrice.toFixed(3)}
        </td>
        <td
          className="mono muted is-right"
          title={`首笔 ${fmtTime(g.firstTs)} → 末笔 ${fmtTime(g.lastTs)}`}
        >
          {fmtTime(g.lastTs)}
        </td>
        <td className="mono is-right">
          <span className="up" style={{ fontWeight: 700 }}>
            <Icon s={whale ? "🐳" : "🧩"} /> ${fmtUsd(g.netUsd)}
          </span>
        </td>
        <td className="mono is-right">{g.buyCount} 买</td>
        <td className="mono is-right">${fmtUsd(g.maxSingleBuyUsd)}</td>
        <td className="mono is-right">${fmtUsd(g.buyUsd)}</td>
        <td
          className={
            g.sellUsd > 0 ? "mono is-right down" : "mono is-right muted"
          }
        >
          ${fmtUsd(g.sellUsd)}
        </td>
      </tr>
      {isOpen ? (
        <tr>
          <td
            colSpan={13}
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
              底层买单（共 {g.buys.length} 笔，最新在前）
            </div>
            <table className="ds-table--compact" style={{ maxWidth: 440 }}>
              <thead>
                <tr>
                  <th>时间</th>
                  <th className="is-right">金额</th>
                  <th className="is-right">价格(赔率)</th>
                </tr>
              </thead>
              <tbody>
                {g.buys.map((b, bi) => (
                  <tr key={`${rk}-buy-${bi}`}>
                    <td className="mono">{fmtTime(b.ts)}</td>
                    <td className="mono is-right">${fmtUsd(b.usd)}</td>
                    <td
                      className="mono is-right"
                      style={{ color: "var(--warn-700)" }}
                    >
                      {b.price.toFixed(3)}
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
});

export default function AccumulationPage() {
  const [hours, setHours] = useState<Hours>(DEFAULTS.hours);
  const [floor, setFloor] = useState<Floor>(DEFAULTS.floor);
  const [minNetUsd, setMinNetUsd] = useState<number>(DEFAULTS.minNetUsd);
  const [data, setData] = useState<AccumResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>("");
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
        stats: { groupCount: 0, totalNetUsd: 0, topNetUsd: 0 },
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
          return g.netUsd;
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

  const view = tableViewState(data != null, data?.groups.length ?? 0, loading);

  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-4)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", marginBottom: "var(--s-1)" }}>
          🧩 拆单 / 累计买入榜
        </h1>
        <div className="ds-hint">
          按 (钱包·市场·结果) 聚合多笔小额买入，揪出绕过单笔监控的累积建仓
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
            options={([1, 2, 4] as Hours[]).map((h) => ({
              label: `${h}h`,
              value: h,
            }))}
          />
        </Field>

        <Field label="精度">
          <Segmented<Floor>
            ariaLabel="精度"
            value={floor}
            onChange={setFloor}
            options={FLOOR_PRESETS.map((f) => ({
              label: <span className="mono">${fmtUsd(f)}</span>,
              value: f,
            }))}
          />
          <span className="ds-hint">
            floor 越低越能抓到小额拆单，但时间窗越短
          </span>
        </Field>

        <Field label="净买入">
          <Segmented<number>
            ariaLabel="净买入"
            value={minNetUsd}
            onChange={setMinNetUsd}
            options={NET_PRESETS.map((p) => ({
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
            当前净买入 ≥ <span className="mono">${fmtUsd(minNetUsd)}</span>
          </span>
          <span style={{ flex: 1 }} />
          <button className="ds-btn ds-btn--ghost" onClick={() => load()}>
            刷新
          </button>
        </Field>

        <div className="ds-hint">
          精度 floor <span className="mono">${fmtUsd(floor)}</span> · 每笔 &lt;
          $10k 才算拆单 · ≥3 笔买入 · 低于 floor 的卖出不可见，净买入为上界
        </div>
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
          <StatCard label="累积者数">
            <div className="kpi-value">{stats.groupCount}</div>
          </StatCard>
          <StatCard label="合计净买入">
            <div className="kpi-value">${fmtUsd(stats.totalNetUsd)}</div>
          </StatCard>
          <StatCard label="最大净买入">
            <div className="kpi-value">${fmtUsd(stats.topNetUsd)}</div>
          </StatCard>
        </section>
      ) : null}

      {data && (data.truncated || data.oldestTs) ? (
        <div
          className={
            data.truncated ? "ds-callout ds-callout--warn" : "ds-callout"
          }
          style={{
            marginBottom: "var(--s-4)",
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--s-3)",
            alignItems: "center",
          }}
        >
          {data.truncated ? (
            <span>⏱️ 成交太密集，API 回看深度已用满 — 以下为完整覆盖时段</span>
          ) : null}
          {data.oldestTs ? (
            <span>
              实际覆盖{" "}
              {fmtWindowSpan(data.oldestTs, Math.floor(Date.now() / 1000))}
              （自 {fmtTime(data.oldestTs)} 起）
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Table */}
      {view === "loading" ? (
        // First fetch, nothing to show yet — the deep double-sided window pull
        // can take 5-15s and a blank area reads as "the tool is broken".
        <div className="ds-empty">
          ⏳ 正在聚合 {hours}h 内的拆单买入 — 深度拉取首次约 5-15 秒，请稍候…
        </div>
      ) : view === "empty" ? (
        <div className="ds-empty">该条件下暂无拆单累计</div>
      ) : view === "rows" ? (
        <>
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead>
                <tr>
                  <th style={{ width: 28, padding: "var(--s-2) var(--s-1)" }} />
                  <th>钱包</th>
                  <th>地址年龄</th>
                  <th title="已结算市场胜率 · 已实现盈亏（🏆 = 聪明钱白名单）">
                    战绩
                  </th>
                  <th>市场 · 结果</th>
                  <th title="对冲嫌疑 = 同钱包也净买入了同市场的对侧结果；做市嫌疑 = 买卖高频交替。两类默认沉底">
                    标记
                  </th>
                  <th className="is-right">平均赔率</th>
                  <th className="is-right">时间</th>
                  <th
                    className="is-sortable is-right"
                    onClick={() => toggleSort("net")}
                    title="点击按净买入排序"
                  >
                    净买入{sortArrow("net")}
                  </th>
                  <th
                    className="is-sortable is-right"
                    onClick={() => toggleSort("buyCount")}
                    title="点击按笔数排序"
                  >
                    笔数{sortArrow("buyCount")}
                  </th>
                  <th
                    className="is-sortable is-right"
                    onClick={() => toggleSort("maxSingle")}
                    title="点击按单笔最大排序"
                  >
                    单笔最大{sortArrow("maxSingle")}
                  </th>
                  <th
                    className="is-sortable is-right"
                    onClick={() => toggleSort("buyUsd")}
                    title="点击按毛买入排序"
                  >
                    毛买入{sortArrow("buyUsd")}
                  </th>
                  <th
                    className="is-right"
                    title="仅统计 ≥ 精度 floor 的卖出——更小的卖单在此精度下不可见，净买入应视为上界"
                  >
                    毛卖出(≥floor)
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
            <div style={{ textAlign: "center", marginTop: "var(--s-3)" }}>
              <button
                className="ds-btn ds-btn--ghost"
                onClick={() => setShowAllRows(true)}
              >
                显示其余 {hiddenCount} 行
              </button>
              <div className="ds-hint" style={{ marginTop: "var(--s-1)" }}>
                统计卡已包含全部 {sortedGroups.length} 组
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
