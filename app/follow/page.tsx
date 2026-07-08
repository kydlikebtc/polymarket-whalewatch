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
import { Tag } from "../ui";

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
  open: FollowPositionRow[];
  settled: FollowPositionRow[];
};

type FollowResponse = {
  strategies: FollowStrategyView[];
  error?: string;
};

// 合并各策略仓位到一张表时,给每行贴上来源策略名(表内可标注归属)。
type LabeledRow = FollowPositionRow & { strategyName: string };

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

function pnlTone(n: number): "up" | "down" {
  return n >= 0 ? "up" : "down";
}

// 单仓跟单滑点(美元)= 份额 ×(自己入场价 − 聪明钱建仓均价)。与 lib/follow 的
// positionSlippage 同口径,此处就地计算,避免把 server lib 引入客户端。
function rowSlippage(p: FollowPositionRow): number {
  return p.shares * (p.entry_price - p.smart_avg_price);
}

// 单仓滑点 ¢ 差 =(自己入场价 − 聪明钱建仓均价)× 100 —— 看板主显示口径。
// 美元滑点受份额膨胀影响(入场价越低份额越大,绝对值可超本金),¢ 差才可跨仓横比。
function rowSlipCents(p: FollowPositionRow): number {
  return (p.entry_price - p.smart_avg_price) * 100;
}

// 带符号 ¢ 差:+5.9¢ / −19.9¢(0 记 +0.0¢)。
function fmtSignedCents(c: number): string {
  const sign = c < 0 ? MINUS : "+";
  return `${sign}${Math.abs(c).toFixed(1)}¢`;
}

// 滑点着色原则:一律中性 —— 负滑点绝不标绿(它常意味着「价格已反向/接飞刀」,
// 不是捡便宜);正滑点也不标红(不是亏损,是成本)。仅 |¢差| 超过警示线时用琥珀
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
  const slip = m.slippageCost;
  // 均 ¢ 差/仓:所有仓位(open+settled,滑点在进场即产生)的单仓 ¢ 差算术平均。
  // 简单口径 —— 每仓等权、不按 usd 加权;目的只是把美元合计还原成可横比的偏离度。
  const allPos = [...s.open, ...s.settled];
  const avgSlipCents =
    allPos.length > 0
      ? allPos.reduce((sum, p) => sum + rowSlipCents(p), 0) / allPos.length
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
          label="累计滑点"
          title="份额 ×(自己入场价 − 聪明钱建仓均价)之和(美元)。正=追高多付的成本;负≠捡便宜(常是行情已反向/接飞刀)。中性展示,请结合单仓 ¢ 差与已实现盈亏一起看"
          value={
            <>
              {/* 配色中性:滑点不是盈亏,不用涨绿跌红。 */}
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
          label="最大回撤"
          title="净值曲线从峰值到后续谷底的最大跌幅(美元)"
          value={
            <span className={`mono ${m.maxDrawdown > 0 ? "down" : "muted"}`}>
              {m.maxDrawdown > 0 ? `${MINUS}$${fmtUsd0(m.maxDrawdown)}` : "$0"}
            </span>
          }
        />
      </div>
      {m.avgHoldingDays != null ? (
        <div className="ds-hint" style={{ marginTop: "var(--s-3)" }}>
          平均持有 {m.avgHoldingDays.toFixed(1)} 天
        </div>
      ) : null}
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

function SettledTable({ rows }: { rows: LabeledRow[] }) {
  if (rows.length === 0) {
    return <div className="ds-empty">尚无已结算的纸面仓位</div>;
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
              title="入场价 − 聪明钱建仓均价(¢ 差,括号内为美元口径)。正=追高;负≠捡便宜(常是行情已反向);|¢差|>10 琥珀警示"
            >
              滑点
            </th>
            <th className="is-right">持有期</th>
            <th className="is-right">已实现</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const slip = rowSlippage(p);
            const slipC = rowSlipCents(p);
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
                  data-label="滑点"
                  style={slipWarnStyle(slipC)}
                >
                  {fmtSignedCents(slipC)}
                  <span className="muted"> ({fmtSignedUsd(slip)})</span>
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

function OpenTable({ rows }: { rows: LabeledRow[] }) {
  if (rows.length === 0) {
    return <div className="ds-empty">当前没有持仓中的纸面仓位</div>;
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
              title="入场价 − 聪明钱建仓均价(¢ 差,括号内为美元口径)。正=追高;负≠捡便宜(常是行情已反向);|¢差|>10 琥珀警示"
            >
              滑点
            </th>
            <th className="is-right">已持有</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const slip = rowSlippage(p);
            const slipC = rowSlipCents(p);
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
                  data-label="滑点"
                  style={slipWarnStyle(slipC)}
                >
                  {fmtSignedCents(slipC)}
                  <span className="muted"> ({fmtSignedUsd(slip)})</span>
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

  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-4)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", marginBottom: "var(--s-1)" }}>
          🧾 共识跟单 · 纸面模拟
        </h1>
        <div className="ds-hint">
          现价进场 · 持有到结算 · 固定 $/信号 · 仅结算盈亏(不做浮盈)
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

          {/* 已结算 */}
          <section style={{ marginBottom: "var(--s-5)" }}>
            <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
              已结算 · 落袋盈亏({settledRows.length})
            </div>
            <SettledTable rows={settledRows} />
          </section>

          {/* 持有中 · 待结算 */}
          <section>
            <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
              持有中 · 待结算({openRows.length}) — 不显示浮盈
            </div>
            <OpenTable rows={openRows} />
          </section>
        </>
      )}
    </main>
  );
}
