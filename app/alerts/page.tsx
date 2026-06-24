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
