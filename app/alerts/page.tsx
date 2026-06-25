"use client";

import { useEffect, useState } from "react";

type AlertView = {
  title: string;
  outcome: string;
  side: string;
  usd: number;
  price: number;
  wallet: string;
  eventSlug: string;
  txHash: string;
  createdAt: number;
};

type AlertsResponse = {
  count: number;
  alerts: AlertView[];
};

type Side = "ALL" | "BUY" | "SELL";

type AlertConditions = {
  enabled: boolean;
  minUsd: number;
  side: Side;
  minPrice: number | null;
  maxPrice: number | null;
  maxAgeDays: number | null;
};

const DEFAULT_CONDITIONS: AlertConditions = {
  enabled: true,
  minUsd: 10000,
  side: "ALL",
  minPrice: null,
  maxPrice: null,
  maxAgeDays: null,
};

function fmtUsd(usd: number): string {
  return usd.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function shortWallet(w: string): string {
  if (!w) return "";
  return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

function fmtTime(sec: number): string {
  if (!sec) return "";
  return new Date(sec * 1000).toLocaleString("zh-CN", { hour12: false });
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
  minWidth: 64,
  display: "inline-block",
};

const inputStyle: React.CSSProperties = {
  width: 80,
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid #2a3346",
  background: "#11151f",
  color: "#e6e6e6",
  fontSize: 13,
};

// Parse a number input into number|null (blank/NaN → null).
function numOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// 告警条件 panel — edits the conditions stored in the `config` table that the
// embedded engine reads every poll. Telegram-optional: matches always land in the
// alerts table regardless of whether Telegram is configured.
function ConditionsPanel({ pollSeconds }: { pollSeconds: number }) {
  const [c, setC] = useState<AlertConditions>(DEFAULT_CONDITIONS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string>("");
  const [err, setErr] = useState<string>("");
  // Local text state for price/age so intermediate typing isn't coerced eagerly.
  const [minPriceText, setMinPriceText] = useState<string>("");
  const [maxPriceText, setMaxPriceText] = useState<string>("");
  const [ageText, setAgeText] = useState<string>("");

  function hydrate(next: AlertConditions) {
    setC(next);
    setMinPriceText(next.minPrice != null ? String(next.minPrice) : "");
    setMaxPriceText(next.maxPrice != null ? String(next.maxPrice) : "");
    setAgeText(next.maxAgeDays != null ? String(next.maxAgeDays) : "");
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/alert-config", { cache: "no-store" });
        const json = (await res.json()) as Partial<AlertConditions> & {
          error?: string;
        };
        if (!active) return;
        hydrate({ ...DEFAULT_CONDITIONS, ...json });
      } catch (e) {
        if (active) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function save() {
    setSaving(true);
    setErr("");
    const payload: AlertConditions = {
      enabled: c.enabled,
      minUsd: c.minUsd,
      side: c.side,
      minPrice: numOrNull(minPriceText),
      maxPrice: numOrNull(maxPriceText),
      maxAgeDays: numOrNull(ageText),
    };
    try {
      const res = await fetch("/api/alert-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as AlertConditions & { error?: string };
      if (json.error) throw new Error(json.error);
      hydrate(json);
      setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
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
          justifyContent: "space-between",
        }}
      >
        <strong style={{ fontSize: 14, color: "#cfe0ff" }}>告警条件</strong>
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
            checked={c.enabled}
            onChange={(e) => setC({ ...c, enabled: e.target.checked })}
          />
          启用
        </label>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <span style={labelStyle}>最低金额</span>
        <input
          type="number"
          min={0}
          value={c.minUsd}
          onChange={(e) =>
            setC({
              ...c,
              minUsd: Math.max(0, Math.floor(Number(e.target.value) || 0)),
            })
          }
          style={{ ...inputStyle, width: 120 }}
        />
        <span style={{ fontSize: 12, color: "#6f819c" }}>USD</span>
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
        {(["ALL", "BUY", "SELL"] as Side[]).map((s) => (
          <button
            key={s}
            style={btnStyle(c.side === s)}
            onClick={() => setC({ ...c, side: s })}
          >
            {s === "ALL" ? "全部" : s === "BUY" ? "买入" : "卖出"}
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
        <span style={labelStyle}>价格区间</span>
        <input
          type="number"
          step={0.01}
          min={0}
          max={1}
          placeholder="0"
          value={minPriceText}
          onChange={(e) => setMinPriceText(e.target.value)}
          style={inputStyle}
        />
        <span style={{ fontSize: 13, color: "#6f819c" }}>–</span>
        <input
          type="number"
          step={0.01}
          min={0}
          max={1}
          placeholder="1"
          value={maxPriceText}
          onChange={(e) => setMaxPriceText(e.target.value)}
          style={inputStyle}
        />
        <span style={{ fontSize: 12, color: "#6f819c" }}>赔率 0–1</span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <span style={labelStyle}>地址年龄</span>
        <span style={{ fontSize: 13, color: "#6f819c" }}>≤</span>
        <input
          type="number"
          min={0}
          placeholder="不限"
          value={ageText}
          onChange={(e) => setAgeText(e.target.value)}
          style={{ ...inputStyle, width: 70 }}
        />
        <span style={{ fontSize: 12, color: "#6f819c" }}>
          天（留空 = 不限）
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <button
          style={{ ...btnStyle(true), opacity: saving || !loaded ? 0.6 : 1 }}
          onClick={save}
          disabled={saving || !loaded}
        >
          {saving ? "保存中…" : "保存"}
        </button>
        {savedAt ? (
          <span style={{ fontSize: 12, color: "#56d18a" }}>
            已保存 {savedAt}，引擎下一轮(~{pollSeconds}s)生效
          </span>
        ) : null}
        {err ? (
          <span style={{ fontSize: 12, color: "#ff7a7a" }}>
            保存失败: {err}
          </span>
        ) : null}
      </div>
    </section>
  );
}

export default function Page() {
  const [data, setData] = useState<AlertsResponse>({ count: 0, alerts: [] });
  const [lastRefreshed, setLastRefreshed] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const res = await fetch("/api/alerts", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as AlertsResponse;
        if (!active) return;
        setData(json);
        setLastRefreshed(
          new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        );
        setError("");
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    }

    load();
    const id = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return (
    <main
      style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 20px 60px" }}
    >
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 6px" }}>
          🐋 Polymarket 大额成交监控
        </h1>
        <div style={{ fontSize: 13, color: "#8aa0c0" }}>
          共 {data.count} 条告警
          {lastRefreshed ? ` · 最后刷新 ${lastRefreshed}` : ""}
          {error ? (
            <span style={{ color: "#ff7a7a" }}> · 刷新失败: {error}</span>
          ) : null}
          <span style={{ color: "#566", marginLeft: 8 }}>
            · 每 5 秒自动刷新
          </span>
        </div>
      </header>

      <ConditionsPanel pollSeconds={4} />

      {data.count === 0 ? (
        <div
          style={{
            padding: "48px 20px",
            textAlign: "center",
            color: "#8aa0c0",
            border: "1px dashed #2a3346",
            borderRadius: 8,
          }}
        >
          暂无告警 — worker 抓到大单后会出现在这里
        </div>
      ) : (
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
                <th style={headStyle}>市场</th>
                <th style={headStyle}>结果</th>
                <th style={headStyle}>方向</th>
                <th style={{ ...headStyle, textAlign: "right" }}>金额</th>
                <th style={{ ...headStyle, textAlign: "right" }}>价格</th>
                <th style={headStyle}>钱包</th>
                <th style={headStyle}>时间</th>
              </tr>
            </thead>
            <tbody>
              {data.alerts.map((a, i) => {
                const whale = a.usd >= 50000;
                return (
                  <tr key={`${a.txHash}-${i}`}>
                    <td
                      style={{
                        ...cellStyle,
                        whiteSpace: "normal",
                        maxWidth: 360,
                      }}
                    >
                      {whale ? "🐳" : "💰"}{" "}
                      {a.eventSlug ? (
                        <a
                          style={linkStyle}
                          href={`https://polymarket.com/event/${a.eventSlug}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {a.title}
                        </a>
                      ) : (
                        a.title
                      )}
                    </td>
                    <td style={cellStyle}>{a.outcome}</td>
                    <td
                      style={{
                        ...cellStyle,
                        color: a.side === "BUY" ? "#56d18a" : "#ff8a8a",
                        fontWeight: 600,
                      }}
                    >
                      {a.side}
                    </td>
                    <td
                      style={{
                        ...cellStyle,
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      ${fmtUsd(a.usd)}
                    </td>
                    <td
                      style={{
                        ...cellStyle,
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {a.price.toFixed(4)}
                    </td>
                    <td style={cellStyle}>
                      {a.txHash ? (
                        <a
                          style={linkStyle}
                          href={`https://polygonscan.com/tx/${a.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          title={a.wallet}
                        >
                          {shortWallet(a.wallet)}
                        </a>
                      ) : (
                        <span title={a.wallet}>{shortWallet(a.wallet)}</span>
                      )}
                    </td>
                    <td style={{ ...cellStyle, color: "#8aa0c0" }}>
                      {fmtTime(a.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
