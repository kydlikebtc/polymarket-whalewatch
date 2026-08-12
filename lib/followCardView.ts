// 跟单页策略卡的纯展示逻辑。提到 lib/ 是因为 app/ 下没有组件测试基建 ——
// 卡态判定与 sparkline 定域是这次改版里仅有的两块可被自动化覆盖的逻辑,
// 留在 page.tsx 里就只能靠目视。
// 设计见 docs/plans/2026-08-12-follow-page-card-redesign-design.md §3.1。

/**
 * 小样本阈值:已结算 <10 仓时,卡上的 ROI/胜率不具备可读性 —— 一档跟了 3 仓
 * 恰好赢 2 仓,胜率就是 67%,与另一档 44 仓的 48% 差着数量级的可信度。
 * 取 10 与项目既有纪律同源:聪明钱准入的质量闸(lib/admissionGate.ts 的
 * ADMIT_MIN_SETTLED)用的也是「settledCount >= 10」。
 */
export const LOW_SAMPLE_THRESHOLD = 10;

export type CardState = "normal" | "low_sample" | "empty";

/**
 * 卡态判定。empty 只看 settledCount —— 净值曲线由结算点构成,有持仓但零结算
 * 时曲线依然是空的,画不出东西。两者的文案区分(「等待首次结算」vs「等待信号
 * 命中」)由调用方按 openCount 决定,不在这里编码。
 */
export function classifyCardState(m: {
  settledCount: number;
  openCount: number;
}): CardState {
  if (m.settledCount === 0) return "empty";
  if (m.settledCount < LOW_SAMPLE_THRESHOLD) return "low_sample";
  return "normal";
}

/**
 * 卡片 sparkline 的阶梯路径(step-after,与大图 stepPath[app/follow/page.tsx]
 * 同口径:每个结算点之前维持前一水平,到该点垂直跳变)。
 *
 * **各自缩放**:按本条曲线自己的 min/max 定域,不接受外部统一值域 —— 统一
 * 缩放会把小额档压成一条平线。代价是两张卡的曲线不可直接横比,横比职责交给
 * 页面下方的大图(统一坐标系)。
 *
 * 值域为零(全部同值/单点)时退化成水平居中线,不做除法 —— 否则会产出 NaN
 * 污染整个 path 属性,SVG 静默不渲染,比画错更难排查。
 */
export function sparklinePath(
  curve: { ts: number; cum: number }[],
  width: number,
  height: number,
): string {
  if (curve.length === 0) return "";
  const pts = [...curve].sort((a, b) => a.ts - b.ts);
  const PAD = 4; // 上下各留 4px,避免极值点被裁掉一半
  const vals = pts.map((p) => p.cum);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo;
  const tMin = pts[0].ts;
  const tSpan = pts[pts.length - 1].ts - tMin;
  const sx = (t: number) =>
    tSpan > 0 ? ((t - tMin) / tSpan) * width : width / 2;
  const sy = (v: number) =>
    span > 0 ? PAD + (1 - (v - lo) / span) * (height - PAD * 2) : height / 2;

  let d = `M ${sx(pts[0].ts).toFixed(1)} ${sy(pts[0].cum).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const x = sx(pts[i].ts).toFixed(1);
    d += ` L ${x} ${sy(pts[i - 1].cum).toFixed(1)}`;
    d += ` L ${x} ${sy(pts[i].cum).toFixed(1)}`;
  }
  return d;
}

/**
 * 面积填充路径 = 折线路径 + 沿底边闭合。仅用于 sparkline 的视觉重量,
 * 不承载任何额外信息。
 *
 * 闭合方式:从 linePath 的终点垂直落到底边(x 不变,y=height),沿底边走到
 * x=0,再 Z 回到 linePath 的起点。linePath 的起点 x 未必是 0(sparklinePath
 * 在 tSpan===0 时把唯一/同值点画在 width/2),所以这里不假设它是 0 —— Z 命令
 * 会自动直线连回路径起点,不需要显式写出起点坐标。
 */
export function sparklineAreaPath(
  linePath: string,
  width: number,
  height: number,
): string {
  if (!linePath) return "";
  return `${linePath} L ${width.toFixed(1)} ${height} L 0 ${height} Z`;
}
