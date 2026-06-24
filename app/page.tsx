"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatAge, ageColor } from "./ageFormat";

type ScanTrade = {
  title: string;
  outcome: string;
  side: "BUY" | "SELL";
  usd: number;
  price: number;
  wallet: string;
  eventSlug: string;
  txHash: string;
  ts: number;
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

const linkStyle: React.CSSProperties = {
  color: "#5db0ff",
  textDecoration: "none",
};
const cellStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid #1c2230",
  fontSize: 14,
  whiteSpace: "nowrap",
};
const headStyle: React.CSSProperties = {
  ...cellStyle,
  textAlign: "left",
  color: "#8aa0c0",
  fontWeight: 600,
  borderBottom: "2px solid #2a3346",
  position: "sticky",
  top: 0,
  background: "#0b0e14",
};

function btnStyle(active: boolean): React.CSSProperties {
  return {
    padding: "6px 14px",
    borderRadius: 6,
    border: active ? "1px solid #3b6fd6" : "1px solid #2a3346",
    background: active ? "#16233f" : "#11151f",
    color: active ? "#cfe0ff" : "#8aa0c0",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  };
}

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#6f819c",
  marginRight: 8,
  minWidth: 44,
  display: "inline-block",
};

const priceInputStyle: React.CSSProperties = {
  width: 70,
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid #2a3346",
  background: "#11151f",
  color: "#e6e6e6",
  fontSize: 13,
};

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
      if (maxAgeDays != null) {
        const a = ages[t.wallet?.toLowerCase()];
        if (typeof a !== "number" || !Number.isFinite(a) || a > maxAgeDays) {
          return false;
        }
      }
      return true;
    });
  }, [sortedTrades, minPrice, maxPrice, maxAgeDays, ages]);

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
      const w = t.wallet?.toLowerCase();
      return !w || !(w in ages);
    });
  }, [sortedTrades, minPrice, maxPrice, maxAgeDays, ages]);

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
    <main
      style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 20px 60px" }}
    >
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 6px" }}>
          🔍 24h 大额成交扫描器
        </h1>
        <div style={{ fontSize: 13, color: "#8aa0c0" }}>
          实时查询 Polymarket 公共 API（不落库）
          {lastRefreshed ? ` · 最后刷新 ${lastRefreshed}` : ""}
          {loading ? <span style={{ color: "#e3b341" }}> · 加载中…</span> : ""}
        </div>
      </header>

      {/* Controls */}
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: 16,
          border: "1px solid #1c2230",
          borderRadius: 8,
          marginBottom: 20,
          background: "#0d1119",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <span style={labelStyle}>金额</span>
          {AMOUNT_PRESETS.map((p) => (
            <button
              key={p}
              style={btnStyle(minUsd === p)}
              onClick={() => setMinUsd(p)}
            >
              ${fmtUsd(p)}
            </button>
          ))}
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
            style={{
              width: 130,
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #2a3346",
              background: "#11151f",
              color: "#e6e6e6",
              fontSize: 13,
            }}
          />
          <span style={{ fontSize: 12, color: "#6f819c" }}>
            当前 ≥ ${fmtUsd(minUsd)}
          </span>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <span style={labelStyle}>方向</span>
          <button
            style={btnStyle(side === "ALL")}
            onClick={() => setSide("ALL")}
          >
            全部
          </button>
          <button
            style={btnStyle(side === "BUY")}
            onClick={() => setSide("BUY")}
          >
            买入 (BUY)
          </button>
          <button
            style={btnStyle(side === "SELL")}
            onClick={() => setSide("SELL")}
          >
            卖出 (SELL)
          </button>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <span style={labelStyle}>时间</span>
          {([1, 6, 24] as Hours[]).map((h) => (
            <button
              key={h}
              style={btnStyle(hours === h)}
              onClick={() => setHours(h)}
            >
              {h}h
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <button style={btnStyle(false)} onClick={() => load()}>
            刷新
          </button>
          <label
            style={{
              fontSize: 13,
              color: "#8aa0c0",
              display: "flex",
              alignItems: "center",
              gap: 6,
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
        </div>

        {/* Price (odds) band — insider money tends to buy at favorable odds. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <span style={labelStyle}>价格</span>
          <input
            type="number"
            step={0.01}
            min={0}
            max={1}
            placeholder="0"
            value={minPrice}
            onChange={(e) => setMinPrice(e.target.value)}
            style={priceInputStyle}
          />
          <span style={{ fontSize: 13, color: "#6f819c" }}>–</span>
          <input
            type="number"
            step={0.01}
            min={0}
            max={1}
            placeholder="1"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            style={priceInputStyle}
          />
          {minPrice || maxPrice ? (
            <button
              onClick={() => {
                setMinPrice("");
                setMaxPrice("");
              }}
              style={{
                background: "none",
                border: "none",
                color: "#6f819c",
                fontSize: 12,
                cursor: "pointer",
                padding: "4px 6px",
              }}
            >
              清除
            </button>
          ) : null}
          <span style={{ fontSize: 12, color: "#6f819c" }}>赔率 0–1</span>
        </div>

        {/* Address age — insider money tends to use relatively new wallets. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <span style={labelStyle}>地址年龄</span>
          <button
            style={btnStyle(maxAgeDays === null)}
            onClick={() => setMaxAgeDays(null)}
          >
            全部
          </button>
          {[1, 7, 30].map((d) => (
            <button
              key={d}
              style={btnStyle(maxAgeDays === d)}
              onClick={() => setMaxAgeDays(d)}
            >
              ≤{d}天
            </button>
          ))}
          <span style={{ fontSize: 12, color: "#6f819c" }}>≤</span>
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
            style={{ ...priceInputStyle, width: 56 }}
          />
          <span style={{ fontSize: 12, color: "#6f819c" }}>天</span>
        </div>
      </section>

      {data?.error ? (
        <div
          style={{
            padding: "12px 16px",
            marginBottom: 16,
            border: "1px solid #5a2a2a",
            borderRadius: 8,
            background: "#1c1212",
            color: "#ff9a9a",
            fontSize: 13,
          }}
        >
          扫描失败: {data.error}
        </div>
      ) : null}

      {/* Stats header */}
      {stats ? (
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 12,
            marginBottom: 20,
          }}
        >
          <div style={statCard}>
            <div style={statLabel}>笔数</div>
            <div style={statValue}>{stats.count}</div>
          </div>
          <div style={statCard}>
            <div style={statLabel}>总额</div>
            <div style={statValue}>${fmtUsd(stats.totalUsd)}</div>
          </div>
          <div style={statCard}>
            <div style={statLabel}>买额 vs 卖额</div>
            <div style={{ fontSize: 14, marginBottom: 6 }}>
              <span style={{ color: "#56d18a", fontWeight: 600 }}>
                买 ${fmtUsd(buyUsd)}
              </span>
              <span style={{ color: "#6f819c" }}> · </span>
              <span style={{ color: "#ff8a8a", fontWeight: 600 }}>
                卖 ${fmtUsd(sellUsd)}
              </span>
            </div>
            <div
              style={{
                height: 8,
                borderRadius: 4,
                overflow: "hidden",
                display: "flex",
                background: "#1c2230",
              }}
            >
              <div style={{ width: `${buyPct}%`, background: "#56d18a" }} />
              <div style={{ width: `${sellPct}%`, background: "#ff8a8a" }} />
            </div>
          </div>
          <div style={statCard}>
            <div style={statLabel}>最大单</div>
            {stats.maxTrade ? (
              <div>
                <div style={{ ...statValue, fontSize: 18 }}>
                  ${fmtUsd(stats.maxTrade.usd)}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "#8aa0c0",
                    marginTop: 4,
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
              <div style={{ ...statValue, fontSize: 18, color: "#6f819c" }}>
                —
              </div>
            )}
          </div>
        </section>
      ) : null}

      {data?.truncated ? (
        <div
          style={{
            padding: "8px 14px",
            marginBottom: 16,
            border: "1px solid #5a4a1a",
            borderRadius: 8,
            background: "#1a160c",
            color: "#e3b341",
            fontSize: 13,
          }}
        >
          ⚠️ 结果可能不全（已达扫描上限）
        </div>
      ) : null}

      {/* Filtered count (reflects the client-side price/age filters) */}
      {data && data.trades.length > 0 ? (
        <div
          style={{
            fontSize: 13,
            color: "#8aa0c0",
            marginBottom: 10,
          }}
        >
          符合筛选{" "}
          <strong style={{ color: "#e6e6e6" }}>{displayedTrades.length}</strong>{" "}
          笔
          {agesStillLoading ? (
            <span style={{ color: "#6f819c" }}>
              {" "}
              · 地址年龄加载中，结果将随加载补全
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Table */}
      {data && data.trades.length === 0 && !loading ? (
        <div
          style={{
            padding: "48px 20px",
            textAlign: "center",
            color: "#8aa0c0",
            border: "1px dashed #2a3346",
            borderRadius: 8,
          }}
        >
          该筛选条件下 {hours}h 内暂无成交
        </div>
      ) : data && data.trades.length > 0 ? (
        <div
          style={{
            overflowX: "auto",
            border: "1px solid #1c2230",
            borderRadius: 8,
          }}
        >
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th
                  style={{
                    ...headStyle,
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => toggleSort("time")}
                  title="点击按时间排序"
                >
                  时间{sortArrow("time")}
                </th>
                <th style={headStyle}>市场 / 结果</th>
                <th style={headStyle}>方向</th>
                <th
                  style={{
                    ...headStyle,
                    textAlign: "right",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => toggleSort("amount")}
                  title="点击按金额排序"
                >
                  金额{sortArrow("amount")}
                </th>
                <th style={{ ...headStyle, textAlign: "right" }}>价格</th>
                <th style={headStyle}>钱包</th>
                <th style={headStyle}>地址年龄</th>
                <th style={headStyle}>tx</th>
              </tr>
            </thead>
            <tbody>
              {displayedTrades.map((t, i) => {
                const whale = t.usd >= 50000;
                return (
                  <tr key={`${t.txHash}-${t.wallet}-${i}`}>
                    <td style={{ ...cellStyle, color: "#8aa0c0" }}>
                      {fmtClock(t.ts)}
                    </td>
                    <td
                      style={{
                        ...cellStyle,
                        whiteSpace: "normal",
                        maxWidth: 360,
                      }}
                    >
                      {t.eventSlug ? (
                        <a
                          style={linkStyle}
                          href={`https://polymarket.com/event/${t.eventSlug}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t.title}
                        </a>
                      ) : (
                        t.title
                      )}
                      <div style={{ fontSize: 12, color: "#6f819c" }}>
                        {t.outcome}
                      </div>
                    </td>
                    <td style={cellStyle}>
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: 4,
                          fontSize: 12,
                          fontWeight: 700,
                          color: t.side === "BUY" ? "#56d18a" : "#ff8a8a",
                          background: t.side === "BUY" ? "#13301f" : "#311414",
                        }}
                      >
                        {t.side}
                      </span>
                    </td>
                    <td
                      style={{
                        ...cellStyle,
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {whale ? "🐳" : "💰"} ${fmtUsd(t.usd)}
                    </td>
                    <td
                      style={{
                        ...cellStyle,
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {t.price.toFixed(3)}
                    </td>
                    <td style={cellStyle}>
                      <a
                        style={linkStyle}
                        href={`https://polymarket.com/profile/${t.wallet}`}
                        target="_blank"
                        rel="noreferrer"
                        title={t.wallet}
                      >
                        {shortWallet(t.wallet)}
                      </a>
                    </td>
                    <td style={cellStyle}>
                      {(() => {
                        const { text, tone } = formatAge(
                          ages[t.wallet?.toLowerCase()],
                        );
                        return (
                          <span
                            style={{ color: ageColor[tone], fontWeight: 600 }}
                          >
                            {text}
                          </span>
                        );
                      })()}
                    </td>
                    <td style={cellStyle}>
                      {t.txHash ? (
                        <a
                          style={linkStyle}
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

const statCard: React.CSSProperties = {
  padding: "14px 16px",
  border: "1px solid #1c2230",
  borderRadius: 8,
  background: "#0d1119",
};
const statLabel: React.CSSProperties = {
  fontSize: 12,
  color: "#6f819c",
  marginBottom: 6,
};
const statValue: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  color: "#e6e6e6",
  fontVariantNumeric: "tabular-nums",
};
