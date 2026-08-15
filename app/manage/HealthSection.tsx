"use client";

import type { AdminSignalOverview } from "../../lib/adminOverview";
import { agoText } from "./shared";

// 区块:健康度。引擎循环心跳(/api/health,页面统一拉取后传入 —— 与状态条
// 共用同一次请求)+ TG 发送健康/投递通道积压/存证链/备份日(运营概览 ops)。

interface LoopStatus {
  loop: string;
  lastTs: number | null;
  ageSec: number | null;
  staleAfterSec: number;
  stale: boolean;
  missing?: boolean;
}

export interface HealthReport {
  ok: boolean;
  loops?: LoopStatus[];
  staleLoops?: string[];
  reason?: string;
  error?: string;
}

const LOOP_LABEL: Record<string, string> = {
  alert: "告警(4s)",
  consensus: "共识+跟单(5min)",
  outcome_backfill: "验证回填(10min)",
  delivery: "信号投递(30s)",
};

const CH_LABEL: Record<string, string> = {
  tg_paid: "付费频道(实时)",
  tg_public: "公开频道(延迟)",
};

export default function HealthSection({
  health,
  ops,
}: {
  health: HealthReport | null;
  ops: AdminSignalOverview["ops"] | null;
}) {
  return (
    <section
      id="health"
      className="ds-card"
      style={{ marginBottom: "var(--s-5)", scrollMarginTop: "var(--s-6)" }}
    >
      <h2 style={{ fontSize: "var(--t-lg)", marginBottom: "var(--s-1)" }}>
        🩺 健康度
      </h2>
      {!health ? (
        <div className="ds-hint">加载中…</div>
      ) : (
        <>
          <div style={{ marginBottom: "var(--s-3)" }}>
            {health.ok ? (
              <span className="ds-tag">🟢 引擎全部循环正常</span>
            ) : (
              <span className="ds-tag">
                🔴 异常
                {health.staleLoops?.length
                  ? `:${health.staleLoops.join(", ")} 停跳`
                  : `:${health.reason ?? health.error ?? "未知"}`}
              </span>
            )}
          </div>
          {health.loops && health.loops.length > 0 && (
            <div
              className="ds-table-wrap"
              style={{ marginBottom: "var(--s-3)" }}
            >
              <table className="ds-table">
                <thead>
                  <tr>
                    <th>循环</th>
                    <th>最近心跳</th>
                    <th>停跳阈值</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {health.loops.map((l) => (
                    <tr key={l.loop}>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {LOOP_LABEL[l.loop] ?? l.loop}
                      </td>
                      <td>{l.missing ? "从未心跳" : agoText(l.lastTs)}</td>
                      <td className="ds-hint">
                        {Math.round(l.staleAfterSec / 60)} 分钟
                      </td>
                      <td>{l.stale ? "🔴 停跳" : "🟢"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {ops && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: "var(--s-3)",
          }}
        >
          <div>
            <div className="ds-label">Telegram 发送</div>
            {ops.tg == null ? (
              <div className="ds-hint">状态未知(无发送记录)</div>
            ) : ops.tg.failing ? (
              <div>
                🔴 连续失败 {ops.tg.consecutiveSendFailures} 次
                <div className="ds-hint" title={ops.tg.lastErrorMessage ?? ""}>
                  {ops.tg.lastErrorMessage ?? ""}({agoText(ops.tg.lastErrorAt)})
                </div>
              </div>
            ) : (
              <div>
                🟢 正常
                <div className="ds-hint">
                  最近成功 {agoText(ops.tg.lastOkAt)}
                </div>
              </div>
            )}
          </div>
          <div>
            <div className="ds-label">投递通道 · 积压</div>
            {ops.channels.length === 0 ? (
              <div className="ds-hint">
                无已配置通道(TG 频道 env 未设且无活跃 webhook)
              </div>
            ) : (
              ops.channels.map((c) => (
                <div key={c.key} style={{ whiteSpace: "nowrap" }}>
                  {c.pendingEntries > 0 ? "🔴" : "🟢"}{" "}
                  {CH_LABEL[c.key] ?? c.key}
                  {c.minEmitAgeSec > 0 &&
                    ` +${Math.round(c.minEmitAgeSec / 60)}min`}{" "}
                  · 积压 {c.pendingEntries}
                </div>
              ))
            )}
          </div>
          <div>
            <div className="ds-label">存证链(每日 digest)</div>
            {ops.digest.day ? (
              <div>
                最近 {ops.digest.day}
                <div className="ds-hint">
                  链尾 <code>{ops.digest.tail?.slice(0, 12)}…</code>
                </div>
              </div>
            ) : (
              <div className="ds-hint">尚未生成(需已发布信号 + 公开频道)</div>
            )}
          </div>
          <div>
            <div className="ds-label">SQLite 每日快照</div>
            {ops.backupDay ? (
              <div>最近 {ops.backupDay}</div>
            ) : (
              <div className="ds-hint">尚未生成</div>
            )}
          </div>
        </div>
      )}
      {!ops && (
        <div className="ds-hint">
          TG 发送/通道积压/存证/备份状态需管理令牌(来自运营概览)。
        </div>
      )}
    </section>
  );
}
