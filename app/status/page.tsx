"use client";

import { useCallback, useEffect, useState } from "react";
import { useLang } from "../i18n";
import { loopMeta } from "../loopMeta";
import { CopyButton, StatCard } from "../ui";

// /status —— 公开状态页(参考 status.claude.com 的信息层次:整体横幅 →
// 逐组件状态 → 事实脚注)。
//
// 为什么它是公开的,而 /manage 现在整页要令牌:这两类信息的受众根本不同。
// 「引擎还活着吗」是**每一个订阅方都有权随时知道**的事实 —— 信号 feed 的
// healthy 位、TG 频道的沉默、webhook 的停投,全都指向这一个问题;把它藏在
// 运营令牌后面,等于让订阅方只能靠猜。而「哪些档位放开了推送、TG 连败几次、
// 有几个 key、存证链到哪一天」是运营内部事,不该对外。
//
// 数据源是既有的公开 /api/health(docker healthcheck 与外部 uptime 探针也
// 用它),零新增接口。
//
// 历史连续性(60 天条带 + 30 天起算时钟,/api/continuity):数据来自共识
// 循环逐轮落库的实测时间戳(cycle_metrics,每 5 分钟真实一行)—— 每一格
// 都有原始行背书,不是推测式 uptime。heartbeats 仍只存当日计数,所以逐
// 循环的 uptime 曲线依旧不提供:状态页一旦有一个编的数字,它剩下的每个
// 数字都不值钱了 —— 只画有真序列背书的那一条。

const REFRESH_MS = 30_000;

interface LoopStatus {
  loop: string;
  lastTs: number | null;
  ageSec: number | null;
  staleAfterSec: number;
  stale: boolean;
  missing?: boolean;
  cycles?: number;
  maxGapSec?: number;
}

interface HealthReport {
  ok: boolean;
  nowSec: number;
  loops?: LoopStatus[];
  staleLoops?: string[];
  reason?: string;
  startedAt?: number | null;
  error?: string;
}

interface ContinuityDay {
  day: string;
  status: "covered" | "gap" | "partial" | "pre" | "pending";
  cycles: number;
  maxGapSec: number;
}

interface ContinuityReport {
  gateDays: number;
  tolSec: number;
  recordStartDay: string | null;
  days: ContinuityDay[];
  streakDays: number;
  streakStartDay: string | null;
  streakClipped: boolean;
  todayCoveredSoFar: boolean;
  gateReached: boolean;
}

function durText(sec: number | null | undefined): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${(sec / 3600).toFixed(1).replace(/\.0$/, "")}h`;
  return `${(sec / 86_400).toFixed(1).replace(/\.0$/, "")}d`;
}

export default function StatusPage() {
  const { t } = useLang();
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [cont, setCont] = useState<ContinuityReport | null>(null);
  // 网络失败与「引擎停跳」是两件事:前者是本页自己没拿到数据,后者是被
  // 监控的东西死了。混成一个红条会让读者以为服务挂了,而其实只是他断网。
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  // 嵌入代码要绝对地址,而 SSR 阶段没有 window —— 挂载后再补,避免水合错位。
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  const load = useCallback(async () => {
    try {
      // /api/health 在停跳时返回 503 —— 那是**有效响应**,照常解析。
      const res = await fetch("/api/health");
      const body = (await res.json()) as HealthReport;
      setHealth(body);
      setFetchError(null);
      setRefreshedAt(Math.floor(Date.now() / 1000));
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    }
    try {
      // 连续性区独立取数:失败时保留上一次成功结果,不打扰主状态横幅。
      const res = await fetch("/api/continuity");
      if (res.ok) setCont((await res.json()) as ContinuityReport);
    } catch {
      /* 见上 —— 拿不到就先不渲染/保留旧值 */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const loops = health?.loops ?? [];
  // 异常组件列表 —— 页头徽章的计数与红条里的点名共用同一份,不会出现
  // 「说 2 个异常却只列出 1 个」这种自相矛盾。
  const degraded = loops.filter((l) => l.stale);
  const uptimeDays =
    health?.startedAt != null
      ? Math.max(0, (Math.floor(Date.now() / 1000) - health.startedAt) / 86_400)
      : null;

  const tone = health == null ? "muted" : health.ok ? "up" : "down";
  // 状态页只认绿 / 红 / 灰三态 —— 多一档颜色就多一次「这个黄的到底算不算
  // 事」的犹豫。emoji 只落在徽章内、KPI 图标位与 12px 小标前缀这三处。
  const toneIcon = tone === "up" ? "✅" : tone === "down" ? "❌" : "⏳";
  // 徽章只有绿 / 红两类。tone === "muted"（还没取到数据）不走徽章,见页头动作位。
  const tonePill =
    tone === "down"
      ? "status-pill status-pill--down"
      : "status-pill status-pill--up";
  const headline =
    health == null
      ? t("正在获取状态…")
      : health.ok
        ? t("全部系统正常运行")
        : degraded.length > 0
          ? t("{n} 个组件异常", { n: degraded.length })
          : t("引擎未在运行");

  return (
    <main className="ds-main status-page">
      {/* 页头 —— 12px 小标（emoji 前缀 + 刷新节奏）· 24/600 标题 · 14px 描述；
          右侧动作位放整体状态徽章。旧皮那条整幅彩色横幅在这套皮里没有位置：
          层级只来自 1px 分格线与 12px 小标，不来自大色块与字号跳档。 */}
      <header className="page-head">
        <div>
          <div className="page-head__eyebrow">
            <span aria-hidden>📡</span>
            <span>
              {t("每 30 秒自动刷新")}
              {refreshedAt != null
                ? ` · ${t("更新于")} ${new Date(
                    refreshedAt * 1000,
                  ).toLocaleTimeString()}`
                : ""}
            </span>
          </div>
          <h1 className="page-head__title">{t("系统状态")}</h1>
          <p className="page-head__desc">
            {t("监控引擎各循环的实时心跳。信号 feed 的 healthy 位与本页同源。")}
          </p>
        </div>
        <div className="page-head__actions">
          {tone === "muted" ? (
            // 「还没取到数据」不摆徽章：徽章只有绿/红/琥珀/蓝/灰底五类语义，
            // 没有「还不知道」这一档；裸 .status-pill（透明底 + 灰描边）会变成
            // 第六种药丸，而灰底那类是名称标签专用、不表示状态。降成与页头小标
            // 同款的 13px 提示文字（emoji 作小标前缀，是允许的三处之一）。
            <span
              className="ds-hint"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--s-1)",
                height: 32,
              }}
            >
              <span aria-hidden>{toneIcon}</span>
              {headline}
            </span>
          ) : (
            <span
              className={tonePill}
              style={{
                gap: "var(--s-1)",
                height: 32,
                padding: "0 var(--s-3)",
                borderRadius: 8,
                fontSize: "var(--t-base)",
              }}
            >
              <span aria-hidden>{toneIcon}</span>
              {headline}
            </span>
          )}
        </div>
      </header>

      {/* 口径与异常声明放在数据「前面」，不放脚注。
          网络失败（琥珀）与引擎停跳（红）永远是两条，不合并成一个红条。 */}
      {fetchError && (
        <div
          className="ds-callout ds-callout--warn"
          style={{ marginBottom: "var(--s-5)" }}
        >
          {t("无法获取状态（{err}）—— 下方为最后一次成功读取的结果。", {
            err: fetchError,
          })}
        </div>
      )}

      {health != null && !health.ok && (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-5)" }}
        >
          {degraded.length > 0
            ? t("停跳组件：{list}", {
                list: degraded
                  .map((l) => t(loopMeta(l.loop).label))
                  .join(" · "),
              })
            : (health.reason ?? health.error ?? t("引擎未在运行"))}
        </div>
      )}

      {/* 三格 KPI（状态页页型）—— 运行时长 / 数据连续性 / 今日断档。
          值 18px 常规字重、与正文同字体，不加粗、不放大、不用等宽。 */}
      <section className="kpi" style={{ marginBottom: "var(--s-5)" }}>
        <StatCard label={t("运行时长")} icon={toneIcon}>
          <div className="kpi-value">
            {uptimeDays != null ? (
              t("{d} 天", { d: uptimeDays.toFixed(1) })
            ) : (
              <span className="faint">—</span>
            )}
          </div>
          <div className="kpi-sub">{t("本次进程连续运行")}</div>
        </StatCard>

        <StatCard label={t("数据连续性")} icon="📅">
          <div
            className="kpi-value"
            style={
              cont
                ? {
                    color: cont.gateReached ? "var(--ww-up)" : "var(--ww-link)",
                  }
                : undefined
            }
          >
            {cont ? (
              t("{n} / {g} 天", {
                n: `${cont.streakClipped ? "≥" : ""}${cont.streakDays}`,
                g: cont.gateDays,
              })
            ) : (
              <span className="faint">—</span>
            )}
          </div>
          {/* 副行只说「还差几天」；起算日进 title —— 它不改变这个数怎么读，
              而条带上第一格绿色就是它。 */}
          <div
            className="kpi-sub"
            title={
              cont != null && !cont.gateReached && cont.streakDays > 0
                ? t("连续覆盖起算日 {d}（UTC）", {
                    d: cont.streakStartDay ?? "—",
                  })
                : undefined
            }
          >
            {cont == null
              ? t("连续性数据未就绪")
              : cont.gateReached
                ? t("已达标 · 自 {d} 起连续覆盖", {
                    d: cont.streakStartDay ?? "—",
                  })
                : cont.streakDays > 0
                  ? t("还差 {n} 天可重推阈值", {
                      n: cont.gateDays - cont.streakDays,
                    })
                  : t("连续覆盖尚未形成 —— 从下一个完整 UTC 日重新起算")}
          </div>
        </StatCard>

        <StatCard
          label={t("今日断档")}
          icon={cont != null && !cont.todayCoveredSoFar ? "🔔" : "🔕"}
        >
          <div
            className="kpi-value"
            style={
              cont != null && !cont.todayCoveredSoFar
                ? { color: "var(--ww-down)" }
                : undefined
            }
          >
            {cont == null ? (
              <span className="faint">—</span>
            ) : cont.todayCoveredSoFar ? (
              t("0 次")
            ) : (
              t("已出现断档")
            )}
          </div>
          <div className="kpi-sub">
            {cont == null
              ? t("连续性数据未就绪")
              : t("相邻两轮间隔超过 {t} 即记断档", { t: durText(cont.tolSec) })}
          </div>
        </StatCard>
      </section>

      {/* 30 天起算时钟 —— 卡内标题条 → 格子条 → 图例 → 卡底口径条。
          条带每一格背后都是 cycle_metrics 的原始行，不是推测式 uptime。
          overflow:hidden 是必需的：标题条的下边线与卡底说明条的灰底都要被
          12px 圆角裁住，否则卡片四角会被方角的条子顶掉。 */}
      <section
        className="ds-card"
        style={{ marginBottom: "var(--s-5)", overflow: "hidden" }}
      >
        <div
          className="card-bar"
          style={{ fontWeight: 600, gap: "var(--s-1)" }}
        >
          <span aria-hidden>📅</span>
          <span>{t("30 天起算时钟 · 按 UTC 日历日")}</span>
        </div>

        {/* 三种缺数据的成因分开说：还没取到 / 取到了但库里没有循环记录 /
            有记录。空态永远给内容和出路，不整块消失 —— 卡片凭空出现或
            消失会让页面在数据到达时整屏跳动。 */}
        {cont == null ? (
          <div style={{ padding: "18px var(--s-4)" }}>
            <div className="ds-empty">
              <div>{t("连续性数据尚未就绪")}</div>
            </div>
          </div>
        ) : (
          <>
            {cont.recordStartDay == null ? (
              <div style={{ padding: "18px var(--s-4)" }}>
                <div className="ds-empty">
                  <div>
                    {t(
                      "尚无循环记录 —— 引擎从未在这个库上跑过共识循环；落下第一轮时间戳后这里会出现第一格。",
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div style={{ padding: "18px var(--s-4)" }}>
                  <div className="cont-strip">
                    {cont.days.map((d) => (
                      <span
                        key={d.day}
                        className={`cont-cell cont-cell--${d.status}`}
                        title={
                          d.status === "covered"
                            ? t("{d} · 覆盖 · {n} 轮", {
                                d: d.day,
                                n: d.cycles,
                              })
                            : d.status === "gap"
                              ? t("{d} · 断档 · 最长停顿 {t}", {
                                  d: d.day,
                                  t: durText(d.maxGapSec),
                                })
                              : d.status === "partial"
                                ? t("{d} · 记录起点日（从中途开始，不计入）", {
                                    d: d.day,
                                  })
                                : d.status === "pre"
                                  ? t("{d} · 早于记录起点", { d: d.day })
                                  : t("{d} · 今天 · 进行中", { d: d.day })
                        }
                      />
                    ))}
                  </div>
                  <div className="cont-legend">
                    <span>
                      <span className="cont-cell cont-cell--covered" />{" "}
                      {t("覆盖")}
                    </span>
                    <span>
                      <span className="cont-cell cont-cell--gap" /> {t("断档")}
                    </span>
                    <span>
                      <span className="cont-cell cont-cell--partial" />{" "}
                      {t("起点日")}
                    </span>
                    <span>
                      <span className="cont-cell cont-cell--pre" />{" "}
                      {t("无记录")}
                    </span>
                    <span>
                      <span className="cont-cell cont-cell--pending" />{" "}
                      {t("今天")}
                    </span>
                  </div>
                  {origin && (
                    <details style={{ marginTop: "var(--s-4)" }}>
                      <summary
                        className="ds-hint"
                        style={{ cursor: "pointer" }}
                      >
                        {t("嵌入此徽章")}
                      </summary>
                      <div className="embed-snippet">
                        <code>{`<iframe src="${origin}/embed/status" width="360" height="96" style="border:0" loading="lazy" title="WhaleWatch status"></iframe>`}</code>
                        <CopyButton
                          text={`<iframe src="${origin}/embed/status" width="360" height="96" style="border:0" loading="lazy" title="WhaleWatch status"></iframe>`}
                        />
                      </div>
                      <div className="ds-hint">
                        {t(
                          "嵌入卡 60 秒缓存、无脚本、自带署名回链；加 ?theme=dark 得深色版。",
                        )}
                      </div>
                    </details>
                  )}
                </div>

                {/* 卡底一行。断档判据（相邻两轮间隔 > tol）已在上方「今日
                    断档」KPI 副行说过、「按 UTC 日历日」已在本卡标题条说过，
                    这里只留读条带时缺不了的两条：起点在哪、跨午夜怎么算，
                    外加 30 天闸门攒够之后会发生什么。 */}
                <div className="note-strip">
                  {t(
                    "记录始于 {d}；跨午夜的断档两天都不计入。攒满 {n} 个不间断 UTC 日后重推所有策略阈值。",
                    { d: cont.recordStartDay, n: cont.gateDays },
                  )}
                </div>
              </>
            )}
          </>
        )}
      </section>

      {/* 心跳表 —— 行没有任何行级强调（无左边线、无字号跳档、无整行染色），
          轻重全靠状态徽章的颜色。 */}
      <div className="ds-table-wrap">
        <table className="ds-table">
          <thead>
            {/* 列宽照设计稿 15：循环名自适应（1fr）· 状态 110 · 最近心跳 120
                · 今日轮次 110 · 今日最长停顿 110。不给宽度时 auto layout 会让
                停跳那格的「影响说明」把状态列撑到 400px、循环名列反被挤扁 ——
                与设计稿的比例正好相反。表头永远 nowrap（全局 .ds-table th 已给），
                所以 width 只是分配倾向，长译文不会被截断。 */}
            <tr>
              <th>{t("循环")}</th>
              <th style={{ width: 110 }}>{t("状态")}</th>
              <th className="is-right" style={{ width: 120 }}>
                {t("最近心跳")}
              </th>
              <th className="is-right" style={{ width: 110 }}>
                {t("今日轮次")}
              </th>
              <th className="is-right" style={{ width: 110 }}>
                {t("今日最长停顿")}
              </th>
            </tr>
          </thead>
          <tbody>
            {loops.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: "var(--s-3) var(--s-4)" }}>
                  {/* 加载态只说「加载中…」—— 副行再写一遍「正在读取
                      /api/health」是同一句话说两遍。空态的副行留着，它给的是
                      出路（等一个循环周期）而不是复述。 */}
                  <div className="ds-empty">
                    <div>
                      {health == null ? t("加载中…") : t("无循环心跳记录")}
                    </div>
                    {health != null && (
                      <div
                        className="ds-hint"
                        style={{ marginTop: "var(--s-1)" }}
                      >
                        {t(
                          "引擎还没写过心跳 —— 若它刚重启，等一个循环周期再看。",
                        )}
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              loops.map((l) => {
                const meta = loopMeta(l.loop);
                return (
                  <tr key={l.loop}>
                    {/* 循环名 + 节奏副行。副行是 12px（表内副行统一档），
                        不是 13px —— 它跟主行是同一件事的两半，不该看起来
                        像另一句说明。循环名走 .cell-wrap：名字永不截断。 */}
                    <td className="cell-wrap">
                      <div>{t(meta.label)}</div>
                      <div
                        className="ds-hint"
                        style={{ marginTop: 2, fontSize: "var(--t-sm)" }}
                      >
                        {t(meta.cadence)}
                      </div>
                    </td>
                    {/* col-block：停跳时这格有两个子元素（徽章 + 影响说明），
                        ≤640 的堆叠卡默认把 td 摊成 [标签][内容] 一行右对齐，
                        影响说明会被挤到徽章右侧只剩两百来像素。改成整块左对齐，
                        标签独占一行、说明落回徽章下方。 */}
                    <td className="col-block" data-label={t("状态")}>
                      {l.stale ? (
                        <>
                          <span
                            className="status-pill status-pill--down"
                            style={{ gap: "var(--s-1)" }}
                          >
                            <span aria-hidden>❌</span>
                            {l.missing ? t("从未启动") : t("停跳")}
                          </span>
                          {/* 停顿时说清楚「你会少看到什么」——「outcome_backfill
                              stale」对读者毫无意义,「战绩会停在旧数字」才有。 */}
                          <div
                            className="ds-hint cell-wrap"
                            style={{ marginTop: 4, fontSize: "var(--t-sm)" }}
                          >
                            {t(meta.impact)}
                          </div>
                        </>
                      ) : (
                        <span
                          className="status-pill status-pill--up"
                          style={{ gap: "var(--s-1)" }}
                        >
                          <span aria-hidden>✅</span>
                          {t("正常")}
                        </span>
                      )}
                    </td>
                    <td
                      className="is-right"
                      data-label={t("最近心跳")}
                      title={t("阈值 {n}", { n: durText(l.staleAfterSec) })}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      {l.missing ? (
                        <span className="faint">—</span>
                      ) : (
                        <>
                          {durText(l.ageSec)}{" "}
                          <span
                            className="ds-hint"
                            style={{ fontSize: "var(--t-sm)" }}
                          >
                            / {durText(l.staleAfterSec)}
                          </span>
                        </>
                      )}
                    </td>
                    <td
                      className="is-right"
                      data-label={t("今日轮次")}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      {l.cycles == null || l.missing ? (
                        <span className="faint">—</span>
                      ) : (
                        l.cycles.toLocaleString()
                      )}
                    </td>
                    <td
                      className="is-right"
                      data-label={t("今日最长停顿")}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      {l.maxGapSec == null || l.missing ? (
                        <span className="faint">—</span>
                      ) : (
                        durText(l.maxGapSec)
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {/* 卡底说明条 —— 灰底 13px/1.6，压到一行。三句都必须留：为什么
            「今日轮次」每天归零、这些数是实测还是推测、表内的 — 怎么读。
            整条只有一处 600 字重，那句是本页的立论。 */}
        <div className="note-strip">
          {t("心跳表只留当日计数，跨日历史由上方连续性区重建。")}{" "}
          <strong style={{ fontWeight: 600, color: "var(--ww-text)" }}>
            {t("每一格都有原始行背书，不做推测式 uptime。")}
          </strong>{" "}
          {t("表内的 — 是「判不了」不是零：当日无可用计数。")}
        </div>
      </div>
    </main>
  );
}
