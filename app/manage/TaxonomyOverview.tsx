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
}: {
  overview: AdminSignalOverview | null;
  onJump: (section: string) => void;
}) {
  const pushed =
    overview?.strategies.filter((s) => s.pushEnabled).length ?? null;
  const total = overview?.strategies.length ?? null;
  const lines = [
    {
      no: "①",
      name: "聪明钱动向",
      what: "白名单钱包的真实成交(大额/共识/分歧)",
      manage: "告警引擎的触发条件(金额/方向/价格区间…)",
      dest: "TG 告警频道 · API 拉取(active/settled) · 𝕏 大单/共识帖",
      status: "条件达标即产出,无总开关",
      jump: "rules",
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
      status: "开关与近 24h 产出见 ③",
      jump: "bus",
    },
  ];
  return (
    <section className="ds-card" style={{ marginBottom: "var(--s-5)" }}>
      <SectionHead
        title="🧭 三条信号线"
        hint="与接入文档 §6.1 同一套分类。本表只是地图:管理控件在下方各区块,「可达管线」的接线管理在「下游管线」tab。"
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
                style={{ cursor: "pointer" }}
                title="跳到对应区块"
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
    </section>
  );
}

export function PipelinesOverview({
  overview,
  onJump,
}: {
  overview: AdminSignalOverview | null;
  onJump: (section: string) => void;
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
        hint="信号线(上一个 tab)产出后经这三条管线到达消费者。「承载」列是当前真实接线的转述 —— 引擎改了接线,这里要跟着改。"
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
                style={{ cursor: "pointer" }}
                title="跳到对应区块"
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
