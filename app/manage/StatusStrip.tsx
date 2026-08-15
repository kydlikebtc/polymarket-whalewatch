"use client";

import type { AdminSignalOverview } from "../../lib/adminOverview";
import { StatCard } from "../ui";
import { Dot, type Tone } from "./bits";
import type { HealthReport } from "./HealthSection";

// 顶部状态摘要:标准 KPI strip(section.kpi + StatCard/kpi-value 词汇,与
// 首页/共识页同一范式)。运营者第一眼的七个「现在有没有事」读数,整卡可点
// 跳到对应分区。红点优先级:引擎停跳 > TG 连败 > 投递积压。

const CH_LABEL: Record<string, string> = {
  tg_paid: "付费",
  tg_public: "公开",
};

function KpiCard({
  label,
  value,
  sub,
  tone,
  onClick,
  title,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Tone;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) onClick();
      }}
      title={title}
      style={onClick ? { cursor: "pointer" } : undefined}
    >
      <StatCard label={label}>
        <div
          className="kpi-value"
          style={{
            fontSize: "var(--t-lg)",
            display: "flex",
            alignItems: "center",
            gap: "var(--s-2)",
          }}
        >
          {tone && <Dot tone={tone} />}
          {value}
        </div>
        {sub && <div className="kpi-sub">{sub}</div>}
      </StatCard>
    </div>
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
  const uptimeDays =
    ops?.engineStartedAt != null
      ? Math.max(
          0,
          (Math.floor(Date.now() / 1000) - ops.engineStartedAt) / 86_400,
        ).toFixed(1)
      : null;
  const locked = <span className="muted">—</span>;

  return (
    <section className="kpi" style={{ marginBottom: "var(--s-5)" }}>
      <KpiCard
        label="引擎"
        tone={health == null ? "muted" : health.ok ? "up" : "down"}
        value={health == null ? "…" : health.ok ? "正常" : "停跳"}
        sub={
          health == null
            ? undefined
            : health.ok
              ? uptimeDays != null
                ? `本次进程已运行 ${uptimeDays} 天`
                : undefined
              : (health.staleLoops?.join(" · ") ?? health.reason)
        }
        onClick={() => onJump("health")}
      />
      <KpiCard
        label="Telegram 发送"
        tone={
          ops == null
            ? "muted"
            : ops.tg == null || !ops.tg.failing
              ? "up"
              : "down"
        }
        value={
          ops == null
            ? locked
            : ops.tg?.failing
              ? `连败 ${ops.tg.consecutiveSendFailures}`
              : "正常"
        }
        sub={ops == null ? "需管理令牌" : undefined}
        onClick={() => onJump("health")}
      />
      <KpiCard
        label="投递积压"
        tone={ops == null ? "muted" : pendingTotal > 0 ? "warn" : "up"}
        value={
          ops == null ? (
            locked
          ) : ops.channels.length === 0 ? (
            <span className="muted">无通道</span>
          ) : (
            <span className="num">{pendingTotal}</span>
          )
        }
        sub={
          ops == null
            ? "需管理令牌"
            : pendingTotal > 0
              ? ops.channels
                  .filter((c) => c.pendingEntries > 0)
                  .map((c) => `${CH_LABEL[c.key] ?? c.key} ${c.pendingEntries}`)
                  .join(" · ")
              : "已到点未投出的信号数"
        }
        title="持续 >0 说明投递循环停了或被健康冻结"
        onClick={() => onJump("signals")}
      />
      <KpiCard
        label="24h 信号"
        value={
          ops == null ? (
            locked
          ) : (
            <span className="num">{ops.signalsLast24h}</span>
          )
        }
        sub={ops == null ? "需管理令牌" : "全部档位台账"}
        onClick={() => onJump("signals")}
      />
      <KpiCard
        label="推送档位"
        tone={overview == null ? "muted" : pushedCount > 0 ? "up" : "muted"}
        value={
          overview == null ? (
            locked
          ) : (
            <span className="num">
              {pushedCount}
              <span className="muted"> / {overview.strategies.length}</span>
            </span>
          )
        }
        sub={overview != null && pushedCount === 0 ? "静默积累中" : undefined}
        onClick={() => onJump("signals")}
      />
      <KpiCard
        label="有效 key"
        value={
          ops == null ? locked : <span className="num">{ops.activeKeys}</span>
        }
        sub={ops == null ? "需管理令牌" : undefined}
        onClick={() => onJump("keys")}
      />
      <KpiCard
        label="存证链"
        value={
          ops == null ? (
            locked
          ) : ops.digest.day ? (
            <span className="mono" style={{ fontSize: "var(--t-md)" }}>
              {ops.digest.day}
            </span>
          ) : (
            <span className="muted">未生成</span>
          )
        }
        sub={ops == null ? "需管理令牌" : "每日 sha256 链"}
        onClick={() => onJump("health")}
      />
    </section>
  );
}
