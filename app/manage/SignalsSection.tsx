"use client";

import { useState } from "react";
import type { AdminSignalOverview } from "../../lib/adminOverview";
import { formatRecordLine } from "../../lib/signalRecord";
import { agoText, authHeaders, cents, timeText } from "./shared";

// 区块 4:可推送信号的呈现与管理。
// 上半:13 档全列(含未放开)—— 放开哪档要看它的台账表现,pushEnabled 开关
// 是本页唯一高频写操作。下半:最近 20 条信号的逐通道投递状态,回答
// 「刚才那条到底推没推出去、卡在哪」。

const SOURCE_LABEL: Record<string, string> = {
  consensus: "共识",
  heavy: "巨鲸单",
  lopsided: "一边倒",
  resolved: "分歧解除",
  lone_wolf: "独狼",
  early_winner: "早期赢家",
};

const STATUS_LABEL: Record<string, string> = {
  sent: "✅已发",
  skipped_stale: "⏭过期跳过",
  failed_permanent: "❌永久失败",
};

const CH_LABEL: Record<string, string> = {
  tg_paid: "付费",
  tg_public: "公开",
};

export default function SignalsSection({
  token,
  overview,
  reload,
}: {
  token: string;
  overview: AdminSignalOverview | null;
  reload: () => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (strategyId: number, pushEnabled: boolean) => {
    // 放开推送是对外动作(订户会立刻开始收到该档信号)—— 二次确认;
    // 关闭是止损方向,单击即生效。
    if (pushEnabled) {
      const name =
        overview?.strategies.find((s) => s.id === strategyId)?.name ??
        `#${strategyId}`;
      if (
        !window.confirm(
          `放开「${name}」的对外推送?\n该档后续触发的买入信号将实时进入付费频道、延迟进入公开频道/API。`,
        )
      ) {
        return;
      }
    }
    setBusyId(strategyId);
    setError(null);
    try {
      const res = await fetch("/api/admin/signals", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({ strategyId, pushEnabled }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok || j.error) {
        setError(j.error ?? `HTTP ${res.status}`);
      } else {
        await reload();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      id="signals"
      className="ds-card"
      style={{ marginBottom: "var(--s-5)", scrollMarginTop: "var(--s-6)" }}
    >
      <h2 style={{ fontSize: "var(--t-lg)", marginBottom: "var(--s-1)" }}>
        📡 可推送信号管理
      </h2>
      <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
        推送开关默认全关(先静默积累台账,按战绩放开)。开关只影响对外投递,
        不影响策略本身的纸面开仓。
      </div>
      {error && (
        <div className="ds-callout" style={{ marginBottom: "var(--s-3)" }}>
          {error}
        </div>
      )}
      {!overview && <div className="ds-hint">需要有效管理令牌后加载。</div>}
      {overview && (
        <>
          <div className="ds-table-wrap" style={{ marginBottom: "var(--s-4)" }}>
            <table className="ds-table">
              <thead>
                <tr>
                  <th>档位</th>
                  <th>信号源</th>
                  <th>30d 战绩(全量纸面)</th>
                  <th>台账信号</th>
                  <th>已投递</th>
                  <th>推送</th>
                </tr>
              </thead>
              <tbody>
                {overview.strategies.map((s) => {
                  const line = formatRecordLine(s.name, s.record);
                  return (
                    <tr
                      key={s.id}
                      style={{
                        // 推送中的行淡绿高亮(19 行里一眼找到「现在在对外说话
                        // 的档」);策略停用的行整体弱化。
                        background: s.pushEnabled
                          ? "oklch(0.97 0.03 155)"
                          : undefined,
                        opacity: s.enabled ? 1 : 0.55,
                      }}
                    >
                      <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                        {s.name}
                        {!s.enabled && (
                          <span className="ds-hint">(策略停用)</span>
                        )}
                      </td>
                      <td>
                        <span className="ds-tag">
                          {SOURCE_LABEL[s.source] ?? s.source}
                        </span>
                      </td>
                      {/* 紧凑三元组(悬停看 formatRecordLine 完整口径句):
                          命中/分母 · 预期(implied 必印铁律) · 超额+噪音判定。 */}
                      <td
                        style={{ whiteSpace: "nowrap" }}
                        title={line ?? undefined}
                      >
                        {s.record.settled === 0 ? (
                          <span className="ds-hint">无已结算样本</span>
                        ) : s.record.settled < 5 ? (
                          <span>
                            {s.record.wins}/{s.record.settled} 中
                            <span className="ds-hint">(样本不足)</span>
                          </span>
                        ) : (
                          <span>
                            {s.record.wins}/{s.record.settled} 中 · 预期{" "}
                            {s.record.implied.toFixed(1)} ·{" "}
                            {s.record.excess >= 0 ? "+" : "−"}
                            {Math.abs(s.record.excess).toFixed(1)}
                            <span className="ds-hint">
                              {Math.abs(s.record.excess) >= 2 * s.record.sd &&
                              s.record.sd > 0
                                ? " 超运气"
                                : " 运气内"}
                            </span>
                          </span>
                        )}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        共 {s.signals.total} · 24h {s.signals.last24h}
                        <div className="ds-hint">
                          最近 {agoText(s.signals.lastEmittedAt)}
                        </div>
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        付费 {s.deliveries.sentPaid} · 公开{" "}
                        {s.deliveries.sentPublic}
                      </td>
                      <td>
                        <button
                          className="ds-btn"
                          disabled={busyId === s.id}
                          aria-pressed={s.pushEnabled}
                          onClick={() => toggle(s.id, !s.pushEnabled)}
                          title={
                            s.pushEnabled
                              ? "点击关闭对外推送"
                              : "点击放开对外推送"
                          }
                        >
                          {busyId === s.id
                            ? "…"
                            : s.pushEnabled
                              ? "🟢 推送中"
                              : "⚪ 已关"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
            最近 20 条台账信号 · 逐通道投递状态
          </div>
          {overview.recent.length === 0 ? (
            <div className="ds-hint">台账暂无信号(followCycle 尚未触发)。</div>
          ) : (
            <div className="ds-table-wrap">
              <table className="ds-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>档位</th>
                    <th>市场</th>
                    <th>方向</th>
                    <th>进</th>
                    <th>结算</th>
                    <th>投递</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.recent.map((r) => (
                    <tr key={r.id}>
                      <td className="ds-hint" style={{ whiteSpace: "nowrap" }}>
                        {timeText(r.emittedAt)}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{r.strategyName}</td>
                      <td
                        style={{
                          maxWidth: 240,
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
                        {r.settled
                          ? r.won === true
                            ? "✅"
                            : r.won === false
                              ? "❌"
                              : "➖"
                          : "持有中"}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {r.channels.length === 0 ? (
                          <span className="ds-hint">未投递</span>
                        ) : (
                          r.channels.map((c) => (
                            <span
                              key={c.channel}
                              className="ds-tag"
                              style={{ marginRight: 4 }}
                              title={c.channel}
                            >
                              {CH_LABEL[c.channel] ??
                                c.channel.replace("webhook:", "wh#")}{" "}
                              {STATUS_LABEL[c.status] ?? c.status}
                            </span>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
