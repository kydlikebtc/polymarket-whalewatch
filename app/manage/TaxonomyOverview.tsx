"use client";

import type { AdminSignalOverview } from "../../lib/adminOverview";
import { Foldable } from "./bits";
import { busTypeEnabled, type BusDefLike } from "./routing";

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
      name: "原始事件信号",
      what: "大额成交 / 聪明钱共识 / 钱包发现(+待接入:分歧/拆单/赛前)",
      manage: "总线逐类型开关+阈值;大额/共识的进料闸在 🅐 告警条件",
      dest: "TG 告警 · 𝕏 大单/共识帖 · webhook · API bus[]",
      status: "事件:触发即发出,不可变,有稳定 id",
      jump: "events",
      isView: false,
    },
    {
      no: "②",
      name: "策略信号",
      what: "19 档纸面策略的买入/结算事件(strategy_signals 台账)",
      manage: "逐档推送开关(默认全关,按战绩放开)",
      dest: "TG 信号频道(付费+公开延迟) · API strategies 段 · webhook · 𝕏 战报",
      status:
        pushed != null && total != null
          ? `推送中 ${pushed} / ${total} 档`
          : "…",
      jump: "signals",
      isView: false,
    },
    {
      no: "👁",
      name: "视图(非信号)",
      what: "active[]/settled[](① 的折叠) · record30d · strategies 段",
      manage: "无 —— 折叠规则是固定常量,数据请求时现算",
      dest: "不适用:视图无管线,想被推送订阅 ① 或 ②",
      status: "状态:回答「现在该看什么」",
      jump: "views",
      isView: true,
    },
    {
      no: "🎯",
      name: "按需查询(非信号)",
      what: "市场深度卡:调用方点名一个市场,现算一份全景(/api/market-card)",
      manage: "上游预算 / 新鲜期 / 陈旧闸 / 工作集上限(在 🚚 下游管线)",
      dest: "不适用:无管线可推 —— 它是拉取,不是推送",
      status: "状态:全站唯一**会打上游**的对外端点,故有预算与 429 背压",
      jump: "card",
      isView: true,
    },
  ];
  return (
    <Foldable
      storageKey="manageGuideLines"
      title="🧭 对外产出 = 信号（两条线）+ 视图 + 按需查询"
      hint="信号=事件(触发后发出,管线只挂在事件上);视图=事件的折叠;按需查询=调用方点名、现算的答案 —— 后两者都非信号,无管线可挂。点行切换下方子 tab;接线管理在「下游管线」tab。"
      summary={`① 原始事件(大额/共识/发现)　·　② 策略 ${
        pushed != null && total != null ? `推送中 ${pushed}/${total} 档` : "…"
      }　·　👁 视图　·　🎯 按需查询`}
    >
      <div className="ds-table-wrap">
        <table className="ds-table ds-table--compact">
          <thead>
            <tr>
              <th>产出</th>
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
                <td
                  style={{
                    whiteSpace: "nowrap",
                    fontWeight: 500,
                    opacity: l.isView ? 0.75 : undefined,
                  }}
                >
                  {l.no} {l.name}
                </td>
                <td style={{ opacity: l.isView ? 0.75 : undefined }}>
                  {l.what}
                </td>
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
        判据一句话:<b>触发后发出的才是信号</b>。事件不可变、有稳定 id,
        管线(TG/𝕏/webhook/API)只挂在事件上;视图是事件的折叠,同一共识组
        升级时原地更新 —— 把每条升级事件当独立信号计数是唯一的坑,视图已
        替你折叠好(事件做触发、视图做渲染)。
      </div>
    </Foldable>
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
        "① 大单/共识帖 · ② 战报 + 每日战报榜 · 赛前聚合 · 周报(公共获客,非订阅方管线)",
      manage: "授权账号主备/内容类型开关/发帖历史",
      status: "见区块内",
      jump: "x",
    },
  ];
  return (
    <Foldable
      storageKey="manageGuidePipes"
      title="🚚 下游管线"
      hint="信号线(上一个 tab)产出后经这三条管线到达消费者。点行切换下方子 tab。「承载」列是当前真实接线的转述 —— 引擎改了接线,这里要跟着改。"
      summary={`🅐 Telegram ${
        tgOk == null
          ? "无发送记录"
          : tgOk.failing
            ? `连败 ${tgOk.consecutiveSendFailures}`
            : "正常"
      }　·　🅑 有效 key ${keys ?? "…"}　·　🅒 𝕏 播报`}
    >
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
    </Foldable>
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
  busDefs,
  channels,
  onJump,
}: {
  routing: RoutingState | null;
  /**
   * 信号定义 —— **唯一真相**。这里曾经收的是 legacy 的 busSettings,而那份
   * 配置早已「不再参与任何判定」,新 UI 的 defAction 也不回写它:启用了一档,
   * 矩阵却照旧显示「关」。见 ./routing.ts。
   */
  busDefs: BusDefLike[] | null;
  /** ops.channels(已配置的投递通道键:tg_paid/tg_public/webhook:N)。 */
  channels: { key: string }[] | null;
  onJump: (section: string) => void;
}) {
  if (!routing) return null;
  const on = (b: boolean) => (b ? "开" : "关");
  const tgSignal =
    channels?.some((c) => c.key === "tg_paid" || c.key === "tg_public") ??
    false;
  const busOn = (t: string) => busTypeEnabled(busDefs, t);
  const wh = (t: string) => routing.webhookTypes[t] ?? 0;
  const tgt = (k: string) => routing.tgTargetKinds[k] ?? 0;
  const rows: {
    line: string;
    cells: { text: string; jump: string | null }[];
  }[] = [
    {
      line: "① 大额成交",
      cells: [
        {
          text: `告警 ${on(routing.alertPush)} · 目标 ${tgt("large")}`,
          jump: "rules",
        },
        { text: `bus[] ${on(busOn("large"))}`, jump: "events" },
        {
          text: `总线${on(busOn("large"))} · 端点 ${wh("large")}`,
          jump: "events",
        },
        { text: `大单帖 ${on(routing.xKinds.whale === true)}`, jump: "x" },
      ],
    },
    {
      line: "① 聪明钱共识",
      cells: [
        { text: `频道即发 · 目标 ${tgt("consensus")}`, jump: "tg" },
        { text: `bus[] ${on(busOn("consensus"))}`, jump: "events" },
        {
          text: `总线${on(busOn("consensus"))} · 端点 ${wh("consensus")}`,
          jump: "events",
        },
        {
          text: `共识帖 ${on(routing.xKinds.consensus === true)}`,
          jump: "x",
        },
      ],
    },
    {
      line: "① 钱包发现",
      cells: [
        { text: "不接 TG(设计如此)", jump: null },
        { text: `bus[] ${on(busOn("discovery"))}`, jump: "events" },
        {
          text: `总线${on(busOn("discovery"))} · 端点 ${wh("discovery")}`,
          jump: "events",
        },
        { text: "不接 𝕏(设计如此)", jump: null },
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
          text: `战报 ${on(routing.xKinds.settled === true)} · 战报榜 ${on(
            routing.xKinds.scorecard === true,
          )}`,
          jump: "x",
        },
      ],
    },
  ];
  return (
    <Foldable
      storageKey="manageGuideMatrix"
      title="🗺 路由矩阵(事件类型 × 管线)"
      hint="每格显示当前开关态,点击直达属主开关。矩阵不另存配置 —— 每个开关只有一个属主,这里只是拼图。"
      summary="信号线 × 管线的当前接线一览"
      // 它是状态仪表盘不是教学,默认展开;熟了的运营者可以自己收起来。
      defaultOpen
    >
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
    </Foldable>
  );
}
