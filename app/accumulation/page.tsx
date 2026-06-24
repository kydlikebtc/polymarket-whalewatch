"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatAge, ageColor } from "../ageFormat";

type AccumGroup = {
  wallet: string;
  conditionId: string;
  outcome: string;
  title: string;
  eventSlug: string;
  buyUsd: number;
  sellUsd: number;
  netUsd: number;
  buyCount: number;
  sellCount: number;
  maxSingleBuyUsd: number;
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
  groups: AccumGroup[];
  error?: string;
};

type Hours = 1 | 2 | 4;
type SortKey = "net" | "buyCount" | "maxSingle" | "buyUsd";

const NET_PRESETS = [10000, 25000, 50000];
const WHALE_NET = 50000;

function fmtUsd(usd: number): string {
  return usd.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function shortWallet(w: string): string {
  if (!w) return "";
  return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
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

export default function AccumulationPage() {
  const [hours, setHours] = useState<Hours>(4);
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

  const activeReq = useRef<number>(0);

  const load = useCallback(async () => {
    const reqId = ++activeReq.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        hours: String(hours),
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
        filters: { floor: 2000, hours, minNetUsd },
        stats: { groupCount: 0, totalNetUsd: 0, topNetUsd: 0 },
        truncated: false,
        groups: [],
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (reqId === activeReq.current) setLoading(false);
    }
  }, [hours, minNetUsd]);

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
      const av = pick(a);
      const bv = pick(b);
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [data, sortKey, sortDir]);

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

  return (
    <main
      style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 20px 60px" }}
    >
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 6px" }}>
          🧩 拆单 / 累计买入榜
        </h1>
        <div style={{ fontSize: 13, color: "#8aa0c0" }}>
          按 (钱包·市场·结果) 聚合多笔小额买入，揪出绕过单笔监控的累积建仓
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
          <span style={labelStyle}>时间窗</span>
          {([1, 2, 4] as Hours[]).map((h) => (
            <button
              key={h}
              style={btnStyle(hours === h)}
              onClick={() => setHours(h)}
            >
              {h}h
            </button>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <span style={labelStyle}>净买入</span>
          {NET_PRESETS.map((p) => (
            <button
              key={p}
              style={btnStyle(minNetUsd === p)}
              onClick={() => setMinNetUsd(p)}
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
            当前净买入 ≥ ${fmtUsd(minNetUsd)}
          </span>
          <span style={{ flex: 1 }} />
          <button style={btnStyle(false)} onClick={() => load()}>
            刷新
          </button>
        </div>

        <div style={{ fontSize: 12, color: "#6f819c" }}>
          精度 floor $2000 · 每笔 &lt; $10k 才算拆单 · ≥3 笔买入
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
            <div style={statLabel}>累积者数</div>
            <div style={statValue}>{stats.groupCount}</div>
          </div>
          <div style={statCard}>
            <div style={statLabel}>合计净买入</div>
            <div style={statValue}>${fmtUsd(stats.totalNetUsd)}</div>
          </div>
          <div style={statCard}>
            <div style={statLabel}>最大净买入</div>
            <div style={statValue}>${fmtUsd(stats.topNetUsd)}</div>
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
          ⚠️ 窗口可能不全（已达扫描上限）
        </div>
      ) : null}

      {/* Table */}
      {data && data.groups.length === 0 && !loading ? (
        <div
          style={{
            padding: "48px 20px",
            textAlign: "center",
            color: "#8aa0c0",
            border: "1px dashed #2a3346",
            borderRadius: 8,
          }}
        >
          该条件下暂无拆单累计
        </div>
      ) : data && data.groups.length > 0 ? (
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
                <th style={headStyle}>钱包</th>
                <th style={headStyle}>地址年龄</th>
                <th style={headStyle}>市场 · 结果</th>
                <th
                  style={{
                    ...headStyle,
                    textAlign: "right",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => toggleSort("net")}
                  title="点击按净买入排序"
                >
                  净买入{sortArrow("net")}
                </th>
                <th
                  style={{
                    ...headStyle,
                    textAlign: "right",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => toggleSort("buyCount")}
                  title="点击按笔数排序"
                >
                  笔数{sortArrow("buyCount")}
                </th>
                <th
                  style={{
                    ...headStyle,
                    textAlign: "right",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => toggleSort("maxSingle")}
                  title="点击按单笔最大排序"
                >
                  单笔最大{sortArrow("maxSingle")}
                </th>
                <th
                  style={{
                    ...headStyle,
                    textAlign: "right",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => toggleSort("buyUsd")}
                  title="点击按毛买入排序"
                >
                  毛买入{sortArrow("buyUsd")}
                </th>
                <th style={{ ...headStyle, textAlign: "right" }}>毛卖出</th>
              </tr>
            </thead>
            <tbody>
              {sortedGroups.map((g, i) => {
                const whale = g.netUsd >= WHALE_NET;
                return (
                  <tr key={`${g.wallet}-${g.conditionId}-${g.outcome}-${i}`}>
                    <td style={cellStyle}>
                      <a
                        style={linkStyle}
                        href={`https://polymarket.com/profile/${g.wallet}`}
                        target="_blank"
                        rel="noreferrer"
                        title={g.wallet}
                      >
                        {shortWallet(g.wallet)}
                      </a>
                    </td>
                    <td style={cellStyle}>
                      {(() => {
                        const { text, tone } = formatAge(
                          ages[g.wallet?.toLowerCase()],
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
                    <td
                      style={{
                        ...cellStyle,
                        whiteSpace: "normal",
                        maxWidth: 360,
                      }}
                    >
                      {g.eventSlug ? (
                        <a
                          style={linkStyle}
                          href={`https://polymarket.com/event/${g.eventSlug}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {g.title}
                        </a>
                      ) : (
                        g.title
                      )}
                      <div style={{ fontSize: 12, color: "#6f819c" }}>
                        {g.outcome}
                      </div>
                    </td>
                    <td
                      style={{
                        ...cellStyle,
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                        fontWeight: 700,
                        color: "#56d18a",
                      }}
                    >
                      {whale ? "🐳" : "🧩"} ${fmtUsd(g.netUsd)}
                    </td>
                    <td
                      style={{
                        ...cellStyle,
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {g.buyCount} 买
                    </td>
                    <td
                      style={{
                        ...cellStyle,
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      ${fmtUsd(g.maxSingleBuyUsd)}
                    </td>
                    <td
                      style={{
                        ...cellStyle,
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      ${fmtUsd(g.buyUsd)}
                    </td>
                    <td
                      style={{
                        ...cellStyle,
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                        color: g.sellUsd > 0 ? "#ff8a8a" : "#6f819c",
                      }}
                    >
                      ${fmtUsd(g.sellUsd)}
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
