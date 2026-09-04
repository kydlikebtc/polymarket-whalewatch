"use client";

// 策略中心「深度分析」面板 —— 对一批历史下注(某一档策略,或按筛选聚合的
// 多档)做六维度可视化分析。计算全部在 lib/followAnalysis.ts(client-safe
// 纯函数、已单测),本文件只负责画;图表沿用全站惯例:内联 SVG/CSS 条形,
// 零图表依赖。设计与维度取舍见
// docs/plans/2026-08-13-strategy-deep-analysis-design.md。
//
// 口径红线(与整页一致,面板头部向读者声明):已结算纸面口径、push 不进
// 胜率分母、小样本读数弱化/置 —,绝不硬算。

import { useState, type CSSProperties, type ReactNode } from "react";
import type { ExitCounterfactualSummary } from "../../lib/exitCounterfactual";
import {
  analyzeBets,
  BUCKET_LOW_SAMPLE_N,
  type AnalysisPosition,
  type CategoryGroup,
  type DeepAnalysis,
  type OddsBucket,
} from "../../lib/followAnalysis";
import { catLabel, subLabel } from "../../lib/categoryLabel";
import { useLang } from "../i18n";
import { Icon } from "../ui";
import {
  buildEdgeMatrix,
  diagnoseSegments,
  type DiagnosedSegment,
  type EdgeMatrix,
} from "../../lib/followInsights";
import { LOW_SAMPLE_THRESHOLD } from "../../lib/followCardView";

/** 面板输入行:分析契约 + 可选市场标题(散点 tooltip 用,页面行天然带)。 */
export type DeepAnalysisRow = AnalysisPosition & { title?: string };

/* ---------------------------------------------------------------- format */
// 与 page.tsx 的同名小工具刻意重复声明(该页的既有惯例:客户端文件各自持有
// 轻量格式化函数,不跨文件共享一套「格式化库」,见 page.tsx 顶部本地类型的
// 同款注释)。

const MINUS = "−"; // U+2212

function fmtUsd0(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtSignedUsd(n: number): string {
  return `${n < 0 ? MINUS : "+"}$${fmtUsd0(Math.abs(n))}`;
}

// 期望/仓这类小额均值:整美元会把 ±$0.4 抹成 ±$0,保留一位小数。
function fmtSignedUsd1(n: number): string {
  return `${n < 0 ? MINUS : "+"}$${Math.abs(n).toFixed(1)}`;
}

function fmtPct0(r: number): string {
  return `${Math.round(r * 100)}%`;
}

// edge(实际胜率 − 隐含胜率)按百分点标注:+12pt/−5pt。
function fmtSignedPt(r: number): string {
  const pt = Math.round(Math.abs(r) * 100);
  return `${r < 0 ? MINUS : "+"}${pt}pt`;
}

function cents(p: number): string {
  return `${(p * 100).toFixed(1)}¢`;
}

// 周标签:UTC 月/日 —— 周桶按 UTC 周一切分(lib utcWeekStart),标签必须同
// 一时区,否则东八区晚上结算的仓会看着"跑进别的周"。
function fmtWeekLabel(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function pnlColor(n: number): string {
  return n >= 0 ? "var(--ww-up)" : "var(--ww-down)";
}

function pnlTextClass(n: number): string {
  return n >= 0 ? "up" : "down";
}

/* ------------------------------------------------------------------ i18n */
// 组件外纯函数不能调 Hook:接收调用组件的 t(useLang)作参数。类型与
// app/i18n.tsx 的 LangCtx.t 同形,本地声明免跨层 import。
type TFn = (zh: string, params?: Record<string, string | number>) => string;

// 胜负平战绩串:「7胜4负1平」/ "7W 4L 1P"。平局段仅在 >0 时出现(与
// 既有各处内联写法同一规则),整段由两个字典键组合。
function fmtRecord(t: TFn, wins: number, losses: number, pushes: number) {
  return (
    t("{w}胜{l}负", { w: wins, l: losses }) +
    (pushes > 0 ? t("{p}平", { p: pushes }) : "")
  );
}

// catLabelFine 的可译版:两段分别过 t 再合成(catLabel/subLabel 返回中文
// 键,翻译在渲染层做)。同名去重在译后比较 —— zh 下 t 恒等,行为与
// lib/categoryLabel.catLabelFine 完全一致。
function fineLabelT(
  t: TFn,
  category: string | null | undefined,
  subcategory: string | null | undefined,
): string {
  const primary = t(catLabel(category));
  if (!subcategory) return primary;
  const sub = t(subLabel(subcategory));
  return sub === primary ? primary : `${primary}·${sub}`;
}

/* ------------------------------------------------------------ primitives */

// 有口径的读数/列头后面跟一个 (?) —— 口径写在它的 title 里(这套皮的标志性
// 细节:每一个有口径的列头都带一个)。触屏可达不自己实现:.tip-pop 的点按
// 弹层要靠 onClick 手动 focus + onBlur 收起(iOS Safari 点 tabindex=-1 的
// span 不给焦点,触屏又从不显示原生 title),那套 props 只在 app/ui.tsx 里,
// 直接复用它导出的 Icon(接受显式 title);这里只管 (?) 的排版。
function HelpMark({ tip }: { tip: string }) {
  return (
    <span
      style={{
        flex: "0 0 auto",
        fontSize: 11,
        fontWeight: 400,
        color: "var(--ww-text-faint)",
      }}
    >
      <Icon s="(?)" title={tip} />
    </span>
  );
}

// 区块骨架:一张白卡 —— 标题条(14/600)→ 口径说明条(13px muted,放在数据
// 「前面」而不是脚注)→ 内容 → 可选的灰色说明条。六个维度共用同一节奏,
// 层级只来自 1px 分格线,不来自字号跳档。
function Block({
  label,
  hint,
  note,
  children,
}: {
  label: string;
  hint: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    // 不裁 overflow(与 ① 卡同一处理):格内的 (?) 点开是绝对定位的弹出层,
    // 卡一裁就只剩鼠标悬停能读到口径。卡底说明条自带圆角补上被 overflow
    // 顺带做掉的那件事 —— 它是唯一有底色、会压到圆角上的子元素。
    <section className="ds-card">
      {/* 卡内标题条:14 / 600(.card-bar 本身不带字重,与全站其它卡一样
          由调用方给) */}
      <div className="card-bar" style={{ fontWeight: 600 }}>
        {label}
      </div>
      <div
        className="ds-hint"
        style={{
          padding: "var(--s-3) var(--s-4)",
          borderBottom: "1px solid var(--ww-border)",
          lineHeight: "var(--lh-note)",
        }}
      >
        {hint}
      </div>
      <div style={{ padding: "14px var(--s-4)" }}>{children}</div>
      {note != null ? (
        <div
          className="note-strip"
          style={{ borderRadius: "0 0 var(--r-md) var(--r-md)" }}
        >
          {note}
        </div>
      ) : null}
    </section>
  );
}

// 顶部战绩读数格:扁平等权的 Metric(与详情弹窗「战绩全景」同构)——
// 12px 大写小标 + (?) 口径 + 常规字重的值。这里没有主次,谁重要取决于
// 读者在问什么,所以不给任何一格加粗或放大。
function Kpi({
  label,
  value,
  sub,
  title,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  title?: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="metric__label">
        <span>{label}</span>
        {title ? <HelpMark tip={title} /> : null}
      </div>
      <div className="metric__value">{value}</div>
      {sub != null ? <div className="metric__sub">{sub}</div> : null}
    </div>
  );
}

// 水平比例条:胜率/占比类读数的可视化底座(宽度 = 数值 × 满宽)。走全站
// 比例条的形状 —— 高 6、圆角 99、槽色 = 边框色(.split-bar)。
function PctBar({ ratio, color }: { ratio: number; color: string }) {
  return (
    <div aria-hidden className="split-bar">
      <div
        style={{
          width: `${Math.max(0, Math.min(1, ratio)) * 100}%`,
          height: "100%",
          background: color,
        }}
      />
    </div>
  );
}

// 胜/负/平三段堆叠条:时长桶与赛道行共用。宽度 ∝ 桶内仓数/最大桶仓数,
// 段内比例 = 胜/负/平占比 —— 一眼同时读出"量"与"质"。
function StackBar({
  n,
  maxN,
  wins,
  losses,
}: {
  n: number;
  maxN: number;
  wins: number;
  losses: number;
}) {
  const pushes = n - wins - losses;
  const width = maxN > 0 ? (n / maxN) * 100 : 0;
  const seg = (count: number, color: string, key: string) =>
    count > 0 ? (
      <div
        key={key}
        style={{ flex: count, background: color, height: "100%" }}
      />
    ) : null;
  return (
    <div aria-hidden className="split-bar">
      <div style={{ width: `${width}%`, height: "100%", display: "flex" }}>
        {seg(wins, "var(--ww-up)", "w")}
        {seg(losses, "var(--ww-down)", "l")}
        {seg(pushes, "var(--ww-border-dashed)", "p")}
      </div>
    </div>
  );
}

/* ----------------------------------------------------- odds calibration */

// 赔率带校准行:每桶两根条 —— 实际胜率(brand)对照隐含胜率(灰,= 均入场
// 价,市场定价的概率)。edge 胶囊放右侧;n<阈值挂琥珀「样本不足」徽章
// (诚实降权,不隐藏、也不整行淡显 —— 淡显会把徽章一起淡掉)。
function OddsRow({ b }: { b: OddsBucket }) {
  const { t } = useLang();
  const lowSample = b.n > 0 && b.n < BUCKET_LOW_SAMPLE_N;
  const rowStyle: CSSProperties = {
    display: "grid",
    // 各列下限按 375px 视口反推:弹窗内容区实测仅 ~277px,四列最小宽 +
    // 条列内部(1fr 含 44px 百分比标签)+ 3×8px 间距合计须 <277,否则出
    // 横向滚动(2026-08-13 真机实测踩过 294/310 两版溢出)。
    gridTemplateColumns:
      "minmax(64px, 96px) 1fr minmax(52px, 76px) minmax(56px, 84px)",
    gap: "var(--s-2)",
    alignItems: "center",
    // 行不做任何行级强调:样本不足由琥珀徽章标出、零仓由「·」占位标出。
    // (整行淡显会把用来分轻重的徽章一起淡掉,反倒最弱 —— 矩阵那种 0.42
    // 只落在没有徽章的单元格上。)
  };
  return (
    <div style={rowStyle}>
      <div>
        <div style={{ fontSize: "var(--t-md)" }}>{b.label}</div>
        <div
          className="kpi-sub"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--s-2)",
            flexWrap: "wrap",
          }}
        >
          <span>{t("{n} 仓", { n: b.n })}</span>
          {/* 样本不足是「需留神的口径」,走琥珀描边徽章而不是灰字后缀 */}
          {lowSample ? (
            <span className="ds-tag ds-tag--warn ds-tag--sm">
              {t("样本不足")}
            </span>
          ) : null}
        </div>
      </div>
      {b.n === 0 ? (
        <div className="ds-hint">{t("无仓位")}</div>
      ) : (
        <div style={{ display: "grid", gap: 3 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 44px",
              gap: "var(--s-2)",
              alignItems: "center",
            }}
          >
            <PctBar
              ratio={b.winRate ?? 0}
              color={
                b.winRate == null ? "var(--ww-border-dashed)" : "var(--ww-link)"
              }
            />
            <span style={{ fontSize: "var(--t-sm)" }}>
              {b.winRate == null ? (
                <span className="muted">—</span>
              ) : (
                fmtPct0(b.winRate)
              )}
            </span>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 44px",
              gap: "var(--s-2)",
              alignItems: "center",
            }}
          >
            <PctBar ratio={b.avgEntry ?? 0} color="var(--ww-border-dashed)" />
            <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
              {b.avgEntry == null ? "—" : fmtPct0(b.avgEntry)}
            </span>
          </div>
        </div>
      )}
      <div>
        {b.n === 0 ? (
          // 零仓 = 零值占位「·」(与矩阵格同一符号),与「判不了」的「—」
          // 严格分家:这一档从没下过注,不是「全平局算不出 edge」。
          <span style={{ color: "var(--ww-text-empty)" }}>·</span>
        ) : b.edge == null ? (
          <span className="muted">—</span>
        ) : (
          <span
            className={`ds-tag ds-tag--${b.edge >= 0 ? "up" : "down"}`}
            title={t(
              "edge = 实际胜率 − 隐含胜率(该桶均入场价)。入场价本身就是市场定价的获胜概率,持续为正才是可复制的优势,而不是运气",
            )}
          >
            {fmtSignedPt(b.edge)}
          </span>
        )}
      </div>
      <div style={{ fontSize: "var(--t-md)", textAlign: "right" }}>
        {b.n === 0 ? (
          // 同上:零仓的落袋是「没有这笔」,不是「判不了」。
          <span style={{ color: "var(--ww-text-empty)" }}>·</span>
        ) : (
          <span className={pnlTextClass(b.realized)}>
            {fmtSignedUsd(b.realized)}
          </span>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- dot strip */

// 单仓盈亏散点带:每个已结算仓一个点(x=盈亏$,同值垂直堆叠),赢绿/输红/
// 平灰。几十仓量级下,逐点画比直方图信息量更大且零分箱假设 —— 分布的偏态、
// 离群仓、"输的都是整仓亏光"这类形态一眼可见。宽度用 viewBox + width:100%
// 响应式(与净值走势 Sparkline 同一做法)。
const STRIP_W = 1120;
const STRIP_DOT_R = 4;
const STRIP_BIN_PX = 10; // 同一横向分箱内的点垂直堆叠
const STRIP_ROW_PX = 9;
const STRIP_MAX_H = 150;

function DotStrip({ rows }: { rows: DeepAnalysisRow[] }) {
  // 选中读数:与 WeeklyBars/Sparkline 同一套交互(悬停/Tab 聚焦 → 图上方
  // 信息条),读数含市场标题 —— title 悬停触屏读不到,信息条是第一公民。
  // useState 在空数据提前 return 之前(Hooks 规则)。
  const { t } = useLang();
  const [sel, setSel] = useState<DeepAnalysisRow | null>(null);
  const settled = rows.filter((r) => r.status === "settled");
  if (settled.length === 0) return null;
  const vals = settled.map((r) => r.realized_pnl ?? 0);
  let lo = Math.min(0, ...vals);
  let hi = Math.max(0, ...vals);
  if (hi - lo < 1) {
    // 全 push/单点等退化形态:撑开一个最小域,避免除零把点堆到同一坐标。
    lo -= 1;
    hi += 1;
  }
  const padX = 16;
  const innerW = STRIP_W - padX * 2;
  const x = (v: number) => padX + ((v - lo) / (hi - lo)) * innerW;

  // 分箱堆叠:同一 10px 竖列里的点从基线向上叠,先算每列点数定画布高度。
  const byBin = new Map<number, DeepAnalysisRow[]>();
  for (const r of settled) {
    const bin = Math.round(x(r.realized_pnl ?? 0) / STRIP_BIN_PX);
    const arr = byBin.get(bin);
    if (arr) arr.push(r);
    else byBin.set(bin, [r]);
  }
  const maxStack = Math.max(...[...byBin.values()].map((a) => a.length));
  const axisH = 18;
  const h = Math.min(
    STRIP_MAX_H,
    maxStack * STRIP_ROW_PX + STRIP_DOT_R * 2 + axisH + 6,
  );
  const baseY = h - axisH;

  const dots: ReactNode[] = [];
  for (const [, arr] of byBin) {
    arr.forEach((r, k) => {
      const v = r.realized_pnl ?? 0;
      // 堆过画布顶(极端集中)就压在顶行重叠 —— 不裁剪、不丢点。
      const cy = Math.max(
        STRIP_DOT_R + 1,
        baseY - STRIP_DOT_R - k * STRIP_ROW_PX,
      );
      dots.push(
        <g key={`${r.entry_ts}-${r.exit_ts}-${k}-${v}`}>
          <circle
            cx={x(v)}
            cy={cy}
            r={STRIP_DOT_R}
            fill={v === 0 ? "var(--ww-text-faint)" : pnlColor(v)}
            fillOpacity={sel === r ? 1 : 0.85}
            stroke={sel === r ? "var(--ww-text)" : "none"}
            strokeWidth={sel === r ? 1.5 : 0}
          >
            <title>{(r.title ? `${r.title} · ` : "") + fmtSignedUsd(v)}</title>
          </circle>
          {/* 放大的透明命中圆(Sparkline 同手法):4px 点太小,鼠标/触屏都
              难精确点中;命中圆挂全部交互事件,可视点只负责画。 */}
          <circle
            cx={x(v)}
            cy={cy}
            r={STRIP_DOT_R + 5}
            fill="transparent"
            tabIndex={0}
            aria-label={(r.title ? `${r.title},` : "") + fmtSignedUsd(v)}
            style={{ cursor: "pointer" }}
            onMouseEnter={() => setSel(r)}
            onMouseLeave={() => setSel(null)}
            onFocus={() => setSel(r)}
            onBlur={() => setSel(null)}
          />
        </g>,
      );
    });
  }

  const selPnl = sel ? (sel.realized_pnl ?? 0) : 0;
  return (
    <div>
      <div
        className="ds-hint"
        style={{ marginBottom: "var(--s-1)", minHeight: "1.4em" }}
      >
        {sel ? (
          <>
            {sel.title ? (
              <>
                {sel.title}
                <span className="muted"> · </span>
              </>
            ) : null}
            <span className={pnlTextClass(selPnl)}>{fmtSignedUsd(selPnl)}</span>
            <span className="muted">{t(" · 入场 ")}</span>
            <span>{cents(sel.entry_price)}</span>
          </>
        ) : (
          <span className="muted">
            {t("点选或用 Tab 聚焦任意点,查看该仓的市场、盈亏与入场价")}
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${STRIP_W} ${h}`}
        width="100%"
        role="img"
        aria-label={t("单仓盈亏分布散点带")}
        style={{ display: "block" }}
      >
        {/* 基线 + 零轴(0 落在域内时才有意义,域必含 0,恒画)。 */}
        <line
          x1={padX}
          y1={baseY}
          x2={STRIP_W - padX}
          y2={baseY}
          stroke="var(--ww-border)"
        />
        <line
          x1={x(0)}
          y1={6}
          x2={x(0)}
          y2={baseY}
          stroke="var(--ww-border-dashed)"
          strokeDasharray="3 3"
        />
        {dots}
        {/* 轴标签与正文同字体(这套皮数字不用等宽);0 是刻度不是读数,弱一档 */}
        <text x={padX} y={h - 4} fontSize={11} fill="var(--ww-text-muted)">
          {fmtSignedUsd(lo)}
        </text>
        <text
          x={x(0)}
          y={h - 4}
          fontSize={11}
          fill="var(--ww-text-faint)"
          textAnchor="middle"
        >
          0
        </text>
        <text
          x={STRIP_W - padX}
          y={h - 4}
          fontSize={11}
          fill="var(--ww-text-muted)"
          textAnchor="end"
        >
          {fmtSignedUsd(hi)}
        </text>
      </svg>
    </div>
  );
}

/* ---------------------------------------------------------- weekly bars */

const WEEK_W = 1120;
const WEEK_H = 170;

function WeeklyBars({ weekly }: { weekly: DeepAnalysis["weekly"] }) {
  // 选中读数(2026-08-13,用户定向「图表选中后显示对应数字」):与净值走势
  // Sparkline 的结算点选中完全同一套交互 —— 悬停(onMouseEnter/Leave)与
  // 键盘 Tab(onFocus/Blur)触发同一个选中态,读数显示在图上方的信息条,
  // 不藏进 title 悬停(触屏点按走 focus 路径,同样能读到)。useState 必须
  // 在空数据提前 return 之前(Hooks 规则,Sparkline 同款注释)。
  const { t } = useLang();
  const [selIdx, setSelIdx] = useState<number | null>(null);
  if (weekly.length === 0) return null;
  const padL = 16;
  const padR = 16;
  const padT = 10;
  const axisH = 20;
  const innerW = WEEK_W - padL - padR;
  const innerH = WEEK_H - padT - axisH;
  const vals = weekly.map((w) => w.realized);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const y = (v: number) => padT + ((hi - v) / span) * innerH;
  const zeroY = y(0);
  const slot = innerW / weekly.length;
  const barW = Math.max(3, Math.min(48, slot * 0.62));
  // x 轴标签抽样:最多 ~8 个,首个恒出。
  const labelStep = Math.max(1, Math.ceil(weekly.length / 8));
  const sel = selIdx != null ? weekly[selIdx] : null;
  return (
    <div>
      <div
        className="ds-hint"
        style={{ marginBottom: "var(--s-1)", minHeight: "1.4em" }}
      >
        {sel ? (
          <>
            <span>{t("{d} 那周", { d: fmtWeekLabel(sel.weekStartTs) })}</span>
            <span className="muted"> · </span>
            <span className={pnlTextClass(sel.realized)}>
              {fmtSignedUsd(sel.realized)}
            </span>
            <span className="muted"> · </span>
            <span>{t("{n} 仓结算", { n: sel.settled })}</span>
          </>
        ) : (
          <span className="muted">
            {t("点选或用 Tab 聚焦任意柱,查看该周的盈亏与结算仓数")}
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${WEEK_W} ${WEEK_H}`}
        width="100%"
        role="img"
        aria-label={t("周度已实现盈亏柱状图")}
        style={{ display: "block" }}
      >
        {/* 竖网格线:每根柱一条,走网格线色(比边框更淡,不与柱抢注意力)。 */}
        {weekly.map((w, i) =>
          i % labelStep === 0 ? (
            <line
              key={`g${w.weekStartTs}`}
              x1={padL + slot * i + slot / 2}
              y1={padT}
              x2={padL + slot * i + slot / 2}
              y2={WEEK_H - axisH}
              stroke="var(--ww-gridline)"
            />
          ) : null,
        )}
        <line
          x1={padL}
          y1={zeroY}
          x2={WEEK_W - padR}
          y2={zeroY}
          stroke="var(--ww-border)"
        />
        {weekly.map((w, i) => {
          const cx = padL + slot * i + slot / 2;
          const top = Math.min(zeroY, y(w.realized));
          const hBar = Math.abs(y(w.realized) - zeroY);
          const selected = selIdx === i;
          return (
            <g key={w.weekStartTs}>
              <rect
                x={cx - barW / 2}
                y={top}
                width={barW}
                // 0 盈亏周画 2px 短桩:与"没有柱"区分(那是没数据,这是结了
                // 但打平/空周),读者能看出时间轴在走。
                height={Math.max(hBar, w.settled > 0 ? 2 : 1)}
                fill={
                  w.settled === 0
                    ? "var(--ww-border-dashed)"
                    : pnlColor(w.realized)
                }
                fillOpacity={w.settled === 0 ? 0.8 : selected ? 1 : 0.9}
                stroke={selected ? "var(--ww-text)" : "none"}
                strokeWidth={selected ? 1.5 : 0}
              >
                <title>
                  {t("{d} 那周 · {pnl} · {n} 仓结算", {
                    d: fmtWeekLabel(w.weekStartTs),
                    pnl: fmtSignedUsd(w.realized),
                    n: w.settled,
                  })}
                </title>
              </rect>
              {/* 透明命中带:短桩/细柱难点中,整个竖槽都是这根柱的命中区
                  (与 Sparkline 的放大命中圆同一手法);挂全部交互事件,
                  可视 rect 只负责画。 */}
              <rect
                x={padL + slot * i}
                y={padT}
                width={slot}
                height={innerH}
                fill="transparent"
                tabIndex={0}
                aria-label={t("{d} 那周 {pnl},{n} 仓结算", {
                  d: fmtWeekLabel(w.weekStartTs),
                  pnl: fmtSignedUsd(w.realized),
                  n: w.settled,
                })}
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setSelIdx(i)}
                onMouseLeave={() => setSelIdx(null)}
                onFocus={() => setSelIdx(i)}
                onBlur={() => setSelIdx(null)}
              />
              {i % labelStep === 0 ? (
                <text
                  x={cx}
                  y={WEEK_H - 5}
                  fontSize={11}
                  fill="var(--ww-text-muted)"
                  textAnchor="middle"
                >
                  {fmtWeekLabel(w.weekStartTs)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------- category rows */

// 赛道细分的一组行:一级汇总行 + 缩进的二级子行。两级共用同一条数字串
// 格式与同一个 maxN 比例尺(条长跨行可比,子行必然 ≤ 一级行);样本弱化
// 阈值也共用 BUCKET_LOW_SAMPLE_N —— 子行样本必然更小,弱化会更常见,
// 这正是想要的诚实降权,不为子行单开一档更宽松的阈值。
function CategoryRows({ c, maxN }: { c: CategoryGroup; maxN: number }) {
  const { t } = useLang();
  const row = (
    key: string,
    label: string,
    s: {
      n: number;
      wins: number;
      losses: number;
      winRate: number | null;
      avgEntry: number | null;
      realized: number;
    },
    indent: boolean,
  ) => {
    const lowSample = s.n < BUCKET_LOW_SAMPLE_N;
    return (
      <div
        key={key}
        style={{
          display: "grid",
          // 右列下限 150px(不是撑满一行数字的 210px):375px 视口下弹窗
          // 内容区仅 ~277px,210px 下限会顶出横向滚动(真机实测 310/294
          // 两版溢出教训);150px 时数字串在窄屏自然折成两行,不溢出。
          // 子行缩进吃在第一列内部(paddingLeft)而不是整行 margin ——
          // 三列网格跨行对齐,条形图起点一致才可上下比长短。
          gridTemplateColumns: "minmax(76px, 110px) 1fr minmax(150px, 250px)",
          gap: "var(--s-3)",
          alignItems: "center",
          // 样本不足只由右侧的琥珀徽章标出,不再整行淡显 —— 行级强调会把
          // 徽章一起淡掉(与 TrackStatTable / 赔率带行同一口径)。
        }}
      >
        <span
          style={{
            fontSize: "var(--t-md)",
            // 赛道名不截断:超长换行、行内容顶对齐(全站唯一那条截断规则)。
            lineHeight: "var(--lh-snug)",
            overflowWrap: "anywhere",
            paddingLeft: indent ? 14 : 0,
            color: indent ? "var(--ww-text-muted)" : undefined,
          }}
          title={label}
        >
          {indent ? "└ " : ""}
          {label}
        </span>
        <StackBar n={s.n} maxN={maxN} wins={s.wins} losses={s.losses} />
        <span
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "var(--s-1)",
            fontSize: "var(--t-sm)",
          }}
        >
          <span>{t("{n} 仓", { n: s.n })}</span>
          {lowSample ? (
            <span className="ds-tag ds-tag--warn ds-tag--sm">
              {t("样本不足")}
            </span>
          ) : null}
          <span className="muted">·</span>
          <span>
            {t("胜率")} {s.winRate == null ? "—" : fmtPct0(s.winRate)}
          </span>
          <span className="muted">·</span>
          <span>
            {t("均入场")} {s.avgEntry == null ? "—" : cents(s.avgEntry)}
          </span>
          <span className="muted">·</span>
          <span className={pnlTextClass(s.realized)}>
            {fmtSignedUsd(s.realized)}
          </span>
        </span>
      </div>
    );
  };
  return (
    <>
      {row(c.category, t(catLabel(c.category)), c, false)}
      {c.subs.map((s) =>
        row(
          `${c.category}|${s.subcategory}`,
          t(subLabel(s.subcategory)),
          s,
          true,
        ),
      )}
    </>
  );
}

/* -------------------------------------------------------- edge matrix */

// 矩阵列头:「体育·NBA」;同一级下另有带二级列时,无二级列消歧为
// 「体育·未细分」,否则直接「体育」(不引入没有区分作用的后缀)。
// 首参为调用组件的 t(组件外函数不能调 Hook)。
function matrixHeaderLabel(
  t: TFn,
  tr: EdgeMatrix["tracks"][number],
  tracks: EdgeMatrix["tracks"],
): string {
  if (tr.subcategory) return fineLabelT(t, tr.category, tr.subcategory);
  const hasSubbedSibling = tracks.some(
    (o) => o.category === tr.category && o.subcategory,
  );
  return hasSubbedSibling
    ? `${t(catLabel(tr.category))}·${t("未细分")}`
    : t(catLabel(tr.category));
}

/**
 * 赛道 edge 矩阵表格(纯呈现,矩阵由调用方 buildEdgeMatrix 好传入)。两个
 * 消费方:策略中心页「优势矩阵」副 tab(全部+各策略 × 细赛道)与详情弹窗
 * 深度分析的「赛道 edge 对照」块(本策略 vs 全部两行)。格子 = edge±pt +
 * 胜率·仓数 + 落袋;n<阈值淡显到 0.42、零仓画零值占位「·」、全 push 段
 * edge 为 null 画「—」(判不了,不是零 —— 两个符号严格分家);
 * aggregateId 指定哪一行贴「聚合」名称标(跨档重复下注的那一行)。
 */
export function EdgeMatrixTable({
  matrix,
  aggregateId,
}: {
  matrix: EdgeMatrix;
  aggregateId?: number;
}) {
  const { t } = useLang();
  // 空态给内容也给出路,不返回 null(副 tab 选中却空手而归会像坏了)。
  if (matrix.tracks.length === 0) {
    return (
      <div className="ds-empty">
        {t(
          "暂无可透视的赛道 — 有仓位结算后这里会给出「哪类信号在哪个赛道有 edge」的矩阵",
        )}
      </div>
    );
  }
  return (
    <div className="ds-table-wrap">
      <table className="ds-table">
        <thead>
          <tr>
            <th>{t("策略")}</th>
            {matrix.tracks.map((tr) => (
              <th
                key={tr.key}
                style={{ textAlign: "center" }}
                title={t("全体样本 {n} 仓", { n: tr.totalN })}
              >
                {matrixHeaderLabel(t, tr, matrix.tracks)}
                {/* 列头带全体样本数 —— 列序就是按它降序排的,写出来读者才
                    知道这一列凭什么排在这。 */}
                <span
                  className="kpi-sub"
                  style={{
                    display: "block",
                    marginTop: 2,
                    fontSize: "var(--t-sm)",
                    fontWeight: 400,
                  }}
                >
                  {`n=${tr.totalN}`}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((r) => (
            <tr key={r.id}>
              <td data-label={t("策略")}>
                {t(r.name)}
                {aggregateId != null && r.id === aggregateId ? (
                  <>
                    {" "}
                    <span className="ds-tag">{t("聚合")}</span>
                  </>
                ) : null}
              </td>
              {r.cells.map((cell, i) => {
                const track = matrix.tracks[i];
                const label = matrixHeaderLabel(t, track, matrix.tracks);
                if (!cell) {
                  // 零仓 = 零值占位「·」(--ww-text-empty),与 edge 为 0
                  // 严格分家,也与「判不了」的「—」分家。
                  return (
                    <td
                      key={track.key}
                      data-label={label}
                      style={{ textAlign: "center" }}
                      title={t("该策略在该赛道零仓 —— 与 edge 为 0 严格分家")}
                    >
                      <span style={{ color: "var(--ww-text-empty)" }}>·</span>
                    </td>
                  );
                }
                const low = cell.n < BUCKET_LOW_SAMPLE_N;
                const tip =
                  t("{name} × {label}:{n} 仓 {rec},", {
                    name: t(r.name),
                    label,
                    n: cell.n,
                    rec: fmtRecord(t, cell.wins, cell.losses, cell.pushes),
                  }) +
                  (cell.winRate != null && cell.avgEntry != null
                    ? t("胜率 {a}% vs 隐含 {b}%,", {
                        a: Math.round(cell.winRate * 100),
                        b: Math.round(cell.avgEntry * 100),
                      })
                    : "") +
                  t("落袋 {pnl}", { pnl: fmtSignedUsd(cell.realized) }) +
                  (low ? t(";样本不足,读数仅供方向参考") : "");
                return (
                  <td
                    key={track.key}
                    data-label={label}
                    title={tip}
                    style={{
                      textAlign: "center",
                      // <5 仓的格子淡显 —— 不是「没 edge」,是「这一格还
                      // 判不了」。
                      opacity: low ? 0.42 : undefined,
                    }}
                  >
                    {cell.edge == null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className={pnlTextClass(cell.edge)}>
                        {fmtSignedPt(cell.edge)}
                      </span>
                    )}
                    {/* 三指标竖排(2026-08-13 两轮:先按用户定向加进胜率/
                        落袋,单行拼串把列宽撑到横向滚动、用户反馈「挤在
                        一起」—— 改成 edge / 胜率·仓数 / 落袋 三行竖排,
                        列宽回落到表头文字量级,8 列赛道不再挤爆。 */}
                    <div
                      className="kpi-sub"
                      style={{ marginTop: 2, fontSize: "var(--t-sm)" }}
                    >
                      {cell.winRate == null ? "—" : fmtPct0(cell.winRate)} ·{" "}
                      {t("{n} 仓", { n: cell.n })}
                    </div>
                    <div
                      className="kpi-sub"
                      style={{ marginTop: 2, fontSize: "var(--t-sm)" }}
                    >
                      <span className={pnlTextClass(cell.realized)}>
                        {fmtSignedUsd(cell.realized)}
                      </span>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {/* 降级态说明放在表下方的琥珀条里 —— 三个符号各有各的含义,不能
          都读成 0。sticky:8 列赛道会把表撑到横向滚动,不粘住的话这条会
          整条滑出视区、琥珀底色在容器宽度处断掉(说明必须与表同屏可读)。 */}
      <div
        className="note-strip note-strip--warn"
        style={{ position: "sticky", left: 0 }}
      >
        {t(
          "⚠️ 「·」= 该策略在该赛道零仓,与 edge 为 0 严格分家;「—」= 该格全是平局,没有实际胜率可比,是判不了不是零;淡显的格子(<{n} 仓)也不是「没 edge」,是这一格还判不了 —— 矩阵是用来选下一档做什么的,不是给现有档打分的。",
          { n: BUCKET_LOW_SAMPLE_N },
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------- track stat table */

/**
 * 赛道竖排统计表(2026-08-13:详情弹窗里「1 行 × N 赛道宽格」的横排矩阵
 * 在弹窗宽度下必然横向滚动、三指标挤成一团 —— 单策略场景转置成
 * 「每赛道一行 × 5 窄列」:竖向扫读、横向对比,任何宽度都不挤。页面级
 * 多策略透视仍用 EdgeMatrixTable 的矩阵形态,两种场景两种形状)。
 * 行序沿用矩阵列序(全体样本降序);样本不足由「样本不足」琥珀徽章标出
 * —— 表格行不做任何行级强调(不调暗、不加边线),轻重只靠徽章颜色。
 */
function TrackStatTable({ rows }: { rows: DeepAnalysisRow[] }) {
  const { t } = useLang();
  const matrix = buildEdgeMatrix([{ id: 1, name: "本策略", positions: rows }]);
  const items = matrix.tracks
    .map((tr, i) => ({ tr, cell: matrix.rows[0].cells[i] }))
    .filter(
      (
        b,
      ): b is {
        tr: (typeof matrix.tracks)[number];
        cell: NonNullable<(typeof matrix.rows)[0]["cells"][number]>;
      } => b.cell != null,
    );
  // 空态给内容,不返回 null。
  if (items.length === 0) {
    return (
      <div className="ds-empty">
        {t("暂无可统计的赛道 — 有仓位结算后这里会逐赛道给出 edge、胜率与落袋")}
      </div>
    );
  }
  return (
    // 这张表永远长在 Block 卡里 —— 去掉嵌套阴影(卡中卡两层深度太吵),
    // 只留 1px 分格边。
    <div className="ds-table-wrap" style={{ boxShadow: "none" }}>
      <table className="ds-table">
        <thead>
          <tr>
            <th>{t("赛道")}</th>
            <th className="is-right">
              edge
              <HelpMark
                tip={t(
                  "实际胜率 − 隐含胜率(该赛道均入场价)。持续为正才是可复制的优势",
                )}
              />
            </th>
            <th className="is-right">{t("胜率")}</th>
            <th className="is-right">
              {t("落袋")}
              <HelpMark tip={t("该赛道已结算仓的累计已实现盈亏")} />
            </th>
            <th className="is-right">{t("仓数")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map(({ tr, cell }) => {
            const low = cell.n < BUCKET_LOW_SAMPLE_N;
            return (
              <tr key={tr.key}>
                {/* 赛道名不截断:换行,最多两行 */}
                <td data-label={t("赛道")} className="cell-wrap">
                  {matrixHeaderLabel(t, tr, matrix.tracks)}
                </td>
                <td data-label="edge" className="is-right">
                  {cell.edge == null ? (
                    <span className="muted">—</span>
                  ) : (
                    <span className={pnlTextClass(cell.edge)}>
                      {fmtSignedPt(cell.edge)}
                    </span>
                  )}
                </td>
                <td data-label={t("胜率")} className="is-right">
                  {cell.winRate == null ? (
                    <span className="muted">—</span>
                  ) : (
                    fmtPct0(cell.winRate)
                  )}
                </td>
                <td data-label={t("落袋")} className="is-right">
                  <span className={pnlTextClass(cell.realized)}>
                    {fmtSignedUsd(cell.realized)}
                  </span>
                </td>
                <td data-label={t("仓数")} className="is-right">
                  {cell.n}
                  {/* 样本不足 = 需留神的口径 → 琥珀徽章,不再整行调暗 */}
                  {low ? (
                    <>
                      {" "}
                      <span
                        className="ds-tag ds-tag--warn ds-tag--sm"
                        title={t("样本不足,读数仅供方向参考")}
                      >
                        {t("样本不足")}
                      </span>
                    </>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {/* 降级态说明:同一份矩阵数据的两种形态,读法必须同样写全 ——
          转置表里 edge/胜率同样会画「—」,不给条就只有矩阵那一形态
          有降级态读法。sticky 同 EdgeMatrixTable:滚动时不滑出视区。 */}
      <div
        className="note-strip note-strip--warn"
        style={{ position: "sticky", left: 0 }}
      >
        {t(
          "⚠️ 「—」= 该赛道全是平局,没有实际胜率可比,edge 也就无从算起 —— 是判不了,不是零;标了「样本不足」的行(<{n} 仓)也不是「没 edge」,是这一行还判不了。",
          { n: BUCKET_LOW_SAMPLE_N },
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------ track bubbles */

// 气泡象限图尺寸(与其它大图同一 1120 宽度量级)。
const BUBBLE_W = 1120;
const BUBBLE_H = 430;

// 数据空间的点(隐含胜率 x, 实际胜率 y)。
type Pt = { x: number; y: number };

// 半平面裁剪(Sutherland–Hodgman 单边):把多边形裁到 f(p)≥0 的一侧。
// 用于把「盈亏平衡线上/下方」区域裁进坐标域矩形 —— 区域着色让象限语义
// 不依赖读者自己脑补对角线的哪边是哪边。
function clipHalfplane(poly: Pt[], f: (p: Pt) => number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const fa = f(a);
    const fb = f(b);
    if (fa >= 0) out.push(a);
    if (fa >= 0 !== fb >= 0) {
      const t = fa / (fa - fb);
      out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
    }
  }
  return out;
}

/**
 * 赛道胜率分布气泡象限(2026-08-13;同日按用户反馈重做可视化:初版固定
 * 0–100% 坐标域把数据挤成一团、顶边 100% 胜率的气泡连带标签被裁出画布、
 * 标签互相压盖)。现版:
 *  - 坐标域按数据自适应(留白外扩,夹回 [0,1]),数据铺满画布;
 *  - 盈亏平衡线(实际=隐含)上下两侧用绿/红浅色**区域着色**,象限语义
 *    一眼可读,不再只靠一条虚线;
 *  - 标签防碰撞:上/下/右/左四个候选位贪心放置,放不下只保气泡(悬停/
 *    聚焦仍能从读数条得到全量信息,标签是引导不是唯一出口);
 *  - 内边距按最大气泡半径 + 标签高度预留,任何位置的气泡都不会被裁。
 * 交互与 WeeklyBars/DotStrip 同一套:悬停/Tab 聚焦 → 图上方读数条。
 * 全为平局的赛道没有实际胜率,不上图(诚实缺席,不硬造 0%)。
 */
function TrackBubbles({ rows }: { rows: DeepAnalysisRow[] }) {
  const { t } = useLang();
  const [selKey, setSelKey] = useState<string | null>(null);
  const matrix = buildEdgeMatrix([{ id: 1, name: "本策略", positions: rows }]);
  const bubbles = matrix.tracks
    .map((tr, i) => ({ tr, cell: matrix.rows[0].cells[i] }))
    .filter(
      (
        b,
      ): b is {
        tr: (typeof matrix.tracks)[number];
        cell: NonNullable<(typeof matrix.rows)[0]["cells"][number]>;
      } => b.cell != null && b.cell.winRate != null && b.cell.avgEntry != null,
    )
    // 大气泡先画、小气泡后画(压在上层),小赛道不会被大赛道盖住点不到。
    .sort((a, b) => b.cell.n - a.cell.n);
  if (bubbles.length === 0) {
    return (
      <div className="ds-empty">
        {t("暂无可上图的赛道(全为平局的赛道没有实际胜率,不硬造 0%)")}
      </div>
    );
  }

  const maxN = Math.max(...bubbles.map((b) => b.cell.n));
  const radius = (n: number) => 9 + Math.sqrt(n / maxN) * 15; // 9–24px
  const rMax = radius(maxN);
  const LABEL_H = 15;

  // 坐标域:数据 min/max 外扩留白后夹回 [0,1];跨度太小(全部赛道挤同一
  // 角)时围绕中心撑到最小跨度,避免两个点占满整幅图放大噪音。
  const fitDomain = (vals: number[], pad: number, minSpan: number) => {
    let lo = Math.max(0, Math.min(...vals) - pad);
    let hi = Math.min(1, Math.max(...vals) + pad);
    if (hi - lo < minSpan) {
      const mid = (hi + lo) / 2;
      lo = Math.max(0, mid - minSpan / 2);
      hi = Math.min(1, lo + minSpan);
      lo = Math.max(0, hi - minSpan);
    }
    return { lo, hi };
  };
  const xd = fitDomain(
    bubbles.map((b) => b.cell.avgEntry!),
    0.08,
    0.3,
  );
  const yd = fitDomain(
    bubbles.map((b) => b.cell.winRate!),
    0.1,
    0.3,
  );

  // 内边距:左右/上下都预留最大气泡半径 + 标签高度,边缘气泡不裁。
  const padL = 54;
  const padR = rMax + 12;
  const padT = rMax + LABEL_H + 8;
  const padB = 38 + rMax;
  const x = (v: number) =>
    padL + ((v - xd.lo) / (xd.hi - xd.lo)) * (BUBBLE_W - padL - padR);
  const y = (v: number) =>
    padT + ((yd.hi - v) / (yd.hi - yd.lo)) * (BUBBLE_H - padT - padB);

  // 5 个等距刻度(域端点含入),标签取整百分数。
  const ticksOf = (d: { lo: number; hi: number }) =>
    [0, 0.25, 0.5, 0.75, 1].map((f) => d.lo + f * (d.hi - d.lo));

  // 盈亏平衡线上下区域(数据空间裁剪后映射到屏幕)。
  const domainRect: Pt[] = [
    { x: xd.lo, y: yd.lo },
    { x: xd.hi, y: yd.lo },
    { x: xd.hi, y: yd.hi },
    { x: xd.lo, y: yd.hi },
  ];
  const toScreen = (poly: Pt[]) =>
    poly.map((p) => `${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(" ");
  const abovePoly = clipHalfplane(domainRect, (p) => p.y - p.x);
  const belowPoly = clipHalfplane(domainRect, (p) => p.x - p.y);
  // 盈亏平衡线在域内的可见段。
  const segLo = Math.max(xd.lo, yd.lo);
  const segHi = Math.min(xd.hi, yd.hi);

  // 标签防碰撞:按气泡从大到小贪心放置,候选位 上→下→右→左;与已放标签
  // 矩形相交或出画布则试下一个,全不行就不放(读数条兜底)。宽度按字数
  // 估算(11px 字号的中文/全角约 11px/字,ASCII 约 6.5px)。
  const placed: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const estWidth = (s: string) => {
    let w = 0;
    for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? 11 : 6.5;
    return w;
  };
  const labelPos = new Map<string, { lx: number; ly: number } | null>();
  for (const b of bubbles) {
    // 标签 = 赛道名 + 落袋金额(渲染处的 tspan),宽度按两段合计估算。
    const label = `${matrixHeaderLabel(t, b.tr, matrix.tracks)} ${fmtSignedUsd(b.cell.realized)}`;
    const cx = x(b.cell.avgEntry!);
    const cy = y(b.cell.winRate!);
    const r = radius(b.cell.n);
    const w = estWidth(label);
    const cands = [
      { lx: cx, ly: cy - r - 6 }, // 上
      { lx: cx, ly: cy + r + 13 }, // 下
      { lx: cx + r + 6 + w / 2, ly: cy + 4 }, // 右
      { lx: cx - r - 6 - w / 2, ly: cy + 4 }, // 左
    ];
    let pick: { lx: number; ly: number } | null = null;
    for (const c of cands) {
      const box = {
        x1: c.lx - w / 2,
        y1: c.ly - LABEL_H + 3,
        x2: c.lx + w / 2,
        y2: c.ly + 3,
      };
      const inCanvas =
        box.x1 >= 2 &&
        box.x2 <= BUBBLE_W - 2 &&
        box.y1 >= 2 &&
        box.y2 <= BUBBLE_H - 2;
      const collides = placed.some(
        (p) =>
          !(box.x2 < p.x1 || box.x1 > p.x2 || box.y2 < p.y1 || box.y1 > p.y2),
      );
      if (inCanvas && !collides) {
        pick = c;
        placed.push(box);
        break;
      }
    }
    labelPos.set(b.tr.key, pick);
  }

  const sel = bubbles.find((b) => b.tr.key === selKey) ?? null;
  return (
    <div>
      <div
        className="ds-hint"
        style={{ marginBottom: "var(--s-1)", minHeight: "1.4em" }}
      >
        {sel ? (
          <>
            {matrixHeaderLabel(t, sel.tr, matrix.tracks)}
            <span className="muted">:</span>
            <span>
              {t("{n} 仓", { n: sel.cell.n })} · {t("实际")}{" "}
              {fmtPct0(sel.cell.winRate!)} vs {t("隐含")}{" "}
              {fmtPct0(sel.cell.avgEntry!)}
            </span>
            <span className="muted"> · edge </span>
            <span className={pnlTextClass(sel.cell.edge ?? 0)}>
              {sel.cell.edge == null ? "—" : fmtSignedPt(sel.cell.edge)}
            </span>
            <span className="muted"> · </span>
            <span className={pnlTextClass(sel.cell.realized)}>
              {fmtSignedUsd(sel.cell.realized)}
            </span>
            {sel.cell.n < BUCKET_LOW_SAMPLE_N ? (
              <>
                {" "}
                <span className="ds-tag ds-tag--warn ds-tag--sm">
                  {t("样本不足")}
                </span>
              </>
            ) : null}
          </>
        ) : (
          <span className="muted">
            {t("点选或用 Tab 聚焦任意气泡,查看该赛道的胜率、edge 与落袋")}
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${BUBBLE_W} ${BUBBLE_H}`}
        width="100%"
        role="img"
        aria-label={t("赛道胜率分布气泡象限图")}
        style={{ display: "block" }}
      >
        {/* 盈亏平衡线上下区域着色:绿=实际跑赢隐含(edge>0),红=跑输。 */}
        {abovePoly.length >= 3 ? (
          <polygon
            points={toScreen(abovePoly)}
            fill="var(--ww-up-bg)"
            fillOpacity={0.55}
          />
        ) : null}
        {belowPoly.length >= 3 ? (
          <polygon
            points={toScreen(belowPoly)}
            fill="var(--ww-down-bg)"
            fillOpacity={0.55}
          />
        ) : null}
        {/* 网格 + 轴刻度:网格线走 --ww-gridline(比边框更淡),刻度文字与
            正文同字体 —— 这套皮数字不用等宽。 */}
        {ticksOf(xd).map((t) => (
          <g key={`x${t}`}>
            <line
              x1={x(t)}
              y1={padT - rMax}
              x2={x(t)}
              y2={BUBBLE_H - padB + rMax}
              stroke="var(--ww-gridline)"
              strokeDasharray="2 4"
            />
            <text
              x={x(t)}
              y={BUBBLE_H - 10}
              fontSize={11}
              fill="var(--ww-text-muted)"
              textAnchor="middle"
            >
              {Math.round(t * 100)}¢
            </text>
          </g>
        ))}
        {ticksOf(yd).map((t) => (
          <g key={`y${t}`}>
            <line
              x1={padL - 6}
              y1={y(t)}
              x2={BUBBLE_W - padR + rMax}
              y2={y(t)}
              stroke="var(--ww-gridline)"
              strokeDasharray="2 4"
            />
            <text
              x={padL - 10}
              y={y(t) + 4}
              fontSize={11}
              fill="var(--ww-text-muted)"
              textAnchor="end"
            >
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        {/* 盈亏平衡线(实际 = 隐含)。域不重叠时(理论上不会)不画。 */}
        {segLo < segHi ? (
          <line
            x1={x(segLo)}
            y1={y(segLo)}
            x2={x(segHi)}
            y2={y(segHi)}
            stroke="var(--ww-border-dashed)"
            strokeDasharray="5 4"
            strokeWidth={1.5}
          />
        ) : null}
        {/* 区域语义标注:贴左上/右下角,不与数据抢地方。 */}
        {abovePoly.length >= 3 ? (
          <text
            x={padL + 8}
            y={padT - rMax + 14}
            fontSize={11}
            fill="var(--ww-up)"
          >
            {t("▲ 跑赢隐含(edge>0)")}
          </text>
        ) : null}
        {belowPoly.length >= 3 ? (
          <text
            x={BUBBLE_W - padR - 4}
            y={BUBBLE_H - padB + rMax - 6}
            fontSize={11}
            fill="var(--ww-down)"
            textAnchor="end"
          >
            {t("▼ 跑输隐含(edge<0)")}
          </text>
        ) : null}
        {bubbles.map((b) => {
          const cx = x(b.cell.avgEntry!);
          const cy = y(b.cell.winRate!);
          const r = radius(b.cell.n);
          const low = b.cell.n < BUCKET_LOW_SAMPLE_N;
          const selected = selKey === b.tr.key;
          const label = matrixHeaderLabel(t, b.tr, matrix.tracks);
          const pos = labelPos.get(b.tr.key);
          // 气泡颜色 = 落袋盈亏(2026-08-13 两轮裁决的终点:先因「绿气泡躺
          // 红区」改成 edge 同色,用户复盘后定为**收益语义** —— 绿圈=这个
          // 赛道在赚钱,是读者第一想知道的事)。位置(相对对角线)讲 edge、
          // 颜色讲钱,两变量可能不同号(足球:负 edge 仍小赚 +$6),这个
          // 组合本身就是要暴露的形态;歧义由标签金额 + hint 说明 + 下表
          // 三指标(胜率/落袋/edge)并列消解,不再靠单一颜色扛两个语义。
          const bubbleColor = pnlColor(b.cell.realized);
          // 选中一个气泡时其余降到 0.2(与图例高亮同一条规则:淡化必须
          // 连描边一起,不然实心的圈会浮在淡掉的填色上)。
          const dim = selKey != null && !selected;
          return (
            <g key={b.tr.key} opacity={dim ? 0.2 : 1}>
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill={bubbleColor}
                fillOpacity={selected ? 0.7 : 0.45}
                stroke={bubbleColor}
                strokeWidth={selected ? 2.5 : 1.5}
                strokeDasharray={low ? "3 2" : undefined}
              />
              {pos ? (
                <text
                  x={pos.lx}
                  y={pos.ly}
                  fontSize={11}
                  fill="var(--ww-text)"
                  textAnchor="middle"
                  // 层级不靠加粗:选中项只回到 500,不跳 700。
                  fontWeight={selected ? 500 : 400}
                >
                  {label}
                  <tspan fill={pnlColor(b.cell.realized)}>
                    {" "}
                    {fmtSignedUsd(b.cell.realized)}
                  </tspan>
                </text>
              ) : null}
              {/* 命中区 = 气泡本体(已 ≥9px);挂全部交互,可视圆只负责画。 */}
              <circle
                cx={cx}
                cy={cy}
                r={Math.max(r, 14)}
                fill="transparent"
                tabIndex={0}
                aria-label={t(
                  "{label}:{n} 仓,实际胜率 {a},隐含 {b},落袋 {pnl}",
                  {
                    label,
                    n: b.cell.n,
                    a: fmtPct0(b.cell.winRate!),
                    b: fmtPct0(b.cell.avgEntry!),
                    pnl: fmtSignedUsd(b.cell.realized),
                  },
                )}
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setSelKey(b.tr.key)}
                onMouseLeave={() => setSelKey(null)}
                onFocus={() => setSelKey(b.tr.key)}
                onBlur={() => setSelKey(null)}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
/* --------------------------------------------------------- diagnosis */

const DIMENSION_LABEL: Record<DiagnosedSegment["dimension"], string> = {
  track: "赛道",
  duration: "持有时长",
  odds: "赔率带",
};

// 诊断段的显示名:track 段用「体育·NBA」合成,其余用桶 label 原文(时长
// 桶中文 label 过 t 命中字典;赔率桶「<20¢」语言中立,t 缺译原样回退)。
function segmentLabel(t: TFn, s: DiagnosedSegment): string {
  return s.dimension === "track"
    ? fineLabelT(t, s.category, s.subcategory)
    : t(s.label);
}

// 缺陷/最强特征的一行:维度胶囊 + 段名 + 数字串 + 反事实。two-line 布局
// (窄屏自动换行),不做表格 —— 段数 ≤6,列表比表格轻。
function SegmentRow({
  s,
  kind,
}: {
  s: DiagnosedSegment;
  kind: "weak" | "strong";
}) {
  const { t } = useLang();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: "var(--s-2)",
        flexWrap: "wrap",
      }}
    >
      {/* 维度是名称标签,走灰底描边 —— 灰底不表示状态 */}
      <span className="ds-tag">{t(DIMENSION_LABEL[s.dimension])}</span>
      {/* 段名不截断、不加粗:层级来自标签与分格线,不来自字重 */}
      <span
        style={{
          fontSize: "var(--t-md)",
          lineHeight: "var(--lh-snug)",
          overflowWrap: "anywhere",
        }}
      >
        {segmentLabel(t, s)}
      </span>
      <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
        {t("{n} 仓", { n: s.n })} {fmtRecord(t, s.wins, s.losses, s.pushes)} ·{" "}
        {t("胜率")} {s.winRate == null ? "—" : fmtPct0(s.winRate)}
        {s.edge != null ? ` · edge ${fmtSignedPt(s.edge)}` : ""}
      </span>
      <span className={pnlTextClass(s.realized)}>
        {fmtSignedUsd(s.realized)}
      </span>
      <span style={{ fontSize: "var(--t-sm)" }}>
        <span className="muted">{t("剔除后 → ")}</span>
        <span className={pnlTextClass(s.totalWithout)}>
          {fmtSignedUsd(s.totalWithout)}
        </span>
      </span>
      {kind === "weak" && s.edge != null && s.edge >= 0 ? (
        <span
          className="ds-tag ds-tag--warn"
          title={t(
            "该段实际胜率并不低于隐含胜率(edge≥0),亏损可能只是短期波动/赔率结构使然 —— 优化前先看样本是否继续恶化,不要对运气过度反应",
          )}
        >
          {t("edge≥0 · 或为波动")}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- panel */

/**
 * 深度分析面板主体。rows = 一批仓位(open 仓只用于头部「不计入」说明),
 * scopeNote 供聚合视图声明跨档重复下注口径。计算就地调用 analyzeBets ——
 * 面板只在弹窗打开时被渲染(父层短路),不需要 memo。
 */
export function DeepAnalysisPanel({
  rows,
  scopeNote,
  exitCounterfactual,
}: {
  rows: DeepAnalysisRow[];
  scopeNote?: string;
  /**
   * 反事实退出摘要(服务端 withExitCounterfactual 算好随视图下发)。
   * 缺失/null = 路径回填中或不可回填,第⑧块整块省略 —— 不硬画空表。
   */
  exitCounterfactual?: ExitCounterfactualSummary | null;
}) {
  const { t } = useLang();
  const a = analyzeBets(rows);
  const diag = diagnoseSegments(rows);
  const q = a.quality;

  if (q.settledCount === 0) {
    return (
      <div className="ds-empty">
        {t(
          "暂无已结算仓位 — 深度分析基于落袋结果,有仓位结算后这里会给出 赔率校准/盈亏分布/时间走势/缺陷诊断/反事实退出等八个维度",
        )}
        {a.openCount > 0 ? t("(当前持有中 {n} 仓)", { n: a.openCount }) : ""}
      </div>
    );
  }

  const maxDurN = Math.max(...a.durationBuckets.map((b) => b.n));
  const maxCatN = Math.max(...a.categories.map((c) => c.n), 1);

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "var(--s-6)" }}
    >
      {/* 口径先行 —— 统计声明放在数据「前面」,不放脚注。灰框 = 口径 /
          设计说明,琥珀框 = 读前必看。 */}
      <div className="ds-callout">
        {t(
          "已结算纸面口径(不含浮盈,不含成本 — 成本见「成本分解」)· 平局 (push)不进胜率分母 · 持有中 {n} 仓不计入下方读数",
          { n: a.openCount },
        )}
      </div>

      {/* 跨档重复下注是「需留神的口径」,单独一条琥珀框,不塞进灰条句尾 */}
      {scopeNote ? (
        <div className="ds-callout ds-callout--warn">⚠️ {scopeNote}</div>
      ) : null}

      {q.settledCount < LOW_SAMPLE_THRESHOLD ? (
        <div className="ds-callout ds-callout--warn">
          {t(
            "小样本:仅 {n} 仓已结算(阈值 {m})。下面的全部读数只够看方向,不够下结论 —— 胜率带 Wilson 区间、期望带 t 值,请一起读。",
            { n: q.settledCount, m: LOW_SAMPLE_THRESHOLD },
          )}
        </div>
      ) : null}

      {/* ① 下注质量体检 —— 扁平等权的 Metric 网格:六个读数同字号,
          谁重要取决于读者在问什么;每格的口径收在自己的 (?) 里。 */}
      {/* 这张卡不裁 overflow:格内的 (?) 点开是绝对定位的弹出层,裁了就
          只剩鼠标悬停能读到口径。卡内没有到边的色块,不裁也不露角。 */}
      <section className="ds-card">
        <div className="card-bar" style={{ fontWeight: 600 }}>
          {t("下注质量体检")}
          <span className="muted" style={{ fontWeight: 400 }}>
            {t("· 六个读数 · 每项的口径在自己的 (?) 里")}
          </span>
        </div>
        <div className="metric-grid">
          <Kpi
            label={t("期望 / 仓")}
            title={t(
              "全部已结算仓(含平局)单仓盈亏的算术平均。t 值 = 均值 ÷ 标准误:|t|≥2 约等于「均值显著异于 0」(95% 置信);胜率的 Wilson 区间管不了赔率不对称,期望的不确定性要看这里",
            )}
            value={
              <span className={pnlTextClass(q.expectancyUsd ?? 0)}>
                {q.expectancyUsd == null ? "—" : fmtSignedUsd1(q.expectancyUsd)}
              </span>
            }
            sub={
              q.expectancyT == null
                ? `t=— · n=${q.settledCount}`
                : `t=${q.expectancyT.toFixed(1)} · n=${q.settledCount}`
            }
          />
          <Kpi
            label={t("胜率")}
            title={t(
              "赢仓 ÷(赢仓+输仓),平局不进分母;括号内为 Wilson 95% 区间 —— 小样本下区间比点估计诚实",
            )}
            value={q.winRate == null ? "—" : fmtPct0(q.winRate)}
            sub={`CI ${fmtPct0(q.winRateCI.lo)}–${fmtPct0(q.winRateCI.hi)} · ${fmtRecord(t, q.wins, q.losses, q.pushes)}`}
          />
          <Kpi
            label={t("利润因子")}
            title={t(
              "总盈利 ÷ 总亏损。>1 才在赚钱;1.5 以上通常才值得认真对待。无亏损仓时不给 ∞,显示 —",
            )}
            value={q.profitFactor == null ? "—" : q.profitFactor.toFixed(2)}
            sub={
              q.profitFactor == null && q.wins > 0
                ? t("无亏损仓 · 总盈${a}", { a: fmtUsd0(q.grossProfit) })
                : t("总盈${a} / 总亏${b}", {
                    a: fmtUsd0(q.grossProfit),
                    b: fmtUsd0(q.grossLoss),
                  })
            }
          />
          <Kpi
            label={t("盈亏比")}
            title={t(
              "均盈利仓 ÷ 均亏损仓。固定 $/仓下这主要由入场赔率结构决定:买冷门票赢一次抵几次亏,买热门票反过来 —— 与胜率合起来才是期望",
            )}
            value={q.payoffRatio == null ? "—" : q.payoffRatio.toFixed(2)}
            sub={
              q.avgWinUsd != null || q.avgLossUsd != null
                ? t("均盈{a} / 均亏{b}", {
                    a: q.avgWinUsd == null ? "—" : `$${fmtUsd0(q.avgWinUsd)}`,
                    b: q.avgLossUsd == null ? "—" : `$${fmtUsd0(q.avgLossUsd)}`,
                  })
                : undefined
            }
          />
          <Kpi
            label={t("最长连胜 · 连败")}
            title={t(
              "按结算时间排序的最长连续段(平局跳过不打断)。连败长度是实盘跟单的心理承受力与风控参考",
            )}
            value={
              <>
                <span className="up">{a.streaks.maxWinStreak}</span>
                <span className="muted"> · </span>
                <span className="down">{a.streaks.maxLossStreak}</span>
              </>
            }
            sub={
              a.streaks.current === 0
                ? t("当前无连续段")
                : a.streaks.current > 0
                  ? t("当前 {n} 连赢中", { n: a.streaks.current })
                  : t("当前 {n} 连输中", { n: -a.streaks.current })
            }
          />
          <Kpi
            label={t("Top3 盈利占比")}
            title={t(
              "最大三笔盈利仓占总盈利的比例,以及把这三笔去掉后的净盈亏 —— 检验「是不是几笔大的撑起来的」。占比越高、去掉后转负,说明战绩越依赖尾部运气",
            )}
            value={
              a.concentration.top3WinsShare == null
                ? "—"
                : fmtPct0(a.concentration.top3WinsShare)
            }
            sub={
              a.concentration.netWithoutTop3Wins == null
                ? undefined
                : t("去掉后 {a}", {
                    a: fmtSignedUsd(a.concentration.netWithoutTop3Wins),
                  }) +
                  (a.concentration.top3LossesShare != null
                    ? t(" · Top3 亏损占 {b}", {
                        b: fmtPct0(a.concentration.top3LossesShare),
                      })
                    : "")
            }
          />
        </div>
      </section>

      {/* ② 赔率带校准 */}
      <Block
        label={t("赔率带校准 — 运气还是本事")}
        hint={t(
          "入场价本身就是市场定价的获胜概率(隐含胜率)。每档赔率带对比「实际胜率(蓝)vs 隐含胜率(灰)」:实际持续高于隐含(edge>0)才是可复制的优势;只在某一档赔率带赚钱,也说明策略的钱从哪来",
        )}
        // 降级态读法写全:这张卡里「·」「—」「样本不足」三种成因各不相同,
        // 少列一种读者就会把某一种当成 0(灰条 = 口径说明,与帧 24 同处理)。
        note={t(
          "「·」= 该档赔率带零仓,这个价位区间从没下过注,不是 edge 为 0;「—」= 该档有仓但全是平局,没有实际胜率可比,是判不了不是零;琥珀「样本不足」= 该档 <{n} 仓,读数只够看方向。",
          { n: BUCKET_LOW_SAMPLE_N },
        )}
      >
        <div style={{ display: "grid", gap: "var(--s-3)" }}>
          <div
            className="kpi-sub"
            style={{ display: "flex", gap: "var(--s-4)", flexWrap: "wrap" }}
          >
            <span>
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: "var(--ww-link)",
                  marginRight: 4,
                }}
              />
              {t("实际胜率")}
            </span>
            <span>
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: "var(--ww-border-dashed)",
                  marginRight: 4,
                }}
              />
              {t("隐含胜率(均入场价)")}
            </span>
            <span className="muted">{t("右列 = edge 与该档落袋")}</span>
          </div>
          {a.oddsBuckets.map((b) => (
            <OddsRow key={b.label} b={b} />
          ))}
        </div>
      </Block>

      {/* ③ 单仓盈亏分布 */}
      <Block
        label={t("单仓盈亏分布")}
        hint={t(
          "每个点是一笔已结算仓(绿=赢,红=输,灰=平;同值垂直堆叠)。分布形态直接可读:输的一侧是不是都贴着整仓亏光、赢的一侧靠不靠离群大单",
        )}
      >
        <DotStrip rows={rows} />
        <div className="kpi-sub" style={{ marginTop: "var(--s-2)" }}>
          {t("最佳")} {q.bestPnl == null ? "—" : fmtSignedUsd(q.bestPnl)} ·{" "}
          {t("最差")} {q.worstPnl == null ? "—" : fmtSignedUsd(q.worstPnl)}
        </div>
      </Block>

      {/* ④ 时间走势 */}
      <Block
        label={t("时间走势 — 优势在衰减吗")}
        hint={t(
          "周度已实现盈亏(UTC 周,绿盈红亏,灰短桩=空窗/打平周);下方把全部结算按时间对半切,前半 vs 后半的胜率与落袋对比是小样本下最诚实的衰减检测",
        )}
      >
        <WeeklyBars weekly={a.weekly} />
        {a.halves == null ? (
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            {t("结算不足 6 仓,前半 vs 后半对比暂不显示")}
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: "var(--s-3)",
              marginTop: "var(--s-3)",
            }}
          >
            {(
              [
                ["前半(更早)", a.halves.earlier],
                ["后半(更近)", a.halves.later],
              ] as const
            ).map(([label, h]) => (
              <div
                key={label}
                style={{
                  border: "1px solid var(--ww-border)",
                  borderRadius: "var(--r-btn)",
                  padding: "var(--s-3) var(--s-4)",
                }}
              >
                <div className="ds-label">
                  {t(label)} · {t("{n} 仓", { n: h.n })}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 44px",
                    gap: "var(--s-2)",
                    alignItems: "center",
                    margin: "var(--s-2) 0",
                  }}
                >
                  <PctBar
                    ratio={h.winRate ?? 0}
                    color={
                      h.winRate == null
                        ? "var(--ww-border-dashed)"
                        : "var(--ww-link)"
                    }
                  />
                  <span style={{ fontSize: "var(--t-sm)" }}>
                    {h.winRate == null ? "—" : fmtPct0(h.winRate)}
                  </span>
                </div>
                <div className={pnlTextClass(h.realized)}>
                  {fmtSignedUsd(h.realized)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Block>

      {/* ⑤ 持有时长分布 */}
      <Block
        label={t("持有时长分布")}
        hint={t(
          "条长 ∝ 仓数,分段 = 胜(绿)/负(红)/平(灰)。回答钱是在小时级的快市场(in-play 体育)还是几天的慢市场赢的 —— 也是资金周转率的直观读数",
        )}
      >
        <div style={{ display: "grid", gap: "var(--s-2)" }}>
          {a.durationBuckets.map((b) => (
            <div
              key={b.label}
              style={{
                display: "grid",
                gridTemplateColumns:
                  "minmax(72px, 92px) 1fr minmax(150px, 190px)",
                gap: "var(--s-3)",
                alignItems: "center",
                // 空桶淡显到与「样本不足」同一档,读法全站一致。
                opacity: b.n === 0 ? 0.42 : 1,
              }}
            >
              <span style={{ fontSize: "var(--t-md)" }}>{t(b.label)}</span>
              <StackBar
                n={b.n}
                maxN={maxDurN}
                wins={b.wins}
                losses={b.losses}
              />
              <span style={{ fontSize: "var(--t-sm)" }}>
                {b.n === 0 ? (
                  <span className="muted">{t("{n} 仓", { n: 0 })}</span>
                ) : (
                  <>
                    {t("{n} 仓", { n: b.n })} · {t("胜率")}{" "}
                    {b.winRate == null ? "—" : fmtPct0(b.winRate)} ·{" "}
                    <span className={pnlTextClass(b.realized)}>
                      {fmtSignedUsd(b.realized)}
                    </span>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      </Block>

      {/* ⑥ 赛道细分(两级:一级汇总行 + 缩进的二级子行) */}
      <Block
        label={t("赛道细分")}
        hint={t(
          "按事件赛道(gamma 事件标签)两级重切:一级行是该赛道全部仓,缩进子行按联盟/资产细分(体育里 NBA 与足球的胜率分布差异巨大,混在一个「体育」桶里没有解释力)。子行不是一级的再分配 —— 无二级标签的仓只进一级汇总",
        )}
      >
        {a.categories.length === 0 ? (
          <div className="ds-empty">{t("暂无赛道数据")}</div>
        ) : (
          <div style={{ display: "grid", gap: "var(--s-2)" }}>
            {a.categories.map((c) => (
              <CategoryRows key={c.category} c={c} maxN={maxCatN} />
            ))}
          </div>
        )}
      </Block>

      {/* ⑥.5 赛道胜率分布(2026-08-13 用户定向,两次修订:①去掉「vs 全部」
          基准行,只看本批仓位自己的赛道分布;②气泡象限与表格并存 ——
          象限给形状直觉(谁在盈亏平衡线上方),表格给精确数字,同一份
          矩阵数据的两种读法。 */}
      <Block
        label={t("赛道胜率分布 — 气泡象限")}
        hint={t(
          "横轴 = 隐含胜率(该赛道均入场价,市场定价),纵轴 = 实际胜率;对角线为盈亏平衡 —— 气泡在上方 = 跑赢定价(edge>0)。气泡颜色 = 落袋盈亏(绿 = 赚、红 = 亏),大小 = 仓数,样本 <5 虚线描边。颜色可能与所在区域不同号 —— 位置讲 edge、颜色讲钱(如负 edge 的赛道靠低赔率大赔付仍小幅盈利);下表并列胜率/落袋/edge 三指标,方便逐赛道横比",
        )}
      >
        <TrackBubbles rows={rows} />
        {/* 竖排转置表(每赛道一行 × 5 窄列),不是页面级的横排矩阵 ——
            弹窗宽度装不下「1 行 × N 赛道宽格」,见 TrackStatTable 注释。 */}
        <div style={{ marginTop: "var(--s-3)" }}>
          <TrackStatTable rows={rows} />
        </div>
      </Block>

      {/* ⑦ 缺陷诊断 */}
      <Block
        label={t("缺陷诊断 — 亏在哪类下注")}
        hint={t(
          "把已结算仓按赛道/持有时长(快慢市场)/赔率带三个维度切段,列出「段内 ≥{n} 仓且累计亏损」的特征段(最亏在前,至多 5 段)—— 定向优化的靶点。各段互有重叠(一仓可同时属「足球」与「>7 天」),「剔除后」数字不可相加",
          { n: BUCKET_LOW_SAMPLE_N },
        )}
      >
        {diag.weaknesses.length === 0 ? (
          <div className="ds-empty">
            {t(
              "未发现 ≥{n} 仓且累计亏损的特征段 — 样本继续积累中,或这一档暂无集中的亏损特征",
              { n: BUCKET_LOW_SAMPLE_N },
            )}
          </div>
        ) : (
          <div style={{ display: "grid", gap: "var(--s-2)" }}>
            {diag.weaknesses.map((s) => (
              <SegmentRow
                key={`${s.dimension}|${s.label}|${s.category}|${s.subcategory}`}
                s={s}
                kind="weak"
              />
            ))}
          </div>
        )}
        {diag.strongest ? (
          <div
            style={{
              marginTop: "var(--s-4)",
              paddingTop: "var(--s-4)",
              borderTop: "1px dashed var(--ww-border-dashed)",
            }}
          >
            <div className="ds-hint" style={{ marginBottom: "var(--s-1)" }}>
              {t(
                "对照 · 最强特征(edge>0 且落袋为正 —— 优化是「砍最亏的、 保最强的」两面)",
              )}
            </div>
            <SegmentRow s={diag.strongest} kind="strong" />
          </div>
        ) : null}
      </Block>

      {/* ⑧ 反事实退出(2026-08-16,lib/exitCounterfactual.ts)。数据是已结算
          仓的真实价格路径 × 九个固定退出规则的离线模拟 —— 回答「带止盈/止损/
          限时会怎样」而不必先造活体机制(该方案已否决,见设计文档 §0)。 */}
      {exitCounterfactual && exitCounterfactual.covered > 0 ? (
        <Block
          label="反事实退出 — 如果带止盈/止损/限时会怎样"
          hint={`已回填 ${exitCounterfactual.covered}/${exitCounterfactual.settledTotal} 仓的价格路径(点数中位 ${exitCounterfactual.medianPoints ?? "—"},约 10 分钟一点)· 保守成交口径:按首个越线观测价成交,快盘中触发被系统性低估,Δ 是下界 · 纸面对纸面可比,推及实盘须另计退出侧成本`}
          note={
            <>
              实际合计(基准)
              {fmtSignedUsd(exitCounterfactual.rules[0]?.actualTotal ?? 0)} ·
              Δ&gt;0 = 该规则本会多赚/少亏;「触发仓均Δ」回答触发的那些仓里
              规则是救还是害。九规则互相独立,未触发的仓按实际结算入账。
            </>
          }
        >
          {exitCounterfactual.covered < exitCounterfactual.settledTotal ? (
            <div className="ds-hint" style={{ marginBottom: "var(--s-2)" }}>
              其余{" "}
              {exitCounterfactual.settledTotal - exitCounterfactual.covered}{" "}
              仓路径回填中/不可回填,暂不计入本块。
            </div>
          ) : null}
          <div className="ds-table-wrap" style={{ boxShadow: "none" }}>
            <table className="ds-table ds-table--compact">
              <thead>
                <tr>
                  <th>规则</th>
                  <th className="is-right">触发</th>
                  <th className="is-right">假想合计</th>
                  <th className="is-right">Δ vs 实际</th>
                  <th className="is-right">触发仓均Δ</th>
                </tr>
              </thead>
              <tbody>
                {/* 每格都带 data-label:窄屏下 thead 被视觉隐藏,列名靠
                    td::before 的 attr(data-label) 还原 —— 缺了就是四行
                    没有标签的裸数字(与本文件另两张表同一处理)。 */}
                {exitCounterfactual.rules.map((r) => (
                  <tr key={r.rule}>
                    <td data-label="规则" style={{ whiteSpace: "nowrap" }}>
                      {r.label}
                    </td>
                    <td data-label="触发" className="is-right num">
                      {r.triggered}
                      <span className="muted">
                        /{exitCounterfactual.covered}
                      </span>
                    </td>
                    <td data-label="假想合计" className="is-right num">
                      {fmtSignedUsd(r.simTotal)}
                    </td>
                    <td
                      data-label="Δ vs 实际"
                      className={`is-right num ${r.delta > 0 ? "up" : r.delta < 0 ? "down" : "muted"}`}
                    >
                      {fmtSignedUsd(r.delta)}
                    </td>
                    <td data-label="触发仓均Δ" className="is-right num">
                      {r.avgDeltaTriggered == null ? (
                        <span className="muted">—</span>
                      ) : (
                        fmtSignedUsd(r.avgDeltaTriggered)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Block>
      ) : null}
    </div>
  );
}
