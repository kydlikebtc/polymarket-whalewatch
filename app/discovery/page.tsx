"use client";

import { useCallback, useEffect, useState } from "react";
import { StatCard, Tag } from "../ui";

// -------------------------------------------------------------- read model

interface ChannelStat {
  channel: string;
  markets: number;
}
interface CandidateRow {
  address: string;
  channels: ChannelStat[];
  totalMarkets: number;
  lastTs: number;
  latestNote: string;
  status: "candidate" | "admitted" | "bot";
}
interface AdmittedRow {
  address: string;
  source: string;
  score: number | null;
  winRate: number | null;
  netPnl: number | null;
  updatedAt: number | null;
}
interface DiscoveryPayload {
  candidates: CandidateRow[];
  admitted: AdmittedRow[];
  counts: { evidenceRows: number; candidateWallets: number; admitted: number };
  error?: string;
}

// ------------------------------------------------------------- formatting

const CHANNEL_BADGE: Record<
  string,
  { icon: string; label: string; tip: string }
> = {
  echo: {
    icon: "🔁",
    label: "共识同行",
    tip: "与聪明钱共识同一(市场·结果)同向净买 ≥$2k 的非白名单钱包",
  },
  splitter: {
    icon: "🧩",
    label: "拆单建仓",
    tip: "≥3 笔低于 $10k 的拆单净买 ≥$5k、无对冲/做市嫌疑",
  },
  insider: {
    icon: "🕵️",
    label: "内幕签名",
    tip: "账龄 ≤7 天的新地址单笔 ≥$5k 买入 0.5–0.9 价带",
  },
  early_winner: {
    icon: "🎯",
    label: "早期赢家",
    tip: "在已结算市场提前 ≥24h 以 ≤40¢ 买中获胜结果",
  },
};

function channelBadge(channel: string) {
  const b = CHANNEL_BADGE[channel];
  return b ? (
    <span title={b.tip}>
      {b.icon} {b.label}
    </span>
  ) : (
    <span>{channel}</span>
  );
}

function sourceLabel(source: string): string {
  if (source.startsWith("discovered:")) {
    const b = CHANNEL_BADGE[source.slice("discovered:".length)];
    return b ? `${b.icon} ${b.label}` : source;
  }
  if (source.startsWith("category:")) {
    return `🏅 分类榜 · ${source.slice("category:".length)}`;
  }
  return source;
}

function shortWallet(w: string): string {
  if (!w) return "";
  return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

function fmtUsd(usd: number): string {
  return usd.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtAgo(tsSec: number): string {
  const mins = Math.max(0, Math.round(Date.now() / 1000 - tsSec) / 60);
  if (mins < 60) return `${Math.round(mins)} 分钟前`;
  const h = mins / 60;
  if (h < 48) return `${Math.round(h)} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

function statusTag(status: CandidateRow["status"]) {
  if (status === "admitted") return <Tag variant="up">已入池</Tag>;
  if (status === "bot") return <Tag variant="warn">🤖 做市机器人</Tag>;
  return <Tag>候选中</Tag>;
}

// ------------------------------------------------------------------ page

export default function DiscoveryPage() {
  const [data, setData] = useState<DiscoveryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/discovery");
      const json = (await res.json()) as DiscoveryPayload;
      if (json.error) setError(json.error);
      else setError(null);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <main className="ds-main">
        <header style={{ marginBottom: "var(--s-5)" }}>
          <h1 style={{ fontSize: "var(--t-2xl)", marginBottom: "var(--s-1)" }}>
            🔭 聪明钱发现
          </h1>
          <div className="ds-hint">
            白名单之外的聪明钱候选漏斗：成交流涌现（共识同行 / 拆单建仓 /
            内幕签名）+ 已结算市场早期赢家 + 分类榜专家。 候选须在 30 天内于 ≥3
            个不同市场留下证据，并通过战绩审查（做市机器人硬拒）才会进入白名单池。
          </div>
        </header>

        {error && (
          <div className="ds-callout" style={{ marginBottom: "var(--s-4)" }}>
            加载失败：{error}
          </div>
        )}

        {/* KPI strip */}
        <section className="kpi" style={{ marginBottom: "var(--s-5)" }}>
          <StatCard label="30 天证据条数">
            <div className="kpi-value">{data?.counts.evidenceRows ?? "—"}</div>
          </StatCard>
          <StatCard label="候选钱包">
            <div className="kpi-value">
              {data?.counts.candidateWallets ?? "—"}
            </div>
          </StatCard>
          <StatCard label="发现渠道在池成员">
            <div className="kpi-value">{data?.counts.admitted ?? "—"}</div>
          </StatCard>
        </section>

        {/* Candidate funnel */}
        <section style={{ marginBottom: "var(--s-6)" }}>
          <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
            候选漏斗（近 30 天证据 · 按复发广度排序）
          </div>
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead>
                <tr>
                  <th>钱包</th>
                  <th>渠道 · 市场数</th>
                  <th className="is-right">复发广度</th>
                  <th>最近证据</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {(data?.candidates ?? []).map((c) => (
                  <tr key={c.address}>
                    <td>
                      <a
                        className="mono"
                        href={`/wallet/${c.address}`}
                        target="_blank"
                        rel="noreferrer"
                        title={`${c.address} · 新标签打开钱包档案`}
                      >
                        {shortWallet(c.address)}
                      </a>
                    </td>
                    <td>
                      {c.channels.map((ch) => (
                        <span
                          key={ch.channel}
                          style={{ marginRight: "var(--s-2)" }}
                        >
                          {channelBadge(ch.channel)}{" "}
                          <span className="mono">×{ch.markets}</span>
                        </span>
                      ))}
                    </td>
                    <td
                      className="mono is-right"
                      title="各渠道去重市场数之和（同一市场被两个渠道命中计两次——两种独立行为签名强于一种）"
                    >
                      {c.totalMarkets}
                    </td>
                    <td
                      style={{
                        whiteSpace: "normal",
                        maxWidth: 420,
                        lineHeight: 1.5,
                      }}
                      title={c.latestNote}
                    >
                      {c.latestNote}
                      <span
                        className="ds-hint"
                        style={{ marginLeft: "var(--s-2)" }}
                      >
                        {fmtAgo(c.lastTs)}
                      </span>
                    </td>
                    <td>{statusTag(c.status)}</td>
                  </tr>
                ))}
                {!loading && (data?.candidates ?? []).length === 0 && (
                  <tr>
                    <td colSpan={5} className="ds-hint">
                      暂无候选 —
                      证据由共识循环（每5分钟）与每日已结算市场扫描持续积累
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Program output */}
        <section>
          <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
            发现渠道产出的在池成员（含分类榜专家 · 30 天不再合格自动出池）
          </div>
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead>
                <tr>
                  <th>钱包</th>
                  <th>来源</th>
                  <th className="is-right">评分</th>
                  <th className="is-right">胜率</th>
                  <th className="is-right">净盈亏</th>
                  <th className="is-right">最近确认</th>
                </tr>
              </thead>
              <tbody>
                {(data?.admitted ?? []).map((a) => (
                  <tr key={a.address}>
                    <td>
                      <a
                        className="mono"
                        href={`/wallet/${a.address}`}
                        target="_blank"
                        rel="noreferrer"
                        title={`${a.address} · 新标签打开钱包档案`}
                      >
                        {shortWallet(a.address)}
                      </a>
                    </td>
                    <td>{sourceLabel(a.source)}</td>
                    <td className="mono is-right">
                      {a.score != null ? Math.round(a.score) : "—"}
                    </td>
                    <td className="mono is-right">
                      {a.winRate != null
                        ? `${Math.round(a.winRate * 100)}%`
                        : "—"}
                    </td>
                    <td className="mono is-right">
                      {a.netPnl != null ? `$${fmtUsd(a.netPnl)}` : "—"}
                    </td>
                    <td className="mono is-right">
                      {a.updatedAt != null ? fmtAgo(a.updatedAt) : "—"}
                    </td>
                  </tr>
                ))}
                {!loading && (data?.admitted ?? []).length === 0 && (
                  <tr>
                    <td colSpan={6} className="ds-hint">
                      暂无 —
                      候选通过准入审查（复发≥3市场+战绩闸）或分类榜播种后出现在这里
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </>
  );
}
