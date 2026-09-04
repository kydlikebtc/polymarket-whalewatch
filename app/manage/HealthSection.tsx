"use client";

import Link from "next/link";
import type { AdminSignalOverview } from "../../lib/adminOverview";
import { loopMeta } from "../loopMeta";
import { StatCard, Tag } from "../ui";
import { Dot, SectionHead } from "./bits";
import { reconcileCardView } from "./reconcileView";
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

// 循环名走共享的 app/loopMeta —— 这里和公开状态页 /status 各维护一份时,
// 引擎新加的循环(delivery 就是后加的)总有一处会漏改成裸 key。
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
  // 结算对账卡的色/句由纯函数决定(./reconcileView,有测试);这里只负责摆。
  const reconcile = ops ? reconcileCardView(ops.settlementReconcile) : null;
  return (
    <section
      id="health"
      className="ds-card"
      style={{
        marginBottom: "var(--s-5)",
        padding: "var(--s-5)",
        scrollMarginTop: "var(--s-6)",
      }}
    >
      <SectionHead
        title="🩺 健康度"
        hint={
          // 「心跳/停跳阈值是什么」已写在下方两个列头的 title 里(设计系统的
          // (?) 提示那套做法),这里只留读数来源与那条公开出口。
          <>
            {"这份读数与订阅方看到的是同一份(同一次 /api/health) —— "}
            <Link href="/status">公开状态页 →</Link>
          </>
        }
        aside={
          health &&
          (health.ok ? (
            <Tag variant="up">✅ 全部循环正常</Tag>
          ) : health.staleLoops?.length ? (
            // 徽章是 22px 定高 + nowrap 的,只装得下状态词:停跳的是哪几个循环
            // 由下方表格的「状态」列逐行说,这里只报个数。此前这里塞的是
            // staleLoops.join() / reason / error —— 后两者是 61 字符的英文长句
            // 与 SQLite 报错原文,会把徽章横向撑出卡片。
            <Tag variant="down">{health.staleLoops.length} 个循环停跳</Tag>
          ) : (
            <Tag variant="down">异常</Tag>
          ))
        }
      />
      {/* 服务端的原话(reason / error)是长文,归说明位不归徽章 —— 红色说明条
          能换行,也能完整显示 SQLite 的报错。 */}
      {health && !health.ok && (health.reason || health.error) && (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-4)", overflowWrap: "anywhere" }}
        >
          {health.reason ?? health.error}
        </div>
      )}
      {!health ? (
        <div className="ds-empty">
          {"还没拿到 /api/health 的回应。"}
          <div style={{ marginTop: "var(--s-2)" }}>
            {"持续空白通常是引擎进程没起来 —— "}
            <Link href="/status">公开状态页 →</Link>
          </div>
        </div>
      ) : !health.loops || health.loops.length === 0 ? (
        // 「引擎从没跑过」正是最该说清的一屏 —— 此前这里整块求值成 false,
        // 表格区域什么都不渲染,只剩区块头那枚红徽章。
        <div className="ds-empty" style={{ marginBottom: "var(--s-4)" }}>
          {"这份回应里没有任何循环心跳。"}
          <div style={{ marginTop: "var(--s-2)" }}>
            {
              "引擎每轮成功跑完才写心跳 —— 一条都没有,通常是进程没起来,或它跑的不是这个库。"
            }
            <Link href="/status">公开状态页 →</Link>
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: "var(--s-4)", overflowX: "auto" }}>
          <table className="ds-table">
            {/* 有口径的列头把口径写进 title —— 设计系统里那枚 (?) 提示的
                文字部分,鼠标停住即读,不占列宽。 */}
            <thead>
              <tr>
                <th>循环</th>
                <th title="引擎上一次给这个循环写心跳的时刻">最近心跳</th>
                <th
                  className="is-right"
                  title="超过这个时长还没写心跳,该循环判停跳"
                >
                  停跳阈值
                </th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {health.loops.map((l) => (
                <tr key={l.loop}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {loopMeta(l.loop).label}
                    <span className="muted"> · {loopMeta(l.loop).cadence}</span>
                  </td>
                  {/* data-label 是窄屏堆叠卡的行首标签(表头此时只留给读屏)。
                      首列循环名不带 label —— 它在堆叠态是卡头。 */}
                  <td data-label="最近心跳">
                    {l.missing ? (
                      // 「从未心跳」是判不了,不是 0 分钟前 —— 用 faint 与
                      // 真实读数分家。
                      <span className="faint">从未心跳</span>
                    ) : (
                      agoText(l.lastTs)
                    )}
                  </td>
                  {/* 阈值是参数不是读数 —— 压到 muted,让「最近心跳」与
                      状态徽章占住注意力。 */}
                  <td className="is-right" data-label="停跳阈值">
                    <span className="muted">
                      {Math.round(l.staleAfterSec / 60)} 分钟
                    </span>
                  </td>
                  {/* 行没有任何行级强调:停跳的行不整行染红,只换徽章。 */}
                  <td data-label="状态">
                    {l.stale ? (
                      <Tag variant="down">停跳</Tag>
                    ) : (
                      <Tag variant="up">正常</Tag>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ops ? (
        // KPI 分格卡此处住在一张卡里,去掉它自己的投影 —— 卡中卡会让这排
        // 读数看起来像另一块内容,而它是本区块的下半截。1px 边框与分格线
        // 已经够分层了。
        <div className="kpi" style={{ boxShadow: "none" }}>
          <StatCard label="Telegram 发送" icon="📣">
            {ops.tg == null ? (
              <>
                <div
                  className="kpi-value"
                  style={{ color: "var(--ww-text-faint)" }}
                >
                  —
                </div>
                <div className="kpi-sub">状态未知(无发送记录)</div>
              </>
            ) : ops.tg.failing ? (
              <>
                <div className="kpi-value" style={{ color: "var(--ww-down)" }}>
                  连败 {ops.tg.consecutiveSendFailures}
                </div>
                <div
                  className="kpi-sub"
                  title={ops.tg.lastErrorMessage ?? ""}
                  style={{ overflowWrap: "anywhere" }}
                >
                  {ops.tg.lastErrorMessage ?? ""}({agoText(ops.tg.lastErrorAt)})
                </div>
              </>
            ) : (
              <>
                <div className="kpi-value" style={{ color: "var(--ww-up)" }}>
                  正常
                </div>
                <div className="kpi-sub">
                  最近成功 {agoText(ops.tg.lastOkAt)}
                </div>
              </>
            )}
          </StatCard>
          <StatCard label="投递通道 · 积压" icon="🚚">
            {ops.channels.length === 0 ? (
              <>
                <div
                  className="kpi-value"
                  style={{ color: "var(--ww-text-faint)" }}
                >
                  —
                </div>
                {/* 成因(env 未设频道且无活跃 webhook)写在下方那条琥珀条里,
                    KPI 副行只报事实。 */}
                <div className="kpi-sub">无已配置通道</div>
              </>
            ) : (
              <div style={{ marginTop: "var(--s-2)" }}>
                {ops.channels.map((c) => (
                  // 通道名是有意义的文本,不截断也不 nowrap —— 只有钱包地址与
                  // 交易哈希做首尾省略。这一格加了 20px 图标位后只剩 ≈134px,
                  // 而「● 公开频道(延迟) +30min · 积压 12」要 ≈225px:nowrap
                  // 会把它推进相邻 KPI 格里。
                  <div
                    key={c.key}
                    style={{ overflowWrap: "anywhere", lineHeight: 1.7 }}
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
          {reconcile && (
            <StatCard label="结算对账 · 漏网" icon="🧾">
              {/* 对账补齐次数(sigReconciled)只活在 worker stdout;这里是能直接
                  查库的读数:仓位已结算而台账未回填的行数。非零即高亮,并直接
                  给出排查入口 —— 不让运营者再去猜该 grep 哪段日志。 */}
              {/* 色由那个有测试的纯函数说了算(reconcileView.tone),这里只
                  负责摆:红=漏网 · 琥珀=时间戳偏差 · 正常态中性(0 是个计数,
                  不是一场胜利,不标绿)。 */}
              <div
                className="kpi-value"
                style={
                  reconcile.tone === "down"
                    ? { color: "var(--ww-down)" }
                    : reconcile.tone === "warn"
                      ? { color: "var(--ww-warn)" }
                      : undefined
                }
              >
                {ops.settlementReconcile.stray}
              </div>
              <div className="kpi-sub">{reconcile.sub}</div>
              <div
                className="kpi-sub"
                style={
                  ops.settlementReconcile.tsMismatch7d > 0
                    ? { color: "var(--ww-warn)" }
                    : undefined
                }
              >
                近 7d 时间戳偏差 {ops.settlementReconcile.tsMismatch7d} 行
              </div>
            </StatCard>
          )}
          <StatCard label="存证链(每日 digest)" icon="🔗">
            {ops.digest.day ? (
              <>
                <div className="kpi-value">{ops.digest.day}</div>
                <div className="kpi-sub">
                  链尾 {ops.digest.tail?.slice(0, 12)}…
                </div>
              </>
            ) : (
              <>
                <div
                  className="kpi-value"
                  style={{ color: "var(--ww-text-faint)" }}
                >
                  —
                </div>
                <div className="kpi-sub">尚未生成(需已发布信号 + 公开频道)</div>
              </>
            )}
          </StatCard>
          <StatCard label="SQLite 每日快照" icon="💾">
            {ops.backupDay ? (
              <div className="kpi-value">{ops.backupDay}</div>
            ) : (
              <>
                <div
                  className="kpi-value"
                  style={{ color: "var(--ww-text-faint)" }}
                >
                  —
                </div>
                <div className="kpi-sub">尚未生成</div>
              </>
            )}
          </StatCard>
        </div>
      ) : (
        <div className="ds-empty">
          {"TG 发送 / 通道积压 / 存证 / 备份这四项来自运营概览,需要管理令牌。"}
          <div style={{ marginTop: "var(--s-2)" }}>
            {"上方的循环心跳表不需要令牌 —— "}
            <Link href="/status">公开状态页 →</Link>
          </div>
        </div>
      )}
      {/* 降级态口径写在数据下方的琥珀条里(readme §1.2)—— 三种成因必须能
          在同一张卡里区分,否则「—」会被读成 0。 */}
      <div
        className="ds-callout ds-callout--warn"
        style={{ marginTop: "var(--s-4)" }}
      >
        {
          "「—」是判不了不是零,三者都不是故障:无发送记录 = 这套 bot 还没发过;无已配置通道 = env 没设频道且无活跃 webhook;尚未生成 = 条件还没满足。"
        }
      </div>
    </section>
  );
}
