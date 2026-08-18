"use client";

import { useCallback, useEffect, useState } from "react";
import { useLang } from "../i18n";
import { loopMeta } from "../loopMeta";

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
// 刻意没有的东西:60 天 uptime 条与历史事件时间线。heartbeats 表以 loop 为
// 主键,只存当前状态与**当日**计数(lib/heartbeat.ts),没有时间序列 ——
// 画一条看起来很专业的 99.9% 柱状图,数据是编的。状态页一旦有一个编的数字,
// 它剩下的每个数字都不值钱了。当日最长停顿是我们真有的那部分,就只给这个。

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
  // 网络失败与「引擎停跳」是两件事:前者是本页自己没拿到数据,后者是被
  // 监控的东西死了。混成一个红条会让读者以为服务挂了,而其实只是他断网。
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

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
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const loops = health?.loops ?? [];
  // 异常组件列表 —— 横幅的计数与点名共用同一份,不会出现「说 2 个异常
  // 却只列出 1 个」这种自相矛盾。
  const degraded = loops.filter((l) => l.stale);
  const uptimeDays =
    health?.startedAt != null
      ? Math.max(0, (Math.floor(Date.now() / 1000) - health.startedAt) / 86_400)
      : null;

  const tone = health == null ? "muted" : health.ok ? "up" : "down";
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
      <header style={{ marginBottom: "var(--s-5)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", margin: 0 }}>{t("系统状态")}</h1>
        <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
          {t("监控引擎各循环的实时心跳。信号 feed 的 healthy 位与本页同源。")}
        </div>
      </header>

      {fetchError && (
        <div
          className="ds-callout ds-callout--warn"
          style={{ marginBottom: "var(--s-4)" }}
        >
          {t("无法获取状态（{err}）—— 下方为最后一次成功读取的结果。", {
            err: fetchError,
          })}
        </div>
      )}

      <section className={`status-banner status-banner--${tone}`}>
        <span className={`status-orb status-orb--${tone}`} aria-hidden />
        <div>
          <div className="status-banner__title">{headline}</div>
          <div className="status-banner__sub">
            {health == null
              ? " "
              : health.ok
                ? uptimeDays != null
                  ? t("本次进程已连续运行 {d} 天", { d: uptimeDays.toFixed(1) })
                  : " "
                : degraded.length > 0
                  ? degraded.map((l) => t(loopMeta(l.loop).label)).join(" · ")
                  : (health.reason ?? health.error ?? " ")}
          </div>
        </div>
      </section>

      <div className="ds-table-wrap" style={{ marginBottom: "var(--s-4)" }}>
        <table className="ds-table">
          <thead>
            <tr>
              <th>{t("组件")}</th>
              <th>{t("状态")}</th>
              <th className="is-right">{t("最近心跳")}</th>
              <th className="is-right">{t("今日轮次")}</th>
              <th className="is-right">{t("今日最长停顿")}</th>
            </tr>
          </thead>
          <tbody>
            {loops.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <span className="muted">
                    {health == null ? t("加载中…") : t("无循环心跳记录")}
                  </span>
                </td>
              </tr>
            ) : (
              loops.map((l) => {
                const meta = loopMeta(l.loop);
                return (
                  <tr key={l.loop}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{t(meta.label)}</div>
                      <div className="ds-hint">{t(meta.cadence)}</div>
                    </td>
                    <td>
                      {l.stale ? (
                        <>
                          <span className="status-pill status-pill--down">
                            {l.missing ? t("从未启动") : t("停跳")}
                          </span>
                          {/* 停跳时说清楚「你会少看到什么」——「outcome_backfill
                              stale」对读者毫无意义,「战绩会停在旧数字」才有。 */}
                          <div className="ds-hint">{t(meta.impact)}</div>
                        </>
                      ) : (
                        <span className="status-pill status-pill--up">
                          {t("正常")}
                        </span>
                      )}
                    </td>
                    <td className="is-right num mono">
                      {l.missing ? (
                        <span className="muted">—</span>
                      ) : (
                        durText(l.ageSec)
                      )}
                      <div className="ds-hint">
                        {t("阈值 {n}", { n: durText(l.staleAfterSec) })}
                      </div>
                    </td>
                    <td className="is-right num mono">
                      {l.cycles == null || l.missing ? (
                        <span className="muted">—</span>
                      ) : (
                        l.cycles.toLocaleString()
                      )}
                    </td>
                    <td className="is-right num mono">
                      {l.maxGapSec == null || l.missing ? (
                        <span className="muted">—</span>
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
      </div>

      <div className="ds-hint">
        {refreshedAt != null && (
          <>
            {t("更新于")}{" "}
            <span className="mono">
              {new Date(refreshedAt * 1000).toLocaleTimeString()}
            </span>
            {" · "}
            {t("每 30 秒自动刷新")}
            {" · "}
          </>
        )}
        {t(
          "本页只呈现当前状态：心跳表按循环留存当日计数，没有跨日的历史时间序列，因此不提供 uptime 曲线与事件时间线。",
        )}
      </div>
    </main>
  );
}
