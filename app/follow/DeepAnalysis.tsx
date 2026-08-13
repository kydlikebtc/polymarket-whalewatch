"use client";

// 策略中心「深度分析」面板 —— 对一批历史下注(某一档策略,或按筛选聚合的
// 多档)做六维度可视化分析。计算全部在 lib/followAnalysis.ts(client-safe
// 纯函数、已单测),本文件只负责画;图表沿用全站惯例:内联 SVG/CSS 条形,
// 零图表依赖。设计与维度取舍见
// docs/plans/2026-08-13-strategy-deep-analysis-design.md。
//
// 口径红线(与整页一致,面板头部向读者声明):已结算纸面口径、push 不进
// 胜率分母、小样本读数弱化/置 —,绝不硬算。

import type { CSSProperties, ReactNode } from "react";
import {
  analyzeBets,
  BUCKET_LOW_SAMPLE_N,
  type AnalysisPosition,
  type CategoryGroup,
  type DeepAnalysis,
  type OddsBucket,
} from "../../lib/followAnalysis";
import { catLabel, subLabel } from "../../lib/categoryLabel";
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
  return n >= 0 ? "var(--up-500)" : "var(--down-500)";
}

function pnlTextClass(n: number): string {
  return n >= 0 ? "up" : "down";
}

/* ------------------------------------------------------------ primitives */

// 区块骨架:标题 + 一句"这块在回答什么" + 内容。六个维度共用同一节奏。
function Block({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        borderTop: "1px solid var(--n-150)",
        paddingTop: "var(--s-4)",
      }}
    >
      <div className="ds-label">{label}</div>
      <div className="ds-hint" style={{ margin: "2px 0 var(--s-3)" }}>
        {hint}
      </div>
      {children}
    </section>
  );
}

// 顶部 KPI(与详情弹窗 StrategyFullMetrics 的 Metric 同构,本地重复声明)。
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
    <div title={title}>
      <div className="ds-label">{label}</div>
      <div style={{ marginTop: "var(--s-1)", fontSize: 16, fontWeight: 600 }}>
        {value}
      </div>
      {sub != null ? <div className="kpi-sub mono">{sub}</div> : null}
    </div>
  );
}

// 水平比例条:胜率/占比类读数的可视化底座(宽度 = 数值 × 满宽)。
function PctBar({
  ratio,
  color,
  height = 10,
}: {
  ratio: number;
  color: string;
  height?: number;
}) {
  return (
    <div
      aria-hidden
      style={{
        background: "var(--n-100)",
        borderRadius: 3,
        height,
        overflow: "hidden",
      }}
    >
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
    <div
      aria-hidden
      style={{
        background: "var(--n-100)",
        borderRadius: 3,
        height: 12,
        overflow: "hidden",
      }}
    >
      <div style={{ width: `${width}%`, height: "100%", display: "flex" }}>
        {seg(wins, "var(--up-500)", "w")}
        {seg(losses, "var(--down-500)", "l")}
        {seg(pushes, "var(--n-300)", "p")}
      </div>
    </div>
  );
}

/* ----------------------------------------------------- odds calibration */

// 赔率带校准行:每桶两根条 —— 实际胜率(brand)对照隐含胜率(灰,= 均入场
// 价,市场定价的概率)。edge 胶囊放右侧;n<阈值整行弱化(诚实降权,不隐藏)。
function OddsRow({ b }: { b: OddsBucket }) {
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
    opacity: b.n === 0 ? 0.45 : lowSample ? 0.6 : 1,
  };
  return (
    <div style={rowStyle}>
      <div>
        <div className="mono" style={{ fontSize: "var(--t-sm)" }}>
          {b.label}
        </div>
        <div className="kpi-sub mono">
          {b.n} 仓{lowSample ? " · 样本不足" : ""}
        </div>
      </div>
      {b.n === 0 ? (
        <div className="ds-hint">无仓位</div>
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
              color={b.winRate == null ? "var(--n-200)" : "var(--brand-500)"}
            />
            <span className="mono" style={{ fontSize: "var(--t-xs)" }}>
              {b.winRate == null ? "—" : fmtPct0(b.winRate)}
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
            <PctBar ratio={b.avgEntry ?? 0} color="var(--n-300)" />
            <span className="muted mono" style={{ fontSize: "var(--t-xs)" }}>
              {b.avgEntry == null ? "—" : fmtPct0(b.avgEntry)}
            </span>
          </div>
        </div>
      )}
      <div>
        {b.edge == null ? (
          <span className="muted">—</span>
        ) : (
          <span
            className={`ds-tag ds-tag--${b.edge >= 0 ? "up" : "down"}`}
            title="edge = 实际胜率 − 隐含胜率(该桶均入场价)。入场价本身就是市场定价的获胜概率,持续为正才是可复制的优势,而不是运气"
          >
            {fmtSignedPt(b.edge)}
          </span>
        )}
      </div>
      <div
        className="mono"
        style={{ fontSize: "var(--t-sm)", textAlign: "right" }}
      >
        {b.n === 0 ? (
          <span className="muted">—</span>
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
        <circle
          key={`${r.entry_ts}-${r.exit_ts}-${k}-${v}`}
          cx={x(v)}
          cy={cy}
          r={STRIP_DOT_R}
          fill={v === 0 ? "var(--n-400)" : pnlColor(v)}
          fillOpacity={0.85}
        >
          <title>{(r.title ? `${r.title} · ` : "") + fmtSignedUsd(v)}</title>
        </circle>,
      );
    });
  }

  return (
    <svg
      viewBox={`0 0 ${STRIP_W} ${h}`}
      width="100%"
      role="img"
      aria-label="单仓盈亏分布散点带"
      style={{ display: "block" }}
    >
      {/* 基线 + 零轴(0 落在域内时才有意义,域必含 0,恒画)。 */}
      <line
        x1={padX}
        y1={baseY}
        x2={STRIP_W - padX}
        y2={baseY}
        stroke="var(--n-200)"
      />
      <line
        x1={x(0)}
        y1={6}
        x2={x(0)}
        y2={baseY}
        stroke="var(--n-300)"
        strokeDasharray="3 3"
      />
      {dots}
      <text
        x={padX}
        y={h - 4}
        fontSize={11}
        fill="var(--n-500)"
        fontFamily="var(--font-mono)"
      >
        {fmtSignedUsd(lo)}
      </text>
      <text
        x={x(0)}
        y={h - 4}
        fontSize={11}
        fill="var(--n-500)"
        textAnchor="middle"
        fontFamily="var(--font-mono)"
      >
        0
      </text>
      <text
        x={STRIP_W - padX}
        y={h - 4}
        fontSize={11}
        fill="var(--n-500)"
        textAnchor="end"
        fontFamily="var(--font-mono)"
      >
        {fmtSignedUsd(hi)}
      </text>
    </svg>
  );
}

/* ---------------------------------------------------------- weekly bars */

const WEEK_W = 1120;
const WEEK_H = 170;

function WeeklyBars({ weekly }: { weekly: DeepAnalysis["weekly"] }) {
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
  return (
    <svg
      viewBox={`0 0 ${WEEK_W} ${WEEK_H}`}
      width="100%"
      role="img"
      aria-label="周度已实现盈亏柱状图"
      style={{ display: "block" }}
    >
      <line
        x1={padL}
        y1={zeroY}
        x2={WEEK_W - padR}
        y2={zeroY}
        stroke="var(--n-200)"
      />
      {weekly.map((w, i) => {
        const cx = padL + slot * i + slot / 2;
        const top = Math.min(zeroY, y(w.realized));
        const hBar = Math.abs(y(w.realized) - zeroY);
        return (
          <g key={w.weekStartTs}>
            <rect
              x={cx - barW / 2}
              y={top}
              width={barW}
              // 0 盈亏周画 2px 短桩:与"没有柱"区分(那是没数据,这是结了
              // 但打平/空周),读者能看出时间轴在走。
              height={Math.max(hBar, w.settled > 0 ? 2 : 1)}
              fill={w.settled === 0 ? "var(--n-200)" : pnlColor(w.realized)}
              fillOpacity={w.settled === 0 ? 0.8 : 0.9}
            >
              <title>
                {`${fmtWeekLabel(w.weekStartTs)} 那周 · ${fmtSignedUsd(w.realized)} · ${w.settled} 仓结算`}
              </title>
            </rect>
            {i % labelStep === 0 ? (
              <text
                x={cx}
                y={WEEK_H - 5}
                fontSize={11}
                fill="var(--n-500)"
                textAnchor="middle"
                fontFamily="var(--font-mono)"
              >
                {fmtWeekLabel(w.weekStartTs)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------- category rows */

// 赛道细分的一组行:一级汇总行 + 缩进的二级子行。两级共用同一条数字串
// 格式与同一个 maxN 比例尺(条长跨行可比,子行必然 ≤ 一级行);样本弱化
// 阈值也共用 BUCKET_LOW_SAMPLE_N —— 子行样本必然更小,弱化会更常见,
// 这正是想要的诚实降权,不为子行单开一档更宽松的阈值。
function CategoryRows({ c, maxN }: { c: CategoryGroup; maxN: number }) {
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
          opacity: lowSample ? 0.6 : 1,
        }}
      >
        <span
          style={{
            fontSize: "var(--t-sm)",
            paddingLeft: indent ? 14 : 0,
            color: indent ? "var(--n-600)" : undefined,
          }}
          title={label}
        >
          {indent ? "└ " : ""}
          {label}
        </span>
        <StackBar n={s.n} maxN={maxN} wins={s.wins} losses={s.losses} />
        <span className="mono" style={{ fontSize: "var(--t-xs)" }}>
          {s.n} 仓{lowSample ? "(样本不足)" : ""} · 胜率{" "}
          {s.winRate == null ? "—" : fmtPct0(s.winRate)} · 均入场{" "}
          {s.avgEntry == null ? "—" : cents(s.avgEntry)} ·{" "}
          <span className={pnlTextClass(s.realized)}>
            {fmtSignedUsd(s.realized)}
          </span>
        </span>
      </div>
    );
  };
  return (
    <>
      {row(c.category, catLabel(c.category), c, false)}
      {c.subs.map((s) =>
        row(`${c.category}|${s.subcategory}`, subLabel(s.subcategory), s, true),
      )}
    </>
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
}: {
  rows: DeepAnalysisRow[];
  scopeNote?: string;
}) {
  const a = analyzeBets(rows);
  const q = a.quality;

  if (q.settledCount === 0) {
    return (
      <div className="ds-empty">
        暂无已结算仓位 — 深度分析基于落袋结果,有仓位结算后这里会给出
        赔率校准/盈亏分布/时间走势等六个维度
        {a.openCount > 0 ? `(当前持有中 ${a.openCount} 仓)` : ""}
      </div>
    );
  }

  const maxDurN = Math.max(...a.durationBuckets.map((b) => b.n));
  const maxCatN = Math.max(...a.categories.map((c) => c.n), 1);

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}
    >
      <div className="ds-hint">
        已结算纸面口径(不含浮盈,不含成本 — 成本见「成本分解」)· 平局
        (push)不进胜率分母 · 持有中 {a.openCount} 仓不计入下方读数
        {scopeNote ? (
          <>
            {" "}
            · <span style={{ color: "var(--warn-700)" }}>{scopeNote}</span>
          </>
        ) : null}
      </div>

      {q.settledCount < LOW_SAMPLE_THRESHOLD ? (
        <div className="ds-callout ds-callout--warn">
          小样本:仅 {q.settledCount} 仓已结算(阈值 {LOW_SAMPLE_THRESHOLD}
          )。下面的全部读数只够看方向,不够下结论 —— 胜率带 Wilson 区间、期望带 t
          值,请一起读。
        </div>
      ) : null}

      {/* ① 下注质量体检 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: "var(--s-3) var(--s-4)",
        }}
      >
        <Kpi
          label="期望 / 仓"
          title="全部已结算仓(含平局)单仓盈亏的算术平均。t 值 = 均值 ÷ 标准误:|t|≥2 约等于「均值显著异于 0」(95% 置信);胜率的 Wilson 区间管不了赔率不对称,期望的不确定性要看这里"
          value={
            <span className={`mono ${pnlTextClass(q.expectancyUsd ?? 0)}`}>
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
          label="胜率"
          title="赢仓 ÷(赢仓+输仓),平局不进分母;括号内为 Wilson 95% 区间 —— 小样本下区间比点估计诚实"
          value={
            <span className="mono">
              {q.winRate == null ? "—" : fmtPct0(q.winRate)}
            </span>
          }
          sub={`CI ${fmtPct0(q.winRateCI.lo)}–${fmtPct0(q.winRateCI.hi)} · ${q.wins}胜${q.losses}负${q.pushes > 0 ? `${q.pushes}平` : ""}`}
        />
        <Kpi
          label="利润因子"
          title="总盈利 ÷ 总亏损。>1 才在赚钱;1.5 以上通常才值得认真对待。无亏损仓时不给 ∞,显示 —"
          value={
            <span className="mono">
              {q.profitFactor == null ? "—" : q.profitFactor.toFixed(2)}
            </span>
          }
          sub={
            q.profitFactor == null && q.wins > 0
              ? `无亏损仓 · 总盈$${fmtUsd0(q.grossProfit)}`
              : `总盈$${fmtUsd0(q.grossProfit)} / 总亏$${fmtUsd0(q.grossLoss)}`
          }
        />
        <Kpi
          label="盈亏比"
          title="均盈利仓 ÷ 均亏损仓。固定 $/仓下这主要由入场赔率结构决定:买冷门票赢一次抵几次亏,买热门票反过来 —— 与胜率合起来才是期望"
          value={
            <span className="mono">
              {q.payoffRatio == null ? "—" : q.payoffRatio.toFixed(2)}
            </span>
          }
          sub={
            q.avgWinUsd != null || q.avgLossUsd != null
              ? `均盈${q.avgWinUsd == null ? "—" : `$${fmtUsd0(q.avgWinUsd)}`} / 均亏${q.avgLossUsd == null ? "—" : `$${fmtUsd0(q.avgLossUsd)}`}`
              : undefined
          }
        />
        <Kpi
          label="最长连胜 · 连败"
          title="按结算时间排序的最长连续段(平局跳过不打断)。连败长度是实盘跟单的心理承受力与风控参考"
          value={
            <span className="mono">
              <span className="up">{a.streaks.maxWinStreak}</span>
              <span className="muted"> · </span>
              <span className="down">{a.streaks.maxLossStreak}</span>
            </span>
          }
          sub={
            a.streaks.current === 0
              ? "当前无连续段"
              : a.streaks.current > 0
                ? `当前 ${a.streaks.current} 连赢中`
                : `当前 ${-a.streaks.current} 连输中`
          }
        />
        <Kpi
          label="Top3 盈利占比"
          title="最大三笔盈利仓占总盈利的比例,以及把这三笔去掉后的净盈亏 —— 检验「是不是几笔大的撑起来的」。占比越高、去掉后转负,说明战绩越依赖尾部运气"
          value={
            <span className="mono">
              {a.concentration.top3WinsShare == null
                ? "—"
                : fmtPct0(a.concentration.top3WinsShare)}
            </span>
          }
          sub={
            a.concentration.netWithoutTop3Wins == null
              ? undefined
              : `去掉后 ${fmtSignedUsd(a.concentration.netWithoutTop3Wins)}${
                  a.concentration.top3LossesShare != null
                    ? ` · Top3 亏损占 ${fmtPct0(a.concentration.top3LossesShare)}`
                    : ""
                }`
          }
        />
      </div>

      {/* ② 赔率带校准 */}
      <Block
        label="赔率带校准 — 运气还是本事"
        hint="入场价本身就是市场定价的获胜概率(隐含胜率)。每档赔率带对比「实际胜率(蓝)vs 隐含胜率(灰)」:实际持续高于隐含(edge>0)才是可复制的优势;只在某一档赔率带赚钱,也说明策略的钱从哪来"
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
                  background: "var(--brand-500)",
                  marginRight: 4,
                }}
              />
              实际胜率
            </span>
            <span>
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: "var(--n-300)",
                  marginRight: 4,
                }}
              />
              隐含胜率(均入场价)
            </span>
            <span className="muted">右列 = edge 与该档落袋</span>
          </div>
          {a.oddsBuckets.map((b) => (
            <OddsRow key={b.label} b={b} />
          ))}
        </div>
      </Block>

      {/* ③ 单仓盈亏分布 */}
      <Block
        label="单仓盈亏分布"
        hint="每个点是一笔已结算仓(绿=赢,红=输,灰=平;同值垂直堆叠)。分布形态直接可读:输的一侧是不是都贴着整仓亏光、赢的一侧靠不靠离群大单"
      >
        <DotStrip rows={rows} />
        <div className="kpi-sub mono" style={{ marginTop: "var(--s-1)" }}>
          最佳 {q.bestPnl == null ? "—" : fmtSignedUsd(q.bestPnl)} · 最差{" "}
          {q.worstPnl == null ? "—" : fmtSignedUsd(q.worstPnl)}
        </div>
      </Block>

      {/* ④ 时间走势 */}
      <Block
        label="时间走势 — 优势在衰减吗"
        hint="周度已实现盈亏(UTC 周,绿盈红亏,灰短桩=空窗/打平周);下方把全部结算按时间对半切,前半 vs 后半的胜率与落袋对比是小样本下最诚实的衰减检测"
      >
        <WeeklyBars weekly={a.weekly} />
        {a.halves == null ? (
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            结算不足 6 仓,前半 vs 后半对比暂不显示
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
                  border: "1px solid var(--n-150)",
                  borderRadius: 6,
                  padding: "var(--s-3)",
                }}
              >
                <div className="ds-label">
                  {label} · {h.n} 仓
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
                      h.winRate == null ? "var(--n-200)" : "var(--brand-500)"
                    }
                  />
                  <span className="mono" style={{ fontSize: "var(--t-xs)" }}>
                    {h.winRate == null ? "—" : fmtPct0(h.winRate)}
                  </span>
                </div>
                <div className={`mono ${pnlTextClass(h.realized)}`}>
                  {fmtSignedUsd(h.realized)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Block>

      {/* ⑤ 持有时长分布 */}
      <Block
        label="持有时长分布"
        hint="条长 ∝ 仓数,分段 = 胜(绿)/负(红)/平(灰)。回答钱是在小时级的快市场(in-play 体育)还是几天的慢市场赢的 —— 也是资金周转率的直观读数"
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
                opacity: b.n === 0 ? 0.45 : 1,
              }}
            >
              <span className="mono" style={{ fontSize: "var(--t-sm)" }}>
                {b.label}
              </span>
              <StackBar
                n={b.n}
                maxN={maxDurN}
                wins={b.wins}
                losses={b.losses}
              />
              <span className="mono" style={{ fontSize: "var(--t-xs)" }}>
                {b.n === 0 ? (
                  <span className="muted">0 仓</span>
                ) : (
                  <>
                    {b.n} 仓 · 胜率{" "}
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
        label="赛道细分"
        hint="按事件赛道(gamma 事件标签)两级重切:一级行是该赛道全部仓,缩进子行按联盟/资产细分(体育里 NBA 与足球的胜率分布差异巨大,混在一个「体育」桶里没有解释力)。子行不是一级的再分配 —— 无二级标签的仓只进一级汇总"
      >
        {a.categories.length === 0 ? (
          <div className="ds-hint">暂无赛道数据</div>
        ) : (
          <div style={{ display: "grid", gap: "var(--s-2)" }}>
            {a.categories.map((c) => (
              <CategoryRows key={c.category} c={c} maxN={maxCatN} />
            ))}
          </div>
        )}
      </Block>
    </div>
  );
}
