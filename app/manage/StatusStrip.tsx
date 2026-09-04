"use client";

import type { AdminSignalOverview } from "../../lib/adminOverview";
import { StatCard } from "../ui";
import type { HealthReport } from "./HealthSection";

// 顶部状态摘要:两张 KPI 分格卡(设计稿 19「令牌门 + 七读数」)。
//
//   第一排三格 = 现在有没有事(引擎 / TG 发送 / 投递积压);
//   第二排四格 = 台账读数(24h 信号 / 推送档位 / 有效 key / 存证链)。
//
// 分排本身就是那句口径:上排出问题要立刻处理,下排只是「今天产了多少」。
// 每格左侧是 20px emoji 图标位(承担语义),值 18px 常规字重、涨绿跌红只
// 留给真状态,数字不加粗不放大 —— 层级来自 1px 分格线与 12px 大写小标。
// 整格可点,跳到对应分区。

const CH_LABEL: Record<string, string> = {
  tg_paid: "付费",
  tg_public: "公开",
};

function KpiCard({
  label,
  icon,
  value,
  sub,
  valueColor,
  onClick,
  title,
}: {
  label: string;
  icon: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  /** 语义色:绿=正常 · 红=停跳 · 蓝=可点的关键读数。缺省为主文字色。 */
  valueColor?: string;
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
      // grid 让内部 .kpi-card 在两个方向都撑满这一格:否则内容短的格子
      // 底下会露出 .kpi 容器的边框色,变成一条灰带。
      style={{ display: "grid", cursor: onClick ? "pointer" : undefined }}
    >
      <StatCard label={label} icon={icon}>
        <div
          className="kpi-value"
          style={valueColor ? { color: valueColor } : undefined}
        >
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
  // 「—」是判不了(此处:没有管理令牌所以取不到读数),不是零 —— 用 faint,
  // 与真实的 0 严格分家。
  const locked = <span className="faint">—</span>;
  const pendingText =
    ops == null
      ? null
      : ops.channels.length === 0
        ? "无通道"
        : pendingTotal === 0
          ? "0"
          : ops.channels
              .filter((c) => c.pendingEntries > 0)
              .map((c) => `${CH_LABEL[c.key] ?? c.key} ${c.pendingEntries}`)
              .join(" · ");

  return (
    <>
      <section className="kpi" style={{ marginBottom: "var(--s-3)" }}>
        <KpiCard
          label="引擎"
          icon={health == null ? "🩺" : health.ok ? "✅" : "❌"}
          value={health == null ? "…" : health.ok ? "正常" : "停跳"}
          valueColor={
            health == null
              ? undefined
              : health.ok
                ? "var(--ww-up)"
                : "var(--ww-down)"
          }
          sub={
            health == null
              ? "正在读取 /api/health"
              : health.ok
                ? uptimeDays != null
                  ? `已运行 ${uptimeDays} 天`
                  : undefined
                : (health.staleLoops?.join(" · ") ?? health.reason)
          }
          onClick={() => onJump("health")}
        />
        <KpiCard
          label="TG 发送"
          icon="📣"
          value={
            ops == null
              ? locked
              : ops.tg?.failing
                ? `连败 ${ops.tg.consecutiveSendFailures}`
                : "正常"
          }
          valueColor={
            ops == null
              ? undefined
              : ops.tg?.failing
                ? "var(--ww-down)"
                : "var(--ww-up)"
          }
          sub={ops == null ? "需管理令牌" : undefined}
          onClick={() => onJump("health")}
        />
        <KpiCard
          label="投递积压"
          icon="🚚"
          // 积压是成本类读数,不是亏损:短暂 >0 是正常排队,标红会把每一轮
          // 投递都渲染成事故。真正该警觉的是「持续 >0」,那句写在 title 里。
          value={ops == null ? locked : pendingText}
          sub={ops == null ? "需管理令牌" : "已到点未投出的信号数"}
          title="持续 >0 说明投递循环停了或被健康冻结"
          onClick={() => onJump("signals")}
        />
      </section>

      <section className="kpi">
        <KpiCard
          label="24h 信号"
          icon="📜"
          value={
            ops == null ? locked : ops.signalsLast24h.toLocaleString("en-US")
          }
          valueColor={ops == null ? undefined : "var(--ww-link)"}
          sub={ops == null ? "需管理令牌" : "全部档位台账"}
          onClick={() => onJump("signals")}
        />
        <KpiCard
          label="推送档位"
          icon="📈"
          value={
            overview == null ? (
              locked
            ) : (
              <>
                {pushedCount}
                <span className="muted"> / {overview.strategies.length}</span>
              </>
            )
          }
          sub={
            overview == null
              ? "需管理令牌"
              : pushedCount === 0
                ? "静默积累中"
                : "其余静默积累"
          }
          onClick={() => onJump("signals")}
        />
        <KpiCard
          label="有效 key"
          icon="🔑"
          value={ops == null ? locked : ops.activeKeys}
          sub={ops == null ? "需管理令牌" : "已签发且未吊销"}
          onClick={() => onJump("keys")}
        />
        <KpiCard
          label="存证链"
          icon="🔗"
          value={
            ops == null ? (
              locked
            ) : ops.digest.day ? (
              ops.digest.day
            ) : (
              <span className="muted">未生成</span>
            )
          }
          valueColor={
            ops != null && ops.digest.day ? "var(--ww-link)" : undefined
          }
          sub={ops == null ? "需管理令牌" : "每日 sha256 链"}
          onClick={() => onJump("health")}
        />
      </section>

      <div
        className="ds-hint"
        style={{
          display: "flex",
          gap: "var(--s-6)",
          flexWrap: "wrap",
          margin: "10px 0 var(--s-5)",
        }}
      >
        <span>上排三格 = 现在有没有事</span>
        <span>下排四格 = 台账读数</span>
        <span style={{ marginLeft: "auto" }}>整格可点,跳到对应分区</span>
      </div>
    </>
  );
}
