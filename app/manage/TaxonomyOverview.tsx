"use client";

import type { AdminSignalOverview } from "../../lib/adminOverview";
import { SectionHead } from "./bits";

// /manage 的两块「地图」面板 —— 信息架构重排(2026-08-19)的骨架:
//
//   第一步:产什么信号 —— 三条信号线(与 docs/api-access.md §6.1 同一套
//           分类:聪明钱动向 / 策略买入信号 / 原始信号总线);
//   第二步:投给谁 —— 下游管线(Telegram / API key + webhook / 𝕏 播报)。
//
// 此前五个 tab 把两层揉在一起:「推送与提醒」里同时住着策略开关、总线开关
// 和 TG 告警条件,「接入」「TG 推送」「𝕏」又各自为政 —— 运营者没有一张图
// 回答「这条信号最终会到谁手里」。这两块面板就是那张图:只做**分类 + 映射
// + 跳转**,不搬任何管理控件(控件留在各区块,一处实现)。
//
// 映射表是**代码事实的转述**,不是愿景:每行「可达管线」都对应真实接线
// (alertEngine→TG/𝕏、runDeliveryCycle→TG 信号频道+webhook、
// runBusWebhookCycle→webhook、/api/signals→拉取)。改了接线要改这里。

export function SignalLinesOverview({
  overview,
  onJump,
  active,
}: {
  overview: AdminSignalOverview | null;
  onJump: (section: string) => void;
  /** 当前展开的子 tab —— 表里高亮对应行,让地图和视口互相咬合。 */
  active?: string;
}) {
  const pushed =
    overview?.strategies.filter((s) => s.pushEnabled).length ?? null;
  const total = overview?.strategies.length ?? null;
  const lines = [
    {
      no: "①",
      name: "聪明钱动向",
      // 定义与接入文档 §6.4 逐字对齐:三种 kind,规则固定。
      what: "共识(≥2 白名单同向) · 分歧(两侧都有) · 单笔大额(白名单单笔 ≥$50k),按市场×方向折叠",
      manage: "判据固定,无开关;台账与去向见子 tab。进料条件在 🅐",
      dest: "TG 告警频道 · API 拉取(active/settled) · 𝕏 大单/共识帖 · webhook 经 ③",
      status: "规则常量,不随配置漂移",
      jump: "moves",
    },
    {
      no: "②",
      name: "策略买入信号",
      what: "19 档纸面策略的买入触发(strategy_signals 台账)",
      manage: "逐档推送开关(默认全关,按战绩放开)",
      dest: "TG 信号频道(付费+公开延迟) · API strategies 段 · webhook · 𝕏 战报",
      status:
        pushed != null && total != null
          ? `推送中 ${pushed} / ${total} 档`
          : "…",
      jump: "signals",
    },
    {
      no: "③",
      name: "原始信号总线",
      what: "全站原始事件的流水(bus_signals 台账)",
      manage: "逐类型开关 + 阈值(默认全关)",
      dest: "API bus[] · webhook(端点勾选类型)",
      status: "默认全关;开关与近 24h 产出见子 tab",
      jump: "bus",
    },
  ];
  return (
    <section className="ds-card" style={{ marginBottom: "var(--s-5)" }}>
      <SectionHead
        title="🧭 三条信号线"
        hint="与接入文档 §6.1 同一套分类。本表是地图:点行切换下方子 tab;「可达管线」的接线管理在「下游管线」tab。"
      />
      <div className="ds-table-wrap">
        <table className="ds-table ds-table--compact">
          <thead>
            <tr>
              <th>信号线</th>
              <th>是什么</th>
              <th>在这页管什么</th>
              <th>可达管线</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr
                key={l.no}
                role="button"
                tabIndex={0}
                style={{
                  cursor: "pointer",
                  background: active === l.jump ? "var(--brand-50)" : undefined,
                }}
                title="切换到该子模块"
                onClick={() => onJump(l.jump)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onJump(l.jump);
                }}
              >
                <td style={{ whiteSpace: "nowrap", fontWeight: 500 }}>
                  {l.no} {l.name}
                </td>
                <td>{l.what}</td>
                <td>{l.manage}</td>
                <td className="ds-hint">{l.dest}</td>
                <td className="ds-hint" style={{ whiteSpace: "nowrap" }}>
                  {l.status}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
        ① 与 ③ 的区别 = <b>状态 vs 事件</b>:①回答「现在该看什么」(折叠
        快照,共识升级原地更新,给页面渲染);③回答「刚刚发生了什么」(逐条
        不可变、有稳定 id,因此可推送 —— 触发语义只有 ③ 承担)。同一批
        alerts 的两种形态,不会矛盾也不会双写;坑只有重复计数:同一共识组
        每次升级在 ③ 里是新事件,数个数要按市场×方向归并或直接用 ①。
      </div>
    </section>
  );
}

export function PipelinesOverview({
  overview,
  onJump,
  active,
}: {
  overview: AdminSignalOverview | null;
  onJump: (section: string) => void;
  active?: string;
}) {
  const keys = overview?.ops.activeKeys ?? null;
  const tgOk = overview?.ops.tg;
  const pipes = [
    {
      no: "🅐",
      name: "Telegram",
      carries:
        "① 告警频道(env) · ② 信号频道(付费实时 + 公开延迟) · 多目标(tg_targets,按类型分发)",
      manage: "bot+频道组合的增删改/暂停,按类型分发",
      status:
        tgOk == null
          ? "无发送记录"
          : tgOk.failing
            ? `连败 ${tgOk.consecutiveSendFailures}`
            : "正常",
      jump: "tg",
    },
    {
      no: "🅑",
      name: "API key + webhook",
      carries:
        "拉取:①②③ 全部(按 key 订阅范围/tier) · webhook 推送:② 策略 + ③ 总线(端点勾选)",
      manage: "key 签发/吊销(范围+tier),端点登记/测试/熔断恢复",
      status: keys != null ? `有效 key ${keys}` : "…",
      jump: "keys",
    },
    {
      no: "🅒",
      name: "𝕏 播报",
      carries:
        "① 大单/共识帖 · ② 战报 · 赛前聚合 · 周报(公共获客,非订阅方管线)",
      manage: "授权账号主备/内容类型开关/发帖历史",
      status: "见区块内",
      jump: "x",
    },
  ];
  return (
    <section className="ds-card" style={{ marginBottom: "var(--s-5)" }}>
      <SectionHead
        title="🚚 下游管线"
        hint="信号线(上一个 tab)产出后经这三条管线到达消费者。点行切换下方子 tab。「承载」列是当前真实接线的转述 —— 引擎改了接线,这里要跟着改。"
      />
      <div className="ds-table-wrap">
        <table className="ds-table ds-table--compact">
          <thead>
            <tr>
              <th>管线</th>
              <th>承载哪些信号</th>
              <th>在这页管什么</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {pipes.map((p) => (
              <tr
                key={p.no}
                role="button"
                tabIndex={0}
                style={{
                  cursor: "pointer",
                  background: active === p.jump ? "var(--brand-50)" : undefined,
                }}
                title="切换到该子模块"
                onClick={() => onJump(p.jump)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onJump(p.jump);
                }}
              >
                <td style={{ whiteSpace: "nowrap", fontWeight: 500 }}>
                  {p.no} {p.name}
                </td>
                <td className="ds-hint">{p.carries}</td>
                <td>{p.manage}</td>
                <td className="ds-hint" style={{ whiteSpace: "nowrap" }}>
                  {p.status}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** /api/admin/signals GET 附带的路由开关态(见 route 的 buildRouting)。 */
export interface RoutingState {
  alertPush: boolean;
  xKinds: Record<string, boolean>;
  tgTargetKinds: Record<string, number>;
  webhookTypes: Record<string, number>;
}

/**
 * 路由矩阵:信号线 × 管线,每格显示当前状态并点击直达**属主开关**所在的
 * 子模块。刻意不造第二套路由配置存储 —— 每个开关只有一个属主(告警总开关
 * 在 alert-config、𝕏 在 x_broadcast_kinds、总线在 bus_signal_settings、
 * webhook 在端点勾选),矩阵只是把它们拼成一张可导航的图。造第二套意味着
 * 两处状态互相追赶,那正是本次重排要消灭的「乱糟糟」。
 */
export function RoutingMatrix({
  routing,
  busSettings,
  channels,
  onJump,
}: {
  routing: RoutingState | null;
  busSettings: Record<string, { enabled: boolean }> | null;
  /** ops.channels(已配置的投递通道键:tg_paid/tg_public/webhook:N)。 */
  channels: { key: string }[] | null;
  onJump: (section: string) => void;
}) {
  if (!routing) return null;
  const on = (b: boolean) => (b ? "开" : "关");
  const tgSignal =
    channels?.some((c) => c.key === "tg_paid" || c.key === "tg_public") ??
    false;
  const busOn = (t: string) => busSettings?.[t]?.enabled === true;
  const wh = (t: string) => routing.webhookTypes[t] ?? 0;
  const tgt = (k: string) => routing.tgTargetKinds[k] ?? 0;
  const rows: {
    line: string;
    cells: { text: string; jump: string | null }[];
  }[] = [
    {
      line: "① 聪明钱动向",
      cells: [
        {
          text: `告警频道 ${on(routing.alertPush)} · 目标 大额${tgt("large")}/共识${tgt("consensus")}`,
          jump: "rules",
        },
        { text: "恒开(active/settled)", jump: "keys" },
        {
          text: `经 ③:共识${on(busOn("consensus"))} 大额${on(busOn("large"))} · 端点 ${wh("consensus")}/${wh("large")}`,
          jump: "bus",
        },
        {
          text: `大单 ${on(routing.xKinds.whale === true)} · 共识 ${on(routing.xKinds.consensus === true)}`,
          jump: "x",
        },
      ],
    },
    {
      line: "② 策略信号",
      cells: [
        {
          text: `信号频道 ${tgSignal ? "已配" : "未配"} · 目标 ${tgt("strategy")}`,
          jump: "tg",
        },
        { text: "恒开(strategies,按 key 范围)", jump: "keys" },
        { text: `端点 ${wh("strategy")} 个勾选`, jump: "keys" },
        {
          text: `战报 ${on(routing.xKinds.settled === true)}`,
          jump: "x",
        },
      ],
    },
    {
      line: "③ 原始总线",
      cells: [
        { text: "不接 TG(设计如此)", jump: null },
        {
          text: `bus[]:大额${on(busOn("large"))} 共识${on(busOn("consensus"))} 发现${on(busOn("discovery"))}`,
          jump: "bus",
        },
        {
          text: `端点 大额${wh("large")}/共识${wh("consensus")}/发现${wh("discovery")}`,
          jump: "keys",
        },
        { text: "不接 𝕏(设计如此)", jump: null },
      ],
    },
  ];
  return (
    <section className="ds-card" style={{ marginBottom: "var(--s-5)" }}>
      <SectionHead
        title="🗺 路由矩阵(线 × 管线)"
        hint="每格显示当前开关态,点击直达属主开关。矩阵不另存配置 —— 每个开关只有一个属主,这里只是拼图。"
      />
      <div className="ds-table-wrap">
        <table className="ds-table ds-table--compact">
          <thead>
            <tr>
              <th>信号线</th>
              <th>🅐 Telegram</th>
              <th>🅑 API 拉取</th>
              <th>🅑 webhook</th>
              <th>🅒 𝕏</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.line}>
                <td style={{ whiteSpace: "nowrap", fontWeight: 500 }}>
                  {r.line}
                </td>
                {r.cells.map((c, i) => (
                  <td key={i} style={{ whiteSpace: "nowrap" }}>
                    {c.jump ? (
                      <button
                        className="ds-btn ds-btn--subtle ds-btn--sm"
                        onClick={() => onJump(c.jump!)}
                        title="打开属主开关所在的子模块"
                      >
                        {c.text}
                      </button>
                    ) : (
                      <span className="muted">{c.text}</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
