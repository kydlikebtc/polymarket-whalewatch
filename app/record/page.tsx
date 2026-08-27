"use client";

import { useEffect, useState } from "react";
import type { RecordFeed, RecordFeedStrategy } from "../../lib/recordFeed";
import { formatRecordLine } from "../../lib/signalRecord";
import { CopyButton } from "../ui";

// 对外信号批次 3:公开信号战绩页。
// 口径与 /follow 的区别是本页的存在理由:这里只统计**公开发出过**的信号
// (strategy_signals × sent 投递),不是全部纸面历史 —— 拿全量纸面账给发布
// 记录背书,就是社会证明造假的软形态。战绩行文案直接复用 formatRecordLine
// (lib/signalRecord,全站唯一实现;该模块对 db 仅 type-import,client 安全)。

const cents = (p: number | null): string =>
  p == null ? "—" : `${(p * 100).toFixed(1).replace(/\.0$/, "")}¢`;

const usdSigned = (n: number | null): string => {
  if (n == null) return "—";
  const s = `$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
  return n > 0 ? `+${s}` : n < 0 ? `-${s}` : s;
};

const timeText = (sec: number): string =>
  new Date(sec * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const SOURCE_LABEL: Record<string, string> = {
  consensus: "共识",
  heavy: "巨鲸单",
  lopsided: "一边倒分歧",
  resolved: "分歧解除",
  lone_wolf: "独狼",
  early_winner: "早期赢家",
};

function StrategyCard({ s }: { s: RecordFeedStrategy }) {
  const line = formatRecordLine(s.name, s.record);
  // implied vs wins 对比条:市场预期是基准刻度,超出/不足一眼可见。
  const denom = Math.max(s.record.settled, 1);
  const winsPct = Math.min(100, (s.record.wins / denom) * 100);
  const impliedPct = Math.min(100, (s.record.implied / denom) * 100);
  return (
    <div className="ds-card" style={{ marginBottom: "var(--s-4)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "var(--s-2)",
          marginBottom: "var(--s-2)",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: "var(--t-lg)" }}>
          {s.name}
        </span>
        <span className="ds-tag">{SOURCE_LABEL[s.source] ?? s.source}</span>
        <span className="ds-hint">已发布 {s.pushedCount} 条</span>
      </div>
      {line ? (
        <div style={{ marginBottom: "var(--s-3)" }}>{line}</div>
      ) : (
        <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
          已发布信号尚无结算样本
        </div>
      )}
      {s.record.settled > 0 && (
        <div style={{ marginBottom: "var(--s-3)" }}>
          <div className="ds-label">命中 vs 市场同价位预期</div>
          <div style={{ display: "grid", gap: 4 }}>
            <div
              title={`命中 ${s.record.wins}`}
              style={{
                height: 8,
                width: `${winsPct}%`,
                minWidth: 2,
                borderRadius: 4,
                background: "var(--ok-500, #22c55e)",
              }}
            />
            <div
              title={`市场预期 ${s.record.implied.toFixed(1)}`}
              style={{
                height: 8,
                width: `${impliedPct}%`,
                minWidth: 2,
                borderRadius: 4,
                background: "var(--n-400, #94a3b8)",
              }}
            />
          </div>
          <div className="ds-hint">
            绿=实际命中 {s.record.wins} · 灰=市场同价位预期{" "}
            {s.record.implied.toFixed(1)}(分母 {s.record.settled})
          </div>
        </div>
      )}
      {s.settledRecent.length > 0 && (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th>市场</th>
                <th>方向</th>
                <th>进</th>
                <th>结算</th>
                <th>盈亏</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {s.settledRecent.map((r) => (
                <tr key={r.id}>
                  <td
                    style={{
                      maxWidth: 260,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={r.title}
                  >
                    {r.title}
                  </td>
                  <td>{r.outcome}</td>
                  <td>{cents(r.entryPrice)}</td>
                  <td>
                    {r.won === true ? "✅" : r.won === false ? "❌" : "➖"}{" "}
                    {cents(r.exitPrice)}
                  </td>
                  <td>{usdSigned(r.realizedPnl)}</td>
                  <td className="ds-hint">{timeText(r.settledAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function RecordPage() {
  const [feed, setFeed] = useState<RecordFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 嵌入代码要绝对地址,SSR 阶段没有 window —— 挂载后再补,避免水合错位。
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const embedSnippet = `<iframe src="${origin}/embed/record" width="440" height="340" style="border:0" loading="lazy" title="WhaleWatch record"></iframe>`;
  useEffect(() => {
    fetch("/api/record")
      .then((r) => r.json())
      .then((j) => {
        if (j.error) setError(String(j.error));
        setFeed(j as RecordFeed);
      })
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-4)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", marginBottom: "var(--s-1)" }}>
          📜 公开信号战绩
        </h1>
        <div className="ds-hint">
          本页只统计通过信号通道<b>公开发出过</b>的策略买入信号(不是全部纸面
          历史,完整策略履历见「策略中心」)。先发布、后结算、逐条认账。
        </div>
      </header>

      <div className="ds-callout" style={{ marginBottom: "var(--s-5)" }}>
        <b>口径三声明</b>:①纸面口径 —— 入场/盈亏是模拟跟单数字(真实数据 ·
        模拟策略),不含真实执行成本;②已结算口径 —— 只统计有结算判定的信号, 盈亏
        $0 的平局不进胜率分母;③各档独立 —— 不同档位常在同一市场重叠开仓,
        战绩不可跨档相加。命中数旁必印「市场同价位预期」:入场价本身就是市场
        给的概率,跑赢它才是本事,超额未过 ±2σ 一律注明「仍在运气范围内」。
        <div style={{ marginTop: "var(--s-2)" }}>
          研究用途模拟信号 · 非投资建议 · 只读非托管
        </div>
      </div>

      {error && (
        <div className="ds-callout" style={{ marginBottom: "var(--s-4)" }}>
          加载失败:{error}
        </div>
      )}
      {!feed && !error && <div className="ds-hint">加载中…</div>}
      {feed && feed.strategies.length === 0 && (
        <div className="ds-hint">
          尚无公开发布的信号 —— 台账静默积累中,首批档位按战绩放开后此页开始
          记账。
        </div>
      )}
      {feed?.strategies.map((s) => (
        <StrategyCard key={s.id} s={s} />
      ))}

      {feed?.digest.day && (
        <div className="ds-hint" style={{ marginTop: "var(--s-5)" }}>
          🔏 存证链:每 UTC 日把昨日全部已发布信号的链式 sha256 摘要发布到公开
          Telegram 频道(消息带官方时间戳、不可编辑)。最近存证 {feed.digest.day}
          ,链尾 <code>{feed.digest.tail?.slice(0, 16)}…</code> —— 任何人可按
          明细复算,事后删改任何一条信号,摘要必变。
        </div>
      )}

      <div className="ds-hint" style={{ marginTop: "var(--s-4)" }}>
        ⬇ <a href="/api/dataset/record.csv">下载全量 CSV 数据集</a>
        (已发布信号逐行台账,含未结算行 —— 分母诚实;CC BY 4.0,署名
        whalewatch.wired.fund。防篡改校验走上方存证链,CSV 是便利导出不是
        存证载体)
      </div>

      {origin && (
        <details style={{ marginTop: "var(--s-3)" }}>
          <summary className="ds-hint" style={{ cursor: "pointer" }}>
            嵌入此战绩卡
          </summary>
          <div className="embed-snippet">
            <code>{embedSnippet}</code>
            <CopyButton text={embedSnippet} />
          </div>
          <div className="ds-hint">
            嵌入卡 60 秒缓存、无脚本、自带署名回链;加 ?theme=dark 得深色版。
          </div>
        </details>
      )}
    </main>
  );
}
