"use client";

import {
  Fragment,
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
} from "../ui";
import { useWalletIntel } from "../useWalletIntel";

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

const NET_PRESETS = [10000, 25000, 50000];
const FLOOR_PRESETS: Floor[] = [500, 1000, 2000];
const WHALE_NET = 50000;

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

export default function AccumulationPage() {
  const [hours, setHours] = useState<Hours>(4);
  const [floor, setFloor] = useState<Floor>(2000);
  const [minNetUsd, setMinNetUsd] = useState<number>(10000);
  const [data, setData] = useState<AccumResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>("");
  // Local text state for the custom net input so typing intermediate values
  // doesn't immediately refetch with garbage.
  const [customText, setCustomText] = useState<string>("");
  // Sorting is purely client-side over the already-fetched rows.
  const [sortKey, setSortKey] = useState<SortKey>("net");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // wallet(lowercased) -> ageDays|null. Filled lazily after the table renders;
  // permanently cached server-side so repeat lookups are instant.
  const [ages, setAges] = useState<Record<string, number | null>>({});
  // Expanded detail rows, keyed by `wallet:conditionId:outcome`. Collapsed by default.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const activeReq = useRef<number>(0);

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

  // Refetch whenever a filter changes (and on mount).
  useEffect(() => {
    load();
  }, [load]);

  // Lazily enrich rows with address age. Collect distinct wallets not yet resolved,
  // POST them, and merge ageDays into `ages` (keyed by lowercased wallet).
  useEffect(() => {
    const groups = data?.groups;
    if (!groups || groups.length === 0) return;
    const want = [
      ...new Set(
        groups
          .map((g) => g.wallet?.toLowerCase())
          .filter((w): w is string => Boolean(w)),
      ),
    ].filter((w) => !(w in ages));
    if (want.length === 0) return;
    let cancelled = false;
    (async () => {
      // Chunk so every requested wallet stays under the route's cap and resolves.
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

  function rowKey(g: AccumGroup): string {
    return `${g.wallet}:${g.conditionId}:${g.outcome}`;
  }

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const stats = data?.stats;

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
      {data && data.groups.length === 0 && !loading ? (
        <div className="ds-empty">该条件下暂无拆单累计</div>
      ) : data && data.groups.length > 0 ? (
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
              {sortedGroups.map((g, i) => {
                const whale = g.netUsd >= WHALE_NET;
                const key = rowKey(g);
                const isOpen = expanded.has(key);
                return (
                  <Fragment key={`${key}-${i}`}>
                    <tr
                      onClick={() => toggleExpand(key)}
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
                        <AgeBadge ageDays={ages[g.wallet?.toLowerCase()]} />
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <WalletStatsBadge
                          stats={walletStats[g.wallet?.toLowerCase()]}
                          smart={smart[g.wallet?.toLowerCase()]}
                        />
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
                        title={`首笔 ${fmtTime(g.firstTs)} → 末笔 ${fmtTime(
                          g.lastTs,
                        )}`}
                      >
                        {fmtTime(g.lastTs)}
                      </td>
                      <td className="mono is-right">
                        <span className="up" style={{ fontWeight: 700 }}>
                          <Icon s={whale ? "🐳" : "🧩"} /> ${fmtUsd(g.netUsd)}
                        </span>
                      </td>
                      <td className="mono is-right">{g.buyCount} 买</td>
                      <td className="mono is-right">
                        ${fmtUsd(g.maxSingleBuyUsd)}
                      </td>
                      <td className="mono is-right">${fmtUsd(g.buyUsd)}</td>
                      <td
                        className={
                          g.sellUsd > 0
                            ? "mono is-right down"
                            : "mono is-right muted"
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
                          <table
                            className="ds-table--compact"
                            style={{ maxWidth: 440 }}
                          >
                            <thead>
                              <tr>
                                <th>时间</th>
                                <th className="is-right">金额</th>
                                <th className="is-right">价格(赔率)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.buys.map((b, bi) => (
                                <tr key={`${key}-buy-${bi}`}>
                                  <td className="mono">{fmtTime(b.ts)}</td>
                                  <td className="mono is-right">
                                    ${fmtUsd(b.usd)}
                                  </td>
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
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </main>
  );
}
