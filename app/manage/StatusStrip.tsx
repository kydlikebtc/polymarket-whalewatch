"use client";

import type { AdminSignalOverview } from "../../lib/adminOverview";
import type { HealthReport } from "./HealthSection";

// 顶部状态摘要条:运营者打开页面的第一眼 —— 六个「现在有没有事」的读数,
// 每个 chip 可点击跳到对应分区。红点优先级:引擎停跳 > TG 连败 > 投递积压。
// 无令牌时只有引擎位有数据(公开探针),其余显示待令牌。

const CH_LABEL: Record<string, string> = {
  tg_paid: "付费",
  tg_public: "公开",
};

function Chip({
  tone,
  label,
  value,
  onClick,
  title,
}: {
  tone: "ok" | "warn" | "muted";
  label: string;
  value: string;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      className="ds-btn"
      onClick={onClick}
      title={title}
      style={{
        display: "inline-flex",
        gap: 6,
        alignItems: "baseline",
        borderColor: tone === "warn" ? "var(--warn-700, #b45309)" : undefined,
      }}
    >
      <span className="ds-hint">{label}</span>
      <span style={{ fontWeight: 600 }}>
        {tone === "ok" ? "🟢" : tone === "warn" ? "🔴" : "◽"} {value}
      </span>
    </button>
  );
}

export default function StatusStrip({
  health,
  overview,
  onJump,
}: {
  health: HealthReport | null;
  overview: AdminSignalOverview | null;
  onJump: (id: string) => void;
}) {
  const ops = overview?.ops ?? null;
  const pendingTotal =
    ops?.channels.reduce((s, c) => s + c.pendingEntries, 0) ?? 0;
  const pushedCount =
    overview?.strategies.filter((s) => s.pushEnabled).length ?? 0;
  const uptime =
    ops?.engineStartedAt != null
      ? `${Math.max(0, (Math.floor(Date.now() / 1000) - ops.engineStartedAt) / 86_400).toFixed(1)}天`
      : null;

  return (
    <div
      style={{
        display: "flex",
        gap: "var(--s-2)",
        flexWrap: "wrap",
        marginBottom: "var(--s-4)",
      }}
      aria-label="系统状态摘要"
    >
      <Chip
        tone={health == null ? "muted" : health.ok ? "ok" : "warn"}
        label="引擎"
        value={
          health == null
            ? "…"
            : health.ok
              ? `正常${uptime ? ` · ${uptime}` : ""}`
              : `停跳 ${health.staleLoops?.join(",") || ""}`
        }
        title={uptime ? `本次进程已运行 ${uptime}` : undefined}
        onClick={() => onJump("health")}
      />
      <Chip
        tone={
          ops == null
            ? "muted"
            : ops.tg == null || !ops.tg.failing
              ? "ok"
              : "warn"
        }
        label="TG发送"
        value={
          ops == null
            ? "待令牌"
            : ops.tg?.failing
              ? `连败 ${ops.tg.consecutiveSendFailures}`
              : "正常"
        }
        onClick={() => onJump("health")}
      />
      <Chip
        tone={ops == null ? "muted" : pendingTotal > 0 ? "warn" : "ok"}
        label="投递积压"
        value={
          ops == null
            ? "待令牌"
            : ops.channels.length === 0
              ? "无通道"
              : `${pendingTotal}${
                  pendingTotal > 0
                    ? `(${ops.channels
                        .filter((c) => c.pendingEntries > 0)
                        .map(
                          (c) =>
                            `${CH_LABEL[c.key] ?? c.key} ${c.pendingEntries}`,
                        )
                        .join(" · ")})`
                    : ""
                }`
        }
        title="已到点却未投出的信号数 —— 持续 >0 说明投递循环停了或被健康冻结"
        onClick={() => onJump("signals")}
      />
      <Chip
        tone="muted"
        label="24h 信号"
        value={ops == null ? "待令牌" : String(ops.signalsLast24h)}
        onClick={() => onJump("signals")}
      />
      <Chip
        tone={pushedCount > 0 ? "ok" : "muted"}
        label="推送档位"
        value={
          overview == null
            ? "待令牌"
            : `${pushedCount}/${overview.strategies.length}`
        }
        onClick={() => onJump("signals")}
      />
      <Chip
        tone="muted"
        label="有效 key"
        value={ops == null ? "待令牌" : String(ops.activeKeys)}
        onClick={() => onJump("keys")}
      />
      <Chip
        tone="muted"
        label="存证"
        value={ops == null ? "待令牌" : (ops.digest.day ?? "未生成")}
        onClick={() => onJump("health")}
      />
    </div>
  );
}
