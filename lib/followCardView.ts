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

/* ------------------------------------------------------- axis label width */
// bug 修复(2026-08):EquityCurve/Sparkline 的 y 轴数字标签用 textAnchor="end"
// 锚定在绘图区左边界往左偏移一个固定 gap 处。留白(padL)曾经是拍脑袋的固定
// 值(48/56px),−$11,448 这类大额亏损在 10px mono 字体下要接近 50px 宽,
// 从 42(=48-6)往左延伸会跑到负坐标,SVG viewBox 外的部分被裁掉——而负号
// 恰好是最左侧的字符,第一个被裁,一笔巨额亏损因此显示成看似盈利的正数。
// 这里把"给定数值,估算它的轴标签需要多宽"提成纯函数:留白必须按实际会
// 画出来的文字内容动态算,不能再是另一个拍出来的、迟早在下一个数量级上
// 重演同一个 bug 的固定值。

// U+2212(数学减号),与 app/follow/page.tsx 的 MINUS 常量同一字符(不用
// ASCII 连字符)。独立字面量而不是跨文件 import——两处都是文件顶部的稳定
// 常量,ui.tsx fmtSignedUsdCompact 同样直接写字面量,是这个仓库已经在用的
// 容忍模式。字符本身不会漂移,不值得为它建立跨文件依赖。
const AXIS_MINUS = "−";

/**
 * 净值曲线 y 轴标签的美元格式化:正数 "$1,234",负数 "−$1,234"(0 记为不带
 * 符号的 "$0")。app/follow/page.tsx 的 axisFmt 直接复用这个函数(而不是
 * 各自维护一份格式化字面量),让"实际渲染的文字"与"下面用来估宽的文字"
 * 永远是同一份计算结果——两者一旦分别维护、各自改动,就可能重新漂移出
 * 这次修的裁切 bug。
 */
export function formatAxisUsd(v: number): string {
  const abs = Math.round(Math.abs(v)).toLocaleString("en-US");
  return `${v < 0 ? AXIS_MINUS : ""}$${abs}`;
}

// mono 等宽字体单字符宽度 ≈ 字号的 0.6 倍(JetBrains Mono / SF Mono 等等宽
// 字体的通用比例,tabular-nums 保证同一字体下所有数字字符同宽)。不追求
// 像素级字体度量精度(那需要真实测量或字体 metrics 表)——目标只是"留够
// 空间不裁字符",按字符数估算足够达到这个目标。
const MONO_CHAR_WIDTH_RATIO = 0.6;

/**
 * 估算数值 v 格式化成轴标签(见 formatAxisUsd)后,在给定字号下的渲染宽度
 * (px,不含左侧 gap)。调用方(EquityCurve/Sparkline)据此决定 y 轴留白
 * (padL)至少要多宽,避免最左侧字符(几乎总是负号)跑出 SVG viewBox 被裁。
 */
export function estimateAxisLabelWidth(v: number, fontSize: number): number {
  return formatAxisUsd(v).length * fontSize * MONO_CHAR_WIDTH_RATIO;
}
