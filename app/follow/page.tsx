"use client";

// 共识跟单 · 纸面模拟看板。只读消费 /api/follow —— 现价进场、持有到结算、固定
// $/信号、仅结算盈亏(不做浮盈)。设计系统组件/类全部复用 app/ui.tsx + globals.css,
// 净值曲线用内联 SVG 阶梯折线(无图表依赖),多策略靠实线/虚线区分而非颜色。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Modal, Segmented, Tag } from "../ui";

/* ------------------------------------------------------------- API types */
// 客户端本地类型:镜像 lib/follow 的视图结构,但独立声明,避免把 server 侧
// (better-sqlite3 依赖链)拖进浏览器 bundle。title/event_slug 为 route 直选列,
// 运行时存在、类型上设为可选以保持宽容。

type FollowPositionRow = {
  strategy_id: number;
  condition_id: string;
  outcome: string;
  title?: string;
  event_slug?: string;
  size_usd: number;
  entry_price: number;
  smart_avg_price: number;
  shares: number;
  status: "open" | "settled";
  entry_ts: number;
  exit_ts: number | null;
  exit_price: number | null;
  realized_pnl: number | null;
  // P1 三段成本分解归因列(route 直选,老仓位/取价失败为 null;类型上设可选以对
  // 旧响应宽容):formation_ts/price = 共识形成时刻与彼时市价,markout_30m/2h =
  // 形成后 30min/2h 的回填市价。只用于归因展示,绝不参与盈亏计算。
  formation_ts?: number | null;
  formation_price?: number | null;
  markout_30m?: number | null;
  markout_2h?: number | null;
};

type StrategyMetrics = {
  totalRealized: number;
  invested: number;
  roi: number | null;
  wins: number;
  settledCount: number;
  winRate: number | null;
  winRateCI: { lo: number; hi: number };
  openCount: number;
  avgHoldingDays: number | null;
  maxDrawdown: number;
  slippageCost: number;
  equityCurve: { ts: number; cum: number }[];
  byCategory: Record<string, { realized: number; settledCount: number }>;
};

// 基金式档案(镜像 lib/follow 的 FundMetrics):成立/运行/峰值占用/年化。
type FundMetrics = {
  startTs: number | null;
  runDays: number | null;
  maxConcurrentUsd: number;
  annualizedRoi: number | null;
};

// 账户推演(镜像 lib/follow 的 AccountSimRow/AccountPlan):备多少钱→接住多少。
type AccountSimRow = {
  accountUsd: number;
  taken: number;
  missed: number;
  realizedPnl: number;
  missedPnl: number;
  annualizedRoi: number | null;
  utilization: number | null;
};

type AccountPlan = {
  rows: AccountSimRow[];
  recommendedUsd: number | null;
  suggestedUsd: number | null;
  avgOccupiedUsd: number;
  utilization: number | null;
  annualizedOnRecommended: number | null;
};

type FollowStrategyView = {
  id: number;
  name: string;
  enabled: boolean;
  params: {
    minWallets: number;
    minPerWalletUsd: number;
    sizeUsd: number;
    exitRule: string;
    // 进场价偏离护栏(¢)。server 侧 parseParamsView 恒有值(默认 10);类型上留
    // 可选以对旧响应宽容,展示时按 10 兜底。
    maxEntryDeviationCents?: number;
  };
  metrics: StrategyMetrics;
  // 基金式档案与账户推演:新响应恒有;类型可选以对旧响应宽容,缺失时不渲染/显示「—」。
  fund?: FundMetrics;
  account?: AccountPlan;
  open: FollowPositionRow[];
  settled: FollowPositionRow[];
};

type FollowResponse = {
  strategies: FollowStrategyView[];
  error?: string;
};

// 合并各策略仓位到一张表时,给每行贴上来源策略名(表内可标注归属)。
type LabeledRow = FollowPositionRow & { strategyName: string };

// 仓位明细的两个 tab:已结算 / 持有中(替代旧版上下两段排列)。
type PosTab = "settled" | "open";

// 策略筛选的「全部」哨兵值。策略 id 从 1 起(AUTOINCREMENT),0 不会撞真实 id。
const FILTER_ALL = 0;

/* --------------------------------------------------------------- format */

const MINUS = "−"; // U+2212,与 ui.tsx fmtSignedUsdCompact 一致(不用 ASCII 连字符)

function fmtUsd0(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// 带符号美元:+$1,234 / −$1,234。0 记为 +$0。
function fmtSignedUsd(n: number): string {
  const sign = n < 0 ? MINUS : "+";
  return `${sign}$${fmtUsd0(Math.abs(n))}`;
}

// 概率价(0–1)转美分标签:0.62 → 62.0¢。
function cents(p: number): string {
  return `${(p * 100).toFixed(1)}¢`;
}

// 持有时长:<1 天用小时,否则一位小数的天。
function fmtHold(sec: number): string {
  const days = sec / 86400;
  if (days < 1) return `${Math.max(0, Math.round(days * 24))} 小时`;
  return `${days.toFixed(1)} 天`;
}

// 成立日期:秒时间戳 → YYYY-MM-DD(本地时区,基金档案用)。
function fmtDate(ts: number): string {
  const d = new Date(ts * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// 年化收益率:±X%。|值|≥100% 取整(±1825% 不需要小数),否则一位小数。
function fmtAnnualized(r: number): string {
  const pct = Math.abs(r * 100);
  return `${r >= 0 ? "+" : MINUS}${pct.toFixed(pct >= 100 ? 0 : 1)}%`;
}

// 动作时间:M/D HH:mm(本地时区,操作历史用);完整时间放 title 悬停。
function fmtDateTime(ts: number): string {
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mi}`;
}

function pnlTone(n: number): "up" | "down" {
  return n >= 0 ? "up" : "down";
}

// 单仓追价成本(旧称跟单滑点,美元)= 份额 ×(自己入场价 − 聪明钱建仓均价)。
// 与 lib/follow 的 positionSlippage 同口径,此处就地计算,避免把 server lib 引入客户端。
function rowSlippage(p: FollowPositionRow): number {
  return p.shares * (p.entry_price - p.smart_avg_price);
}

// 单仓追价 ¢ 差 =(自己入场价 − 聪明钱建仓均价)× 100 —— 看板主显示口径。
// 美元口径受份额膨胀影响(入场价越低份额越大,绝对值可超本金),¢ 差才可跨仓横比。
function rowSlipCents(p: FollowPositionRow): number {
  return (p.entry_price - p.smart_avg_price) * 100;
}

// 买入成本三段分解:聪明钱均价 →(信息租金,拿不到别追)→ 形成价 →(延迟成本,
// 系统可优化)→ 进场价。下面两个函数是后两段的展示口径。

// 单仓延迟成本 ¢ =(进场价 − 形成价)× 100。正=共识形成后我们追贵了(检测+执行
// 延迟);formation_price 缺失(老仓位/取价失败)返回 null,由调用方显示「—」。
function rowDelayCents(p: FollowPositionRow): number | null {
  return p.formation_price != null
    ? (p.entry_price - p.formation_price) * 100
    : null;
}

// 形成后 2h 走势 ¢ =(markout_2h − 形成价)× 100,衡量"共识形成后还有没有肉"。
// 两值任一缺失(未到期/回填失败/老仓位)返回 null。
function rowMarkout2hCents(p: FollowPositionRow): number | null {
  return p.markout_2h != null && p.formation_price != null
    ? (p.markout_2h - p.formation_price) * 100
    : null;
}

// 形成后走势着色:这是价格方向(不是成本),沿用全站涨绿跌红语义,与信号验证
// 1h/24h 口径一致 —— ±0.5¢ 死区内记平推(muted)。
function markoutToneClass(c: number): string {
  if (Math.abs(c) <= 0.5) return "muted";
  return c > 0 ? "up" : "down";
}

// 带符号 ¢ 差:+5.9¢ / −19.9¢(0 记 +0.0¢)。
function fmtSignedCents(c: number): string {
  const sign = c < 0 ? MINUS : "+";
  return `${sign}${Math.abs(c).toFixed(1)}¢`;
}

// 追价成本着色原则:一律中性 —— 负值绝不标绿(它常意味着「价格已反向/接飞刀」,
// 不是捡便宜);正值也不标红(不是亏损,是成本)。仅 |¢差| 超过警示线时用琥珀
// (全站琥珀=警示语义),与开仓侧默认护栏 10¢ 同一分界。
const SLIP_WARN_CENTS = 10;
function slipWarnStyle(cents: number): CSSProperties | undefined {
  return Math.abs(cents) > SLIP_WARN_CENTS
    ? { color: "var(--warn-700)" }
    : undefined;
}

// 结算胜率 + Wilson 95% 区间,如「83% · 95%CI 44–97%」。无判定样本时置「—」。
function winRateLabel(m: StrategyMetrics): string {
  if (m.winRate == null) return "—";
  const pct = Math.round(m.winRate * 100);
  const lo = Math.round(m.winRateCI.lo * 100);
  const hi = Math.round(m.winRateCI.hi * 100);
  return `${pct}% · 95%CI ${lo}–${hi}%`;
}

function paramsHint(p: FollowStrategyView["params"]): string {
  const exit = p.exitRule === "settlement" ? "持有到结算" : p.exitRule;
  // 偏离护栏:字段缺失(旧响应)按 10 兜底,与 lib/follow 开仓侧默认一致。
  const maxDev = p.maxEntryDeviationCents ?? 10;
  return `≥${p.minWallets} 钱包 · 每钱包 ≥$${fmtUsd0(
    p.minPerWalletUsd,
  )} · $${fmtUsd0(p.sizeUsd)}/信号 · 偏离≤${maxDev}¢ · ${exit}`;
}

// 市场展示名:优先 title,回退到 event_slug / condition_id。
function marketLabel(p: FollowPositionRow): string {
  return p.title || p.event_slug || p.condition_id;
}

/* ---------------------------------------------------- equity curve (SVG) */

// 多策略叠加:主要靠虚实(dash)区分,颜色只做辅助且刻意避开绿/红(那是盈亏语义)。
// 全部取设计系统 token,dark 模式随 token 走。
const STRATEGY_STROKES = [
  { dash: undefined as string | undefined, color: "var(--brand-500)" },
  { dash: "7 4", color: "var(--n-500)" },
  { dash: "2 4", color: "var(--brand-700)" },
  { dash: "10 4 2 4", color: "var(--n-700)" },
];
const strokeFor = (i: number) => STRATEGY_STROKES[i % STRATEGY_STROKES.length];

type CurveSeries = {
  id: number;
  name: string;
  strokeIdx: number;
  curve: { ts: number; cum: number }[];
};

// 阶梯折线(step-after):每个结算点之前维持前一水平,到该点垂直跳变到新累计值。
function stepPath(
  curve: { ts: number; cum: number }[],
  sx: (t: number) => number,
  sy: (v: number) => number,
): string {
  if (curve.length === 0) return "";
  const pts = [...curve].sort((a, b) => a.ts - b.ts);
  let d = `M ${sx(pts[0].ts).toFixed(1)} ${sy(pts[0].cum).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const x = sx(pts[i].ts).toFixed(1);
    d += ` L ${x} ${sy(pts[i - 1].cum).toFixed(1)}`;
    d += ` L ${x} ${sy(pts[i].cum).toFixed(1)}`;
  }
  return d;
}

const axisFmt = (v: number) => `${v < 0 ? MINUS : ""}$${fmtUsd0(Math.abs(v))}`;

function EquityCurve({ series }: { series: CurveSeries[] }) {
  const withData = series.filter((s) => s.curve.length > 0);
  if (withData.length === 0) {
    return (
      <div className="ds-empty">
        暂无已结算仓位 — 有策略平仓后这里会画出结算净值阶梯曲线
      </div>
    );
  }

  const W = 720;
  const H = 220;
  const padL = 48;
  const padR = 12;
  const padT = 14;
  const padB = 26;
  const x0 = padL;
  const x1 = W - padR;
  const y0 = padT;
  const y1 = H - padB;

  // x 域:所有策略的结算时间戳;y 域:累计已实现盈亏,始终含 0 基线。
  let tMin = Infinity;
  let tMax = -Infinity;
  let cMin = 0;
  let cMax = 0;
  for (const s of withData) {
    for (const pt of s.curve) {
      if (pt.ts < tMin) tMin = pt.ts;
      if (pt.ts > tMax) tMax = pt.ts;
      if (pt.cum < cMin) cMin = pt.cum;
      if (pt.cum > cMax) cMax = pt.cum;
    }
  }
  const padY = (cMax - cMin) * 0.08 || 1; // 峰谷各留一点头部空间;全平时给 1
  const yMax = cMax + padY;
  const yMin = cMin - padY;

  const tSpan = tMax - tMin;
  const sx = (t: number) =>
    tSpan === 0 ? (x0 + x1) / 2 : x0 + ((t - tMin) / tSpan) * (x1 - x0);
  const ySpan = yMax - yMin;
  const sy = (v: number) =>
    ySpan === 0 ? (y0 + y1) / 2 : y1 - ((v - yMin) / ySpan) * (y1 - y0);

  const yZero = sy(0);

  // x 轴时间刻度:端点 + 两个三分点(等距,不追求整点对齐——结算是离散事件,
  // 完整覆盖首尾比整点更重要)。跨度 ≥3 天只标日期,更短带时分;相邻重复标签
  // 去重(极短窗口下四个刻度会格式化成同一串)。
  const fmtTick = (ts: number) => {
    const d = new Date(ts * 1000);
    const md = `${d.getMonth() + 1}/${d.getDate()}`;
    if (tSpan >= 3 * 86400) return md;
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${md} ${hh}:${mi}`;
  };
  const tickTs =
    tSpan === 0 ? [tMin] : [0, 1 / 3, 2 / 3, 1].map((f) => tMin + f * tSpan);
  const ticks: {
    x: number;
    label: string;
    anchor: "start" | "middle" | "end";
  }[] = [];
  for (let i = 0; i < tickTs.length; i++) {
    const label = fmtTick(tickTs[i]);
    if (ticks.length > 0 && ticks[ticks.length - 1].label === label) continue;
    ticks.push({
      x: sx(tickTs[i]),
      label,
      // 端点标签朝内锚定,避免溢出绘图区(左端撞 y 轴刻度、右端出画布)。
      anchor:
        tSpan === 0
          ? "middle"
          : i === 0
            ? "start"
            : i === tickTs.length - 1
              ? "end"
              : "middle",
    });
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ height: "auto", display: "block" }}
        role="img"
        aria-label="各策略结算净值(累计已实现盈亏)阶梯曲线"
      >
        {/* 0 基线 */}
        <line
          x1={x0}
          y1={yZero}
          x2={x1}
          y2={yZero}
          stroke="var(--n-300)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        {/* y 轴刻度:峰值 / 0 / 谷底 */}
        <text
          x={x0 - 6}
          y={sy(cMax)}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={10}
          fill="var(--n-500)"
          className="mono"
        >
          {axisFmt(cMax)}
        </text>
        <text
          x={x0 - 6}
          y={yZero}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={10}
          fill="var(--n-400)"
          className="mono"
        >
          $0
        </text>
        <text
          x={x0 - 6}
          y={sy(cMin)}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={10}
          fill="var(--n-500)"
          className="mono"
        >
          {axisFmt(cMin)}
        </text>
        {/* x 轴时间刻度:浅色竖网格线 + 底部时间标签 */}
        {ticks.map((t) => (
          <g key={t.x}>
            <line
              x1={t.x}
              y1={y0}
              x2={t.x}
              y2={y1}
              stroke="var(--n-200)"
              strokeWidth={1}
              strokeDasharray="2 4"
            />
            <text
              x={t.x}
              y={y1 + 15}
              textAnchor={t.anchor}
              fontSize={10}
              fill="var(--n-500)"
              className="mono"
            >
              {t.label}
            </text>
          </g>
        ))}
        {/* 各策略阶梯线 + 结算点 */}
        {withData.map((s) => {
          const st = strokeFor(s.strokeIdx);
          return (
            <g key={s.id}>
              <path
                d={stepPath(s.curve, sx, sy)}
                fill="none"
                stroke={st.color}
                strokeWidth={2}
                strokeDasharray={st.dash}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {s.curve.map((pt, i) => (
                <circle
                  key={i}
                  cx={sx(pt.ts)}
                  cy={sy(pt.cum)}
                  r={2.5}
                  fill={st.color}
                />
              ))}
            </g>
          );
        })}
      </svg>
      {/* 图例:虚实样条 + 策略名 + 净值 */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--s-4)",
          marginTop: "var(--s-2)",
        }}
      >
        {withData.map((s) => {
          const st = strokeFor(s.strokeIdx);
          const net = s.curve[s.curve.length - 1]?.cum ?? 0;
          return (
            <span
              key={s.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--s-2)",
              }}
            >
              <svg width={26} height={8} aria-hidden>
                <line
                  x1={1}
                  y1={4}
                  x2={25}
                  y2={4}
                  stroke={st.color}
                  strokeWidth={2}
                  strokeDasharray={st.dash}
                />
              </svg>
              <span className="ds-hint">{s.name}</span>
              <span className={`mono ${pnlTone(net)}`}>
                {fmtSignedUsd(net)}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------- metric / cards */

// 单个指标块:eyebrow 标签 + 值节点(值节点自带 up/down/mono 类,不套 kpi-value
// 以免颜色被覆盖)。
function Metric({
  label,
  value,
  title,
}: {
  label: string;
  value: ReactNode;
  title?: string;
}) {
  return (
    <div title={title}>
      <div className="ds-label">{label}</div>
      <div style={{ marginTop: "var(--s-1)" }}>{value}</div>
    </div>
  );
}

function StrategyCard({
  s,
  leading,
}: {
  s: FollowStrategyView;
  leading: boolean;
}) {
  const m = s.metrics;
  const fund = s.fund; // 旧响应可能缺失 → 档案各项显示「—」
  const slip = m.slippageCost;
  // 均 ¢ 差/仓:所有仓位(open+settled,追价成本在进场即产生)的单仓 ¢ 差算术平均。
  // 简单口径 —— 每仓等权、不按 usd 加权;目的只是把美元合计还原成可横比的偏离度。
  const allPos = [...s.open, ...s.settled];
  const avgSlipCents =
    allPos.length > 0
      ? allPos.reduce((sum, p) => sum + rowSlipCents(p), 0) / allPos.length
      : null;
  // 均延迟成本:仅统计有 formation_price 的仓位(老仓位/取价失败不进样本),
  // 每仓等权算术平均;样本数以 n=N 标注,提醒读者小样本不可过度解读。
  const delaySamples = allPos
    .map(rowDelayCents)
    .filter((c): c is number => c != null);
  const avgDelayCents =
    delaySamples.length > 0
      ? delaySamples.reduce((sum, c) => sum + c, 0) / delaySamples.length
      : null;
  return (
    <div
      className="ds-card"
      style={{
        padding: "var(--s-4)",
        // 领先卡用品牌色描边 + 抬升阴影强调,全部走 token,不硬编码色。
        ...(leading
          ? {
              borderColor: "var(--brand-500)",
              boxShadow: "var(--shadow-md)",
            }
          : null),
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-2)",
          flexWrap: "wrap",
          marginBottom: "var(--s-3)",
        }}
      >
        <strong style={{ fontSize: "var(--t-lg)", color: "var(--n-900)" }}>
          {s.name}
        </strong>
        {leading ? <Tag variant="brand">本窗口领先</Tag> : null}
        {!s.enabled ? <Tag variant="warn">已停用</Tag> : null}
      </div>
      <div className="ds-hint" style={{ marginBottom: "var(--s-4)" }}>
        {paramsHint(s.params)}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: "var(--s-3) var(--s-4)",
        }}
      >
        <Metric
          label="结算净值"
          title="已结算仓位累计已实现盈亏(不含持仓浮盈)"
          value={
            <span
              className={`mono ${pnlTone(m.totalRealized)}`}
              style={{ fontSize: 20, fontWeight: 700 }}
            >
              {fmtSignedUsd(m.totalRealized)}
            </span>
          }
        />
        <Metric
          label="ROI"
          title="结算净值 ÷ 已投入本金(仅已结算仓)"
          value={
            m.roi == null ? (
              <span className="muted">—</span>
            ) : (
              <span
                className={`mono ${pnlTone(m.roi)}`}
                style={{ fontSize: 18, fontWeight: 600 }}
              >
                {m.roi >= 0 ? "+" : MINUS}
                {Math.abs(m.roi * 100).toFixed(1)}%
              </span>
            )
          }
        />
        <Metric
          label="平均年化"
          title="结算净值 ÷ 峰值占用资金 × 365 ÷ 运行天数。把策略当一只小基金:按历史峰值备足本金、自成立日起折算年化。短窗口/小样本外推极不可靠,仅供横向对比;无结算仓或运行不足 1 天显示 —"
          value={
            fund?.annualizedRoi == null ? (
              <span className="muted">—</span>
            ) : (
              <span
                className={`mono ${pnlTone(fund.annualizedRoi)}`}
                style={{ fontSize: 18, fontWeight: 600 }}
              >
                {fmtAnnualized(fund.annualizedRoi)}
              </span>
            )
          }
        />
        <Metric
          label="结算胜率"
          title="盈利仓 ÷(盈利+亏损)仓 · Wilson 95% 置信区间;平局不计入分母"
          value={<span className="mono">{winRateLabel(m)}</span>}
        />
        <Metric
          label="已结算 · 持有"
          title="已结算平仓数 · 当前持仓待结算数"
          value={
            <span className="mono">
              {m.settledCount}
              <span className="muted"> · </span>
              {m.openCount}
            </span>
          }
        />
        <Metric
          label="累计追价成本"
          title="旧称「累计滑点」。份额 ×(自己入场价 − 聪明钱建仓均价)之和(美元)。正=追高多付的成本;负≠捡便宜(常是行情已反向/接飞刀)。注意:这不是盘口执行滑点——纸面按报价快照成交,价差/深度等执行成本未计入。中性展示,请结合单仓 ¢ 差与已实现盈亏一起看"
          value={
            <>
              {/* 配色中性:追价成本不是盈亏,不用涨绿跌红。 */}
              <span className="mono">
                {slip >= 0 ? `$${fmtUsd0(slip)}` : `${MINUS}$${fmtUsd0(-slip)}`}
              </span>
              {avgSlipCents != null ? (
                <div className="kpi-sub mono">
                  均 {fmtSignedCents(avgSlipCents)}/仓
                </div>
              ) : null}
            </>
          }
        />
        <Metric
          label="均延迟成本"
          title="有形成价的仓位的(进场价 − 形成价)¢ 算术平均。正=共识形成后我们追贵了 —— 检测+执行延迟造成的可优化成本;与「累计追价成本」(vs 聪明钱均价、含拿不到的信息租金)口径不同。老仓位无形成价,不进样本"
          value={
            avgDelayCents == null ? (
              <span className="muted">—</span>
            ) : (
              <>
                {/* 配色中性:延迟成本不是盈亏;|¢|>10 琥珀,与进场偏离护栏阈一致。 */}
                <span className="mono" style={slipWarnStyle(avgDelayCents)}>
                  {fmtSignedCents(avgDelayCents)}
                </span>
                <div className="kpi-sub mono">n={delaySamples.length}</div>
              </>
            )
          }
        />
        <Metric
          label="最大回撤"
          title="净值曲线从峰值到后续谷底的最大跌幅(美元)"
          value={
            <span className={`mono ${m.maxDrawdown > 0 ? "down" : "muted"}`}>
              {m.maxDrawdown > 0 ? `${MINUS}$${fmtUsd0(m.maxDrawdown)}` : "$0"}
            </span>
          }
        />
        <Metric
          label="开始时间"
          title="策略上线(成立)日期;运行时间与年化都以此为锚。老库缺创建时间时回退首仓开仓日"
          value={
            fund?.startTs != null ? (
              <span className="mono">{fmtDate(fund.startTs)}</span>
            ) : (
              <span className="muted">—</span>
            )
          }
        />
        <Metric
          label="运行时间"
          title="自开始时间至今的时长(策略持续在跑,含无信号的空窗期)"
          value={
            fund?.runDays != null ? (
              <span className="mono">{fmtHold(fund.runDays * 86400)}</span>
            ) : (
              <span className="muted">—</span>
            )
          }
        />
        <Metric
          label="最大占用资金"
          title="历史上任一时刻同时持有仓位的本金峰值(扫描线口径,open 仓占用至结算才释放)。即照此策略实盘需准备的本金,也是「平均年化」的分母"
          value={
            fund ? (
              <span className="mono">${fmtUsd0(fund.maxConcurrentUsd)}</span>
            ) : (
              <span className="muted">—</span>
            )
          }
        />
      </div>
      {m.avgHoldingDays != null ? (
        <div className="ds-hint" style={{ marginTop: "var(--s-3)" }}>
          平均持有 {m.avgHoldingDays.toFixed(1)} 天
        </div>
      ) : null}
      <CardActions name={s.name} acct={s.account} positions={allPos} />
    </div>
  );
}

const fmtPct = (u: number | null) =>
  u == null ? "—" : `${(u * 100).toFixed(0)}%`;

// 卡片底部动作行:「建议跟单额度」数字 + 两个弹窗入口(账户推演 / 操作历史),
// 细节全部收进弹窗,卡片保持紧凑。仅展示,不参与任何决策。
function CardActions({
  name,
  acct,
  positions,
}: {
  name: string;
  acct?: AccountPlan;
  positions: FollowPositionRow[];
}) {
  const [planOpen, setPlanOpen] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const hasPlan = !!acct && acct.rows.length > 0 && acct.suggestedUsd != null;
  const hasHistory = positions.length > 0;
  if (!hasPlan && !hasHistory) return null;
  return (
    <div
      style={{
        marginTop: "var(--s-3)",
        borderTop: "1px solid var(--n-200)",
        paddingTop: "var(--s-3)",
        display: "flex",
        alignItems: "center",
        gap: "var(--s-2)",
        flexWrap: "wrap",
      }}
    >
      {hasPlan ? (
        <>
          <span className="ds-hint">建议跟单额度</span>
          <span className="mono" style={{ fontWeight: 600 }}>
            ${fmtUsd0(acct!.suggestedUsd!)}
          </span>
          <button
            type="button"
            className="ds-btn"
            onClick={() => setPlanOpen(true)}
            title="额度依据与「若账户只备 $X」五档精确回放"
          >
            账户推演 · 该备多少钱
          </button>
        </>
      ) : null}
      {hasHistory ? (
        <button
          type="button"
          className="ds-btn"
          onClick={() => setHistOpen(true)}
          title="出信号→买入、兑现卖出的完整动作记录,倒序排列"
        >
          操作历史
        </button>
      ) : null}
      {hasPlan ? (
        <Modal
          open={planOpen}
          onClose={() => setPlanOpen(false)}
          title={`${name} · 建议跟单额度与账户推演`}
          width={680}
        >
          <AccountPlanDialog acct={acct!} />
        </Modal>
      ) : null}
      {hasHistory ? (
        <Modal
          open={histOpen}
          onClose={() => setHistOpen(false)}
          title={`${name} · 操作历史`}
          // 尽量占满视口宽(Modal 内部按 min(width, 100%) 收敛),配合市场列
          // 允许换行,表格不出现左右滚动。
          width={1200}
        >
          <HistoryDialog positions={positions} />
        </Modal>
      ) : null}
    </div>
  );
}

// 弹窗内容:建议跟单额度(含推导)+ 平均占用/效率 + 五档推演表 + 口径说明。
// 反事实精确回放:固定 $/仓 + 仓位独立 ⇒「若账户只备 $X」按开仓顺序重演是
// 精确值(资金不够即错过、结算即释放),不是估计。
function AccountPlanDialog({ acct }: { acct: AccountPlan }) {
  const suggestedRow =
    acct.rows.find((r) => r.accountUsd === acct.suggestedUsd) ?? null;
  return (
    <div>
      <div className="ds-hint">
        建议跟单额度(账户备付现金 · Polymarket 无杠杆)
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "var(--s-3)",
          flexWrap: "wrap",
          margin: "4px 0 var(--s-1)",
        }}
      >
        <span className="mono" style={{ fontSize: 24, fontWeight: 700 }}>
          ${fmtUsd0(acct.suggestedUsd!)}
        </span>
        {suggestedRow?.annualizedRoi != null ? (
          <span className="ds-hint">
            按此额度年化{" "}
            <span className={`mono ${pnlTone(suggestedRow.annualizedRoi)}`}>
              {fmtAnnualized(suggestedRow.annualizedRoi)}
            </span>
            {suggestedRow.utilization != null
              ? ` · 使用效率 ${fmtPct(suggestedRow.utilization)}`
              : ""}
          </span>
        ) : null}
      </div>
      <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
        = 历史峰值占用 ${fmtUsd0(acct.recommendedUsd ?? 0)}
        (恰好接住全部历史信号的最小资金)+ ~25% 冗余,按单仓金额向上取整。
        历史窗口口径,未来峰值可能更高。
      </div>
      <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
        账户推演 · 该备多少钱
      </div>
      <div className="ds-hint" style={{ marginBottom: "var(--s-2)" }}>
        {`平均占用 $${fmtUsd0(acct.avgOccupiedUsd)}`}
        {acct.utilization != null
          ? ` · 峰值额度下使用效率 ${fmtPct(acct.utilization)}`
          : ""}
      </div>
      <div className="ds-table-wrap">
        <table className="ds-table">
          <thead>
            <tr>
              <th title="若账户只备这么多钱(0.25/0.5/0.75/1/1.25 × 峰值占用)">
                若账户
              </th>
              <th title="按开仓顺序回放:资金不足即错过该信号">接住 · 错过</th>
              <th title="接住且已结算仓位的已实现盈亏合计(不含浮盈)">落袋</th>
              <th title="落袋 ÷ 账户额 × 365 ÷ 运行天数;无结算仓或运行不足 1 天为 —">
                年化
              </th>
              <th title="时间加权平均占用 ÷ 账户额(含零仓闲置期)">效率</th>
            </tr>
          </thead>
          <tbody>
            {acct.rows.map((r) => (
              <tr
                key={r.accountUsd}
                style={
                  r.accountUsd === acct.suggestedUsd ||
                  r.accountUsd === acct.recommendedUsd
                    ? { background: "var(--n-100)" }
                    : undefined
                }
              >
                <td className="mono">
                  ${fmtUsd0(r.accountUsd)}
                  {r.accountUsd === acct.suggestedUsd ? (
                    <>
                      {" "}
                      <Tag variant="brand">建议</Tag>
                    </>
                  ) : r.accountUsd === acct.recommendedUsd ? (
                    <>
                      {" "}
                      <span className="ds-tag">恰接住</span>
                    </>
                  ) : null}
                </td>
                <td className="mono">
                  {r.taken} ·{" "}
                  {r.missed > 0 ? (
                    <span style={{ color: "var(--warn-700)" }}>{r.missed}</span>
                  ) : (
                    "0"
                  )}
                </td>
                <td>
                  <span className={`mono ${pnlTone(r.realizedPnl)}`}>
                    {fmtSignedUsd(r.realizedPnl)}
                  </span>
                </td>
                <td>
                  {r.annualizedRoi == null ? (
                    <span className="muted">—</span>
                  ) : (
                    <span className={`mono ${pnlTone(r.annualizedRoi)}`}>
                      {fmtAnnualized(r.annualizedRoi)}
                    </span>
                  )}
                </td>
                <td className="mono">{fmtPct(r.utilization)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
        回放口径:把历史仓位按开仓顺序重演——账户资金不够就错过该信号、市场结算
        即释放资金。每仓固定 $/信号且互相独立,因此错过哪几仓、少赚/少亏多少是
        精确值而非估计。效率 = 时间加权平均占用 ÷ 账户额(含零仓闲置期)。
      </div>
    </div>
  );
}

/* ------------------------------------------------------ action history */

// 操作历史事件:每仓一条「买入」(entry_ts,附信号形成时间),已结算再加一条
// 「兑现」(exit_ts)。仅记录已执行的纸面动作——被新鲜度闸门/偏离护栏拦下、
// 或(推演意义上)资金外的信号不产生仓位行,自然不在此表。
type HistoryEvent = {
  ts: number;
  kind: "open" | "settle";
  p: FollowPositionRow;
};

// 倒序(最新在前);同一时刻「兑现」排在「买入」上方——同刻时兑现在时间线上
// 是更靠后的动作(entry==exit 的零时长异常仓也因此顺序自然)。
function buildHistory(positions: FollowPositionRow[]): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  for (const p of positions) {
    events.push({ ts: p.entry_ts, kind: "open", p });
    if (p.status === "settled" && p.exit_ts != null) {
      events.push({ ts: p.exit_ts, kind: "settle", p });
    }
  }
  return events.sort(
    (a, b) =>
      b.ts - a.ts || (a.kind === b.kind ? 0 : a.kind === "settle" ? -1 : 1),
  );
}

// 兑现动作的结果着色:赢绿 / 输红 / 平中性(与 SideTag 同一 up/down 语义)。
function settleTagVariant(pnl: number | null): "up" | "down" | "default" {
  if (pnl == null || pnl === 0) return "default";
  return pnl > 0 ? "up" : "down";
}

function HistoryDialog({ positions }: { positions: FollowPositionRow[] }) {
  const events = buildHistory(positions);
  const buys = events.filter((e) => e.kind === "open").length;
  return (
    <div>
      <div className="ds-hint" style={{ marginBottom: "var(--s-2)" }}>
        {buys} 次买入 · {events.length - buys} 次兑现 · 倒序(最新在前)·
        纸面模拟,无真实成交;仅记录已执行动作,被护栏/新鲜度闸门拦下的信号不在此列
      </div>
      <div className="ds-table-wrap">
        <table className="ds-table">
          <thead>
            <tr>
              <th title="动作发生时刻(本地时区),悬停看完整时间">时间</th>
              <th title="买入 = 信号触发后现价开仓;兑现 = 市场结算平仓(赢绿/输红/平灰)">
                动作
              </th>
              <th>市场 · 结果</th>
              <th
                className="is-right"
                title="买入行 = 进场价,下附信号形成时间与检测延迟;兑现行 = 结算价,下附持有时长"
              >
                价格
              </th>
              <th
                className="is-right"
                title="买入行 = 投入本金;兑现行 = 已实现盈亏"
              >
                金额 / 盈亏
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((e, i) => (
              <tr key={`${e.p.condition_id}-${e.p.outcome}-${e.kind}-${i}`}>
                <td
                  className="mono"
                  title={new Date(e.ts * 1000).toLocaleString("zh-CN")}
                >
                  {fmtDateTime(e.ts)}
                </td>
                <td>
                  {e.kind === "open" ? (
                    <span className="ds-tag">买入</span>
                  ) : (
                    <Tag variant={settleTagVariant(e.p.realized_pnl)}>兑现</Tag>
                  )}
                </td>
                {/* 市场列放开全局 nowrap:长标题换行而不是把表撑出横向滚动 */}
                <td style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                  <MarketCell p={e.p} />
                </td>
                <td className="is-right">
                  {e.kind === "open" ? (
                    <>
                      <span className="mono">{cents(e.p.entry_price)}</span>
                      {e.p.formation_ts != null ? (
                        <div className="kpi-sub">
                          信号 {fmtDateTime(e.p.formation_ts)} · 延迟{" "}
                          {Math.max(
                            0,
                            Math.round((e.p.entry_ts - e.p.formation_ts) / 60),
                          )}{" "}
                          分
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <span className="mono">
                        {e.p.exit_price != null ? cents(e.p.exit_price) : "—"}
                      </span>
                      <div className="kpi-sub">
                        持有{" "}
                        {fmtHold((e.p.exit_ts ?? e.p.entry_ts) - e.p.entry_ts)}
                      </div>
                    </>
                  )}
                </td>
                <td className="is-right">
                  {e.kind === "open" ? (
                    <span className="mono muted">${fmtUsd0(e.p.size_usd)}</span>
                  ) : (
                    <span className={`mono ${pnlTone(e.p.realized_pnl ?? 0)}`}>
                      {fmtSignedUsd(e.p.realized_pnl ?? 0)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- tables */

// 策略归属小标签(合并表里标注该行来自哪条策略)。
function StratChip({ name }: { name: string }) {
  return <span className="ds-tag">{name}</span>;
}

function MarketCell({ p }: { p: FollowPositionRow }) {
  const label = marketLabel(p);
  return (
    <>
      {p.event_slug ? (
        <a
          href={`https://polymarket.com/event/${p.event_slug}`}
          target="_blank"
          rel="noreferrer"
        >
          {label}
        </a>
      ) : (
        label
      )}
      <div className="kpi-sub">{p.outcome}</div>
    </>
  );
}

function SettledTable({
  rows,
  emptyText = "尚无已结算的纸面仓位",
}: {
  rows: LabeledRow[];
  emptyText?: string;
}) {
  if (rows.length === 0) {
    return <div className="ds-empty">{emptyText}</div>;
  }
  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="ds-table-wrap">
      <table className="ds-table">
        <thead>
          <tr>
            <th>策略</th>
            <th>市场 · 结果</th>
            <th className="is-right" title="现价进场 → 结算价(美分)">
              进价→结算价
            </th>
            <th
              className="is-right"
              title="旧称「滑点」。入场价 − 聪明钱建仓均价(¢ 差,括号内为美元口径)。正=追高;负≠捡便宜(常是行情已反向);|¢差|>10 琥珀警示。口径含聪明钱的信息租金(他们买得早/便宜,拿不到别追)—— 与「延迟成本」(vs 形成价)不同;也不是盘口执行滑点(纸面按报价快照成交,不吃盘口)"
            >
              追价成本
            </th>
            <th
              className="is-right"
              title="进场价 − 形成价(¢)。形成价=第 N 个白名单钱包到位那一刻的市价;正=共识形成后追贵了,是系统检测+执行延迟造成的可优化成本(不含信息租金,与「追价成本」口径不同)。老仓位/取价失败显示 —;|¢|>10 琥珀,与进场偏离护栏阈一致"
            >
              延迟成本
            </th>
            <th
              className="is-right"
              title="markout:形成后 2 小时市价 − 形成价(¢),衡量共识形成后还有没有肉。涨绿跌红(±0.5¢ 死区记平推);形成价或 2h 回填价缺失显示 —"
            >
              形成后2h
            </th>
            <th className="is-right">持有期</th>
            <th className="is-right">已实现</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const slip = rowSlippage(p);
            const slipC = rowSlipCents(p);
            const delayC = rowDelayCents(p);
            const mo2 = rowMarkout2hCents(p);
            const held = (p.exit_ts ?? now) - p.entry_ts;
            const realized = p.realized_pnl ?? 0;
            return (
              <tr key={`${p.strategy_id}:${p.condition_id}:${p.outcome}`}>
                <td data-label="策略">
                  <StratChip name={p.strategyName} />
                </td>
                <td
                  data-label="市场 · 结果"
                  style={{ whiteSpace: "normal", maxWidth: 360 }}
                >
                  <MarketCell p={p} />
                </td>
                <td className="mono is-right" data-label="进价→结算价">
                  {cents(p.entry_price)}
                  <span className="muted"> → </span>
                  {p.exit_price != null ? cents(p.exit_price) : "—"}
                </td>
                {/* 主显示 ¢ 差(可跨仓横比),美元退居括号小字;中性色,超警示线转琥珀。 */}
                <td
                  className="mono is-right"
                  data-label="追价成本"
                  style={slipWarnStyle(slipC)}
                >
                  {fmtSignedCents(slipC)}
                  <span className="muted"> ({fmtSignedUsd(slip)})</span>
                </td>
                {/* 延迟成本:中性色(是成本不是盈亏),超护栏阈转琥珀;无形成价显示 —。 */}
                <td
                  className="mono is-right"
                  data-label="延迟成本"
                  style={delayC != null ? slipWarnStyle(delayC) : undefined}
                >
                  {delayC != null ? (
                    fmtSignedCents(delayC)
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                {/* 形成后 2h:价格方向,涨绿跌红(±0.5¢ 死区平推);缺值显示 —。 */}
                <td className="mono is-right" data-label="形成后2h">
                  {mo2 != null ? (
                    <span className={markoutToneClass(mo2)}>
                      {fmtSignedCents(mo2)}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="mono muted is-right" data-label="持有期">
                  {fmtHold(held)}
                </td>
                <td
                  className={`mono is-right ${pnlTone(realized)}`}
                  data-label="已实现"
                  style={{ fontWeight: 700 }}
                >
                  {fmtSignedUsd(realized)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OpenTable({
  rows,
  emptyText = "当前没有持仓中的纸面仓位",
}: {
  rows: LabeledRow[];
  emptyText?: string;
}) {
  if (rows.length === 0) {
    return <div className="ds-empty">{emptyText}</div>;
  }
  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="ds-table-wrap">
      <table className="ds-table">
        <thead>
          <tr>
            <th>策略</th>
            <th>市场 · 结果</th>
            <th className="is-right" title="现价进场价(美分)">
              进价
            </th>
            <th
              className="is-right"
              title="旧称「滑点」。入场价 − 聪明钱建仓均价(¢ 差,括号内为美元口径)。正=追高;负≠捡便宜(常是行情已反向);|¢差|>10 琥珀警示。口径含聪明钱的信息租金(他们买得早/便宜,拿不到别追)—— 与「延迟成本」(vs 形成价)不同;也不是盘口执行滑点(纸面按报价快照成交,不吃盘口)"
            >
              追价成本
            </th>
            <th
              className="is-right"
              title="进场价 − 形成价(¢)。形成价=第 N 个白名单钱包到位那一刻的市价;正=共识形成后追贵了,是系统检测+执行延迟造成的可优化成本(不含信息租金,与「追价成本」口径不同)。老仓位/取价失败显示 —;|¢|>10 琥珀,与进场偏离护栏阈一致"
            >
              延迟成本
            </th>
            <th className="is-right">已持有</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const slip = rowSlippage(p);
            const slipC = rowSlipCents(p);
            const delayC = rowDelayCents(p);
            const held = now - p.entry_ts;
            return (
              <tr key={`${p.strategy_id}:${p.condition_id}:${p.outcome}`}>
                <td data-label="策略">
                  <StratChip name={p.strategyName} />
                </td>
                <td
                  data-label="市场 · 结果"
                  style={{ whiteSpace: "normal", maxWidth: 360 }}
                >
                  <MarketCell p={p} />
                </td>
                <td className="mono is-right" data-label="进价">
                  {cents(p.entry_price)}
                </td>
                {/* 主显示 ¢ 差(可跨仓横比),美元退居括号小字;中性色,超警示线转琥珀。 */}
                <td
                  className="mono is-right"
                  data-label="追价成本"
                  style={slipWarnStyle(slipC)}
                >
                  {fmtSignedCents(slipC)}
                  <span className="muted"> ({fmtSignedUsd(slip)})</span>
                </td>
                {/* 延迟成本:中性色(是成本不是盈亏),超护栏阈转琥珀;无形成价显示 —。 */}
                <td
                  className="mono is-right"
                  data-label="延迟成本"
                  style={delayC != null ? slipWarnStyle(delayC) : undefined}
                >
                  {delayC != null ? (
                    fmtSignedCents(delayC)
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="mono muted is-right" data-label="已持有">
                  {fmtHold(held)}
                </td>
                <td data-label="状态">
                  <Tag variant="warn">待结算</Tag>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------------- page */

export default function FollowPage() {
  const [data, setData] = useState<FollowResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
  // 仓位明细:tab(已结算/持有中)+ 策略筛选(FILTER_ALL=全部,否则策略 id)。
  const [posTab, setPosTab] = useState<PosTab>("settled");
  const [stratFilter, setStratFilter] = useState<number>(FILTER_ALL);
  const activeReq = useRef<number>(0);

  const load = useCallback(async () => {
    const reqId = ++activeReq.current;
    setLoading(true);
    try {
      const res = await fetch("/api/follow", { cache: "no-store" });
      const json = (await res.json()) as FollowResponse;
      if (reqId !== activeReq.current) return;
      setData(json);
      setLastRefreshed(
        new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      );
    } catch (e) {
      if (reqId !== activeReq.current) return;
      setData({
        strategies: [],
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (reqId === activeReq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  // 只展示启用中的策略;整页(卡片/曲线/表)都从这份集合派生,保持一致。
  const shown = (data?.strategies ?? []).filter((s) => s.enabled);

  // 领先策略:净值最高者,仅在有 ≥2 张卡且严格领先(不并列)时高亮,避免任意高亮。
  const ranked = [...shown].sort(
    (a, b) => b.metrics.totalRealized - a.metrics.totalRealized,
  );
  const leaderId =
    shown.length >= 2 &&
    ranked[0].metrics.totalRealized > ranked[1].metrics.totalRealized
      ? ranked[0].id
      : null;

  const series: CurveSeries[] = shown.map((s, i) => ({
    id: s.id,
    name: s.name,
    strokeIdx: i,
    curve: s.metrics.equityCurve,
  }));

  const settledRows: LabeledRow[] = shown
    .flatMap((s) => s.settled.map((p) => ({ ...p, strategyName: s.name })))
    .sort((a, b) => (b.exit_ts ?? 0) - (a.exit_ts ?? 0));
  const openRows: LabeledRow[] = shown.flatMap((s) =>
    s.open.map((p) => ({ ...p, strategyName: s.name })),
  );

  // 策略筛选:渲染期派生「有效筛选值」而非 setState —— 选中的策略可能在下一次
  // 刷新后消失(被停用),此时静默回退「全部」,不在 render 里改状态。
  const effFilter = shown.some((s) => s.id === stratFilter)
    ? stratFilter
    : FILTER_ALL;
  const byFilter = (rows: LabeledRow[]) =>
    effFilter === FILTER_ALL
      ? rows
      : rows.filter((r) => r.strategy_id === effFilter);
  const shownSettled = byFilter(settledRows);
  const shownOpen = byFilter(openRows);
  const filterName =
    effFilter === FILTER_ALL
      ? null
      : (shown.find((s) => s.id === effFilter)?.name ?? null);

  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-4)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", marginBottom: "var(--s-1)" }}>
          🧾 共识跟单 · 纸面模拟
        </h1>
        <div className="ds-hint">
          现价进场 · 只跟 15 分钟内新形成的共识 · 持有到结算 · 固定 $/信号 ·
          仅结算盈亏(不做浮盈)·
          按报价快照纸面成交,不含盘口执行成本(价差/深度),盈亏偏乐观
          {lastRefreshed ? ` · 最后刷新 ${lastRefreshed}` : ""}
          {loading ? (
            <span style={{ color: "var(--warn-700)" }}> · 加载中…</span>
          ) : null}
        </div>
      </header>

      {/* Controls — 无筛选参数,仅刷新 / 自动刷新 */}
      <section
        className="ds-card"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-3)",
          padding: "var(--s-3) var(--s-4)",
          marginBottom: "var(--s-5)",
        }}
      >
        <button className="ds-btn ds-btn--ghost" onClick={() => load()}>
          刷新
        </button>
        <label
          className="ds-hint"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--s-1)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          自动刷新 30s
        </label>
      </section>

      {data?.error ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-4)" }}
        >
          加载失败: {data.error}
        </div>
      ) : null}

      {!data ? (
        <div className="ds-empty">⏳ 正在加载纸面跟单战绩…</div>
      ) : shown.length === 0 ? (
        <div className="ds-empty">
          暂无启用中的跟单策略 —
          引擎播种聪明钱白名单并跑通一轮跟单后,这里会出现策略 A/B 的纸面战绩
        </div>
      ) : (
        <>
          {/* 策略 A/B 卡 */}
          <section
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: "var(--s-4)",
              marginBottom: "var(--s-5)",
            }}
          >
            {shown.map((s) => (
              <StrategyCard key={s.id} s={s} leading={s.id === leaderId} />
            ))}
          </section>

          {/* 结算净值阶梯曲线 */}
          <section style={{ marginBottom: "var(--s-5)" }}>
            <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
              结算净值曲线(累计已实现盈亏 · 实线/虚线区分策略)
            </div>
            <div className="ds-card" style={{ padding: "var(--s-4)" }}>
              <EquityCurve series={series} />
            </div>
          </section>

          {/* 仓位明细:已结算/持有中 tab 切换 + 按策略筛选(计数随筛选联动) */}
          <section>
            <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
              仓位明细
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--s-3)",
                flexWrap: "wrap",
                marginBottom: "var(--s-2)",
              }}
            >
              <Segmented<PosTab>
                ariaLabel="仓位状态"
                options={[
                  {
                    label: `已结算 · 落袋(${shownSettled.length})`,
                    value: "settled",
                  },
                  {
                    label: `持有中 · 待结算(${shownOpen.length})`,
                    value: "open",
                  },
                ]}
                value={posTab}
                onChange={setPosTab}
              />
              {/* 只有一条策略时筛选没有意义,不渲染 */}
              {shown.length >= 2 ? (
                <Segmented<number>
                  ariaLabel="按策略筛选仓位"
                  options={[
                    { label: "全部策略", value: FILTER_ALL },
                    ...shown.map((s) => ({ label: s.name, value: s.id })),
                  ]}
                  value={effFilter}
                  onChange={setStratFilter}
                />
              ) : null}
              {posTab === "open" ? (
                <span className="ds-hint">不显示浮盈</span>
              ) : null}
            </div>
            {posTab === "settled" ? (
              <SettledTable
                rows={shownSettled}
                emptyText={
                  filterName
                    ? `「${filterName}」策略尚无已结算的纸面仓位`
                    : undefined
                }
              />
            ) : (
              <OpenTable
                rows={shownOpen}
                emptyText={
                  filterName
                    ? `「${filterName}」策略当前没有持仓中的纸面仓位`
                    : undefined
                }
              />
            )}
          </section>
        </>
      )}
    </main>
  );
}
