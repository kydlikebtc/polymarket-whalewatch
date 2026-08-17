"use client";

import type { AdminSignalOverview } from "../../lib/adminOverview";
import { StatCard } from "../ui";
import { Dot, SectionHead } from "./bits";
import { agoText } from "./shared";

// 区块:健康度。引擎循环心跳(/api/health,页面统一拉取后传入 —— 与状态条
// 共用同一次请求)+ TG 发送健康/投递通道积压/存证链/备份日(运营概览 ops,
// 以 kpi-card 网格呈现,与站内 KPI 词汇一致)。

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
      <SectionHead
        title="🩺 健康度"
        aside={
          health && (
            <Dot tone={health.ok ? "up" : "down"}>
              <span className="ds-hint">
                {health.ok
                  ? "引擎全部循环正常"
                  : `异常:${
                      health.staleLoops?.length
                        ? `${health.staleLoops.join(", ")} 停跳`
                        : (health.reason ?? health.error ?? "未知")
                    }`}
              </span>
            </Dot>
          )
        }
      />
      {!health ? (
        <div className="ds-empty">加载中…</div>
      ) : (
        health.loops &&
        health.loops.length > 0 && (
          <div className="ds-table-wrap" style={{ marginBottom: "var(--s-4)" }}>
            <table className="ds-table ds-table--compact">
              <thead>
                <tr>
                  <th>循环</th>
                  <th>最近心跳</th>
                  <th className="is-right">停跳阈值</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {health.loops.map((l) => (
                  <tr key={l.loop}>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {LOOP_LABEL[l.loop] ?? l.loop}
                    </td>
                    <td className="num">
                      {l.missing ? (
                        <span className="muted">从未心跳</span>
                      ) : (
                        agoText(l.lastTs)
                      )}
                    </td>
                    <td className="is-right num muted">
                      {Math.round(l.staleAfterSec / 60)} 分钟
                    </td>
                    <td>
                      <Dot tone={l.stale ? "down" : "up"}>
                        {l.stale ? (
                          <span className="down">停跳</span>
                        ) : (
                          <span className="muted">正常</span>
                        )}
                      </Dot>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      {ops ? (
        <div className="kpi">
          <StatCard label="Telegram 发送">
            {ops.tg == null ? (
              <div className="kpi-sub">状态未知(无发送记录)</div>
            ) : ops.tg.failing ? (
              <>
                <div className="kpi-value" style={{ fontSize: "var(--t-lg)" }}>
                  <Dot tone="down">连败 {ops.tg.consecutiveSendFailures}</Dot>
                </div>
                <div className="kpi-sub" title={ops.tg.lastErrorMessage ?? ""}>
                  {ops.tg.lastErrorMessage ?? ""}({agoText(ops.tg.lastErrorAt)})
                </div>
              </>
            ) : (
              <>
                <div className="kpi-value" style={{ fontSize: "var(--t-lg)" }}>
                  <Dot tone="up">正常</Dot>
                </div>
                <div className="kpi-sub">
                  最近成功 {agoText(ops.tg.lastOkAt)}
                </div>
              </>
            )}
          </StatCard>
          <StatCard label="投递通道 · 积压">
            {ops.channels.length === 0 ? (
              <div className="kpi-sub">
                无已配置通道(TG 频道 env 未设且无活跃 webhook)
              </div>
            ) : (
              <div style={{ marginTop: "var(--s-2)" }}>
                {ops.channels.map((c) => (
                  <div
                    key={c.key}
                    className="num"
                    style={{ whiteSpace: "nowrap", lineHeight: 1.7 }}
                  >
                    <Dot tone={c.pendingEntries > 0 ? "warn" : "up"}>
                      {CH_LABEL[c.key] ?? c.key}
                      {c.minEmitAgeSec > 0 &&
                        ` +${Math.round(c.minEmitAgeSec / 60)}min`}
                      <span className="muted"> · 积压 </span>
                      {c.pendingEntries}
                    </Dot>
                  </div>
                ))}
              </div>
            )}
          </StatCard>
          <StatCard label="存证链(每日 digest)">
            {ops.digest.day ? (
              <>
                <div
                  className="kpi-value mono"
                  style={{ fontSize: "var(--t-md)" }}
                >
                  {ops.digest.day}
                </div>
                <div className="kpi-sub mono">
                  链尾 {ops.digest.tail?.slice(0, 12)}…
                </div>
              </>
            ) : (
              <div className="kpi-sub">尚未生成(需已发布信号 + 公开频道)</div>
            )}
          </StatCard>
          <StatCard label="SQLite 每日快照">
            {ops.backupDay ? (
              <div
                className="kpi-value mono"
                style={{ fontSize: "var(--t-md)" }}
              >
                {ops.backupDay}
              </div>
            ) : (
              <div className="kpi-sub">尚未生成</div>
            )}
          </StatCard>
        </div>
      ) : (
        <div className="ds-empty">
          TG 发送/通道积压/存证/备份状态需管理令牌(来自运营概览)。
        </div>
      )}
    </section>
  );
}
