"use client";

import { useEffect, useState } from "react";
import type { AdminSignalOverview } from "../../lib/adminOverview";
import { agoText } from "./shared";

// 区块 2:健康度。引擎循环心跳来自公开的 /api/health(它就是 docker
// healthcheck 用的那个探针);TG 发送健康/存证链/备份日来自运营概览(ops)。

interface LoopStatus {
  loop: string;
  lastTs: number | null;
  ageSec: number | null;
  staleAfterSec: number;
  stale: boolean;
  missing?: boolean;
}

interface HealthReport {
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

export default function HealthSection({
  ops,
}: {
  ops: AdminSignalOverview["ops"] | null;
}) {
  const [report, setReport] = useState<HealthReport | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((j) => setReport(j as HealthReport))
      .catch((e) => setReport({ ok: false, error: String(e) }));
  }, []);

  return (
    <section className="ds-card" style={{ marginBottom: "var(--s-5)" }}>
      <h2 style={{ fontSize: "var(--t-lg)", marginBottom: "var(--s-1)" }}>
        🩺 健康度
      </h2>
      {!report ? (
        <div className="ds-hint">加载中…</div>
      ) : (
        <>
          <div style={{ marginBottom: "var(--s-3)" }}>
            {report.ok ? (
              <span className="ds-tag">🟢 引擎全部循环正常</span>
            ) : (
              <span className="ds-tag">
                🔴 异常
                {report.staleLoops?.length
                  ? `:${report.staleLoops.join(", ")} 停跳`
                  : `:${report.reason ?? report.error ?? "未知"}`}
              </span>
            )}
          </div>
          {report.loops && report.loops.length > 0 && (
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
                  {report.loops.map((l) => (
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
          TG 发送/存证/备份状态需管理令牌(来自运营概览)。
        </div>
      )}
    </section>
  );
}
