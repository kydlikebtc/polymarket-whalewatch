"use client";

import { useEffect, useMemo, useState } from "react";
import { useLang } from "../i18n";
import { Segmented } from "../ui";
import {
  buildQueryString,
  parseChoiceParam,
  replaceUrlQuery,
} from "../urlQuery";
import type { PulsePayload } from "./boards";
import {
  AnomalyBoard,
  ConvictionBoard,
  DivergenceBoard,
  GhostBoard,
  PulseOverview,
  WashBoard,
} from "./boards";
import type { Membership } from "./membership";
import { buildMembership } from "./membership";

// /pulse 市场脉搏。五个榜是分段标签页,一次只渲染一个 —— 2026-08-31 第二轮
// 改版的核心。此前五榜纵向全量堆叠,实测 6143px = 5.3 屏,且版面预算与信息
// 重要性完全倒挂:无鲸异动(26 行/1756px)+ 洗量榜(35 行/2318px)两个最次要
// 的榜吃掉 66% 的页面高度,而核心的异常日榜只占 12.9%。根因在数据层 ——
// marketPulse.ts 只给 top 封了 10 行,其余三榜敞开供应。
//
// 标签顺序仍是漏斗(宏观 → 微观 → 数据质量),默认落在确信指数 = 漏斗起点:
//   ① 确信指数(品类级):今天整体情绪落在哪个品类;
//   ②③④ 异常日榜 / 小单vs鲸鱼分歧 / 无鲸异动(市场级):具体谁在异动;
//   ⑤ 洗量榜(数据质量):上面那些量能里有多少不是方向性意见。
// 标签上带计数,KPI 概览条常驻在标签之上 —— 一次只见一榜丢掉的全局视野,
// 由这两处补回来。数据 = market_daily 每日聚合,从部署日开始积累 ——
// 页面对外自述底座厚度(dayCount),不装老。

type BoardKey = "conviction" | "anomaly" | "divergence" | "ghost" | "wash";
const BOARD_KEYS = [
  "conviction",
  "anomaly",
  "divergence",
  "ghost",
  "wash",
] as const;
const DEFAULT_BOARD: BoardKey = "conviction";

// 切换标签时面板高度骤变会让整页跳动(35 行的洗量榜 → 2 行的分歧榜),给个
// 下限兜住。数值同 /follow 详情页 tab 的既有做法,不是精算出来的。
const PANEL_MIN_HEIGHT = 360;

/* ------------------------------------------------------------------ 页面 */

export default function PulsePage() {
  const { t } = useLang();
  const [report, setReport] = useState<PulsePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardKey>(DEFAULT_BOARD);
  // 每个榜各自记「是否已展开全部」。只有当前标签在渲染,互不干扰。
  const [expanded, setExpanded] = useState<Partial<Record<BoardKey, boolean>>>(
    {},
  );
  // URL 读一次之后才允许回写 —— 否则挂载时的回写会先把合法的 ?board= 抹掉。
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    fetch("/api/pulse")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setReport((await r.json()) as PulsePayload);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // READ once on mount(urlQuery.ts 的既有契约:客户端读,非法值回落默认,
  // 手工篡改的 URL 产生不了非法状态)。
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("board");
    const parsed = parseChoiceParam(raw, BOARD_KEYS);
    if (parsed) setBoard(parsed);
    setHydrated(true);
  }, []);

  // WRITE 用 replaceState:切标签不该埋掉后退按钮;等于默认值时省略参数,
  // 默认视图序列化成裸路径。
  useEffect(() => {
    if (!hydrated) return;
    replaceUrlQuery(
      buildQueryString([["board", board === DEFAULT_BOARD ? null : board]]),
    );
  }, [board, hydrated]);

  // 哪些榜今天有内容。异常日榜与分歧榜恒在(它们各自带空态文案,「今天没有」
  // 本身是信息);确信指数/无鲸/洗量为空时连标签一起隐藏 —— 点进去空空如也
  // 的标签比没有这个标签更糟。
  const available: BoardKey[] = report
    ? [
        ...(report.conviction && report.conviction.categories.length > 0
          ? (["conviction"] as const)
          : []),
        "anomaly" as const,
        "divergence" as const,
        ...((report.ghosts ?? []).length > 0 ? (["ghost"] as const) : []),
        ...((report.washTop ?? []).length > 0 ? (["wash"] as const) : []),
      ]
    : [];

  // 落在一个不存在的标签上(确信指数今天算不出来,或 URL 指向空榜)就回落到
  // 第一个可用的,顺带把 URL 改正。
  useEffect(() => {
    if (available.length > 0 && !available.includes(board)) {
      setBoard(available[0]);
    }
    // available 每次渲染都新建数组,依赖它会无限循环;依赖它的内容摘要。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available.join(","), board]);

  const toggle = (k: BoardKey) =>
    setExpanded((prev) => ({ ...prev, [k]: !prev[k] }));

  // 跨榜成员身份算一次给五个榜共用 —— 四个市场级榜单的数组都在同一份
  // payload 里,按 conditionId 归并即可,不需要额外请求。
  const membership: Membership = useMemo(
    () => (report ? buildMembership(report) : new Map()),
    [report],
  );

  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-5)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", margin: 0 }}>{t("市场脉搏")}</h1>
        <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
          {t(
            "每 UTC 日收盘后重建的市场级聚合：先看整体情绪落在哪个品类，再落到具体哪些市场在异动，最后看这些量能要打几折。",
          )}
          {report?.latestDay && (
            <>
              {" "}
              {t("数据到 {d}（UTC）· 底座已积累 {n} 天", {
                d: report.latestDay,
                n: report.dayCount,
              })}
            </>
          )}
        </div>
      </header>

      {error && (
        <div className="ds-callout ds-callout--error">
          {t("加载失败：{err}", { err: error })}
        </div>
      )}
      {!report && !error && <div className="ds-hint">{t("加载中…")}</div>}

      {report && report.latestDay == null && (
        <div className="ds-callout">
          {t(
            "尚无聚合数据 —— 底座从部署后的第一个完整 UTC 日开始积累，明天再来。",
          )}
        </div>
      )}

      {report?.latestDay && (
        <>
          {report.truncated && (
            <div
              className="ds-callout ds-callout--warn"
              style={{ marginBottom: "var(--s-4)" }}
            >
              {t(
                "该日窗口在分页上限处被截断，覆盖不完整 —— 以下数字是下界，不是全量。",
              )}
            </div>
          )}

          <PulseOverview report={report} />

          {/* 五个选项在 375px 下必然放不下一行,按 globals.css 里那条既有约定
              直接上 ds-segmented--wrap(「不管几个选项,装不下就换行」的通用
              防御),不单独验证这次会不会溢出。 */}
          <Segmented<BoardKey>
            ariaLabel={t("市场脉搏榜单分区")}
            className="ds-segmented--wrap"
            options={[
              ...(available.includes("conviction")
                ? [
                    {
                      label: `${t("确信指数")} ${report.conviction?.categories.length ?? 0}`,
                      value: "conviction" as BoardKey,
                    },
                  ]
                : []),
              {
                label: `${t("异常日榜")} ${report.top.length}`,
                value: "anomaly" as BoardKey,
              },
              {
                label: `${t("方向分歧")} ${report.divergences.length}`,
                value: "divergence" as BoardKey,
              },
              ...(available.includes("ghost")
                ? [
                    {
                      label: `${t("无鲸异动")} ${(report.ghosts ?? []).length}`,
                      value: "ghost" as BoardKey,
                    },
                  ]
                : []),
              ...(available.includes("wash")
                ? [
                    {
                      label: `${t("洗量榜")} ${(report.washTop ?? []).length}`,
                      value: "wash" as BoardKey,
                    },
                  ]
                : []),
            ]}
            value={board}
            onChange={setBoard}
          />

          <div
            style={{
              minHeight: PANEL_MIN_HEIGHT,
              marginTop: "var(--s-4)",
              marginBottom: "var(--s-5)",
            }}
          >
            {board === "conviction" && report.conviction && (
              <ConvictionBoard
                data={report.conviction}
                expanded={!!expanded.conviction}
                onToggle={() => toggle("conviction")}
              />
            )}
            {board === "anomaly" && (
              <AnomalyBoard
                rows={report.top}
                membership={membership}
                expanded={!!expanded.anomaly}
                onToggle={() => toggle("anomaly")}
              />
            )}
            {board === "divergence" && (
              <DivergenceBoard
                rows={report.divergences}
                membership={membership}
                expanded={!!expanded.divergence}
                onToggle={() => toggle("divergence")}
              />
            )}
            {board === "ghost" && (
              <GhostBoard
                rows={report.ghosts ?? []}
                membership={membership}
                expanded={!!expanded.ghost}
                onToggle={() => toggle("ghost")}
              />
            )}
            {board === "wash" && (
              <WashBoard
                rows={report.washTop ?? []}
                membership={membership}
                expanded={!!expanded.wash}
                onToggle={() => toggle("wash")}
              />
            )}
          </div>

          <div className="ds-hint">
            {t(
              "全页共用口径：小单 = 单笔 $2k–10k（抓取下限之下的真散户不可见，因此只说「小单」）；鲸鱼 = 单笔 ≥$50k，与 heavy 信号同一把尺。各榜自身的公式与门槛，见该榜标题下的「口径」折叠。",
            )}
          </div>
        </>
      )}
    </main>
  );
}
