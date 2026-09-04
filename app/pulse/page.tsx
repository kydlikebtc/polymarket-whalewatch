"use client";

import { useEffect, useMemo, useState } from "react";
import { useLang } from "../i18n";
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
      {/* 页头 —— 12px 小标（emoji 前缀承担语义）+ 24/600 标题 + 14px 描述；
          右侧动作位放数据覆盖读数。它是事实不是按钮，但也不是「名称标签」：
          灰底 name tag 按 readme §2.1 只发给实体名（结果名、品类），发给
          「数据到 X · 底座 N 天」这种状态读数就把灰底用成了状态色。设计稿
          帧 09 这一位是 32px 中性描边条，用 .status-pill 的无修饰基态
          （灰描边 / 透明底，globals.css:1667）撑起来，尺寸按 --h-btn/--r-btn
          对齐页头动作位的其余控件。 */}
      <header className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="page-head__eyebrow">
            {t("📊 每 UTC 日收盘后重建")}
          </div>
          <h1 className="page-head__title">{t("市场脉搏")}</h1>
          <p className="page-head__desc">
            {t(
              "先看整体情绪落在哪个品类，再落到具体哪些市场在异动，最后看这些量能要打几折。",
            )}
          </p>
        </div>
        {report?.latestDay && (
          <div className="page-head__actions">
            <span
              className="status-pill"
              style={{
                height: "var(--h-btn)",
                padding: "0 var(--s-3)",
                borderRadius: "var(--r-btn)",
                fontSize: "var(--t-base)",
                fontWeight: 400,
              }}
            >
              {t("数据到 {d}（UTC）· 底座已积累 {n} 天", {
                d: report.latestDay,
                n: report.dayCount,
              })}
            </span>
          </div>
        )}
      </header>

      {error && (
        <div className="ds-callout ds-callout--error">
          {t("加载失败：{err}", { err: error })}
        </div>
      )}
      {!report && !error && <div className="ds-empty">{t("加载中…")}</div>}

      {report && report.latestDay == null && (
        // 底座还没攒够一个完整 UTC 日 —— 空态给出路（明天再来），不返回 null。
        <div className="ds-empty">
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
              {t("该日窗口在分页上限处被截断 —— 以下数字是下界，不是全量。")}
            </div>
          )}

          <PulseOverview report={report} />

          {/* 榜单卡 —— 标签行在卡内顶部（设计稿：tab 行 → 标题条 → 表 →
              说明条，一张卡装完一个榜）。五个榜是同一天脉搏的五个侧面，
              不是互斥的参数选择，所以用 TabRow（蓝色浅底胶囊、无外框）而不是
              Segmented；标签在 375px 下装不下会自动换行。 */}
          <div className="ds-card" style={{ overflow: "hidden" }}>
            <div
              className="ds-tabrow"
              role="group"
              aria-label={t("市场脉搏榜单分区")}
            >
              {[
                ...(available.includes("conviction")
                  ? [
                      {
                        label: `01 ${t("确信指数")} ${report.conviction?.categories.length ?? 0}`,
                        value: "conviction" as BoardKey,
                      },
                    ]
                  : []),
                {
                  label: `02 ${t("异常日榜")} ${report.top.length}`,
                  value: "anomaly" as BoardKey,
                },
                {
                  label: `03 ${t("方向分歧")} ${report.divergences.length}`,
                  value: "divergence" as BoardKey,
                },
                ...(available.includes("ghost")
                  ? [
                      {
                        label: `04 ${t("无鲸异动")} ${(report.ghosts ?? []).length}`,
                        value: "ghost" as BoardKey,
                      },
                    ]
                  : []),
                ...(available.includes("wash")
                  ? [
                      {
                        label: `05 ${t("洗量榜")} ${(report.washTop ?? []).length}`,
                        value: "wash" as BoardKey,
                      },
                    ]
                  : []),
              ].map((o) => (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={board === o.value}
                  onClick={() => setBoard(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>

            <div style={{ minHeight: PANEL_MIN_HEIGHT }}>
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
          </div>

          {/* 全页共用的两把尺 —— 一行。两个门槛值必须留（不知道「小单」是
              $2k–10k 就读不了分歧榜），括号里那句也必须留（「小单」不等于
              散户，抓取下限以下看不见）。「与 heavy 信号同一把尺」「各榜公式
              见该榜卡底」是导航与理据，页面自明，删。 */}
          <div
            className="ds-card"
            style={{ overflow: "hidden", marginTop: "var(--s-5)" }}
          >
            <div className="note-strip" style={{ borderTop: 0 }}>
              {t(
                "全页共用口径：小单 = 单笔 $2k–10k（抓取下限以下的散户不可见）；鲸鱼 = 单笔 ≥$50k。",
              )}
            </div>
          </div>
        </>
      )}
    </main>
  );
}
