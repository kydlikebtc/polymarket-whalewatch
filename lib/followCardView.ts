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

/* ---------------------------------------------------------- time ticks */

export type TimeTick = {
  ts: number;
  label: string;
  anchor: "start" | "middle" | "end";
};

/**
 * x 轴时间刻度:端点 + 两个三分点(等距,不追求整点对齐——结算是离散事件,
 * 完整覆盖首尾比整点更重要)。跨度 ≥3 天只标日期("M/D"),更短带时分
 * ("M/D HH:mm");相邻重复标签去重(极短窗口下四个刻度可能格式化成同一
 * 串,例如全部落在同一分钟内)。
 *
 * 从 app/follow/page.tsx 的 EquityCurve 组件原地提取(那里最早实现这份
 * 逻辑,详情弹窗放大版 Sparkline 现在也要用同一套坐标轴)——两处画的都是
 * "结算时间"这同一个量,刻度选取与格式化必须是同一份计算,不允许两边
 * 各自维护、随时间推移长出两套不一致的日期表达。只返回 {ts, label,
 * anchor},不返回像素坐标 x——两个调用方的 sx() 定义域/值域不同(大图
 * 720 宽、详情图 1120 宽),把 ts→x 的映射留给各自调用方按自己的 sx 算,
 * 这个函数只管"选哪些点、标什么字、往哪边对齐"这个与画布尺寸无关的部分。
 */
export function computeTimeTicks(tMin: number, tMax: number): TimeTick[] {
  const tSpan = tMax - tMin;
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
  const ticks: TimeTick[] = [];
  for (let i = 0; i < tickTs.length; i++) {
    const label = fmtTick(tickTs[i]);
    if (ticks.length > 0 && ticks[ticks.length - 1].label === label) continue;
    ticks.push({
      ts: tickTs[i],
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
  return ticks;
}

/* ------------------------------------------------------- strategy strokes */
// 结算净值曲线多策略叠加(app/follow/page.tsx 的 EquityCurve)靠"线型 × 颜色"
// 组合区分每一条线。提到 lib/ 是因为这是这份组合表第一次被要求证明自己的两条
// 性质(见下方 followCardView.test.ts):相邻组合线型必不同、颜色不撞语义色——
// 在纯函数里断言比只靠人眼审图可靠。

/**
 * 阶梯图(step-after)专用的 SVG stroke-dasharray 集合。每种非实线模式至少
 * 有一段 "on"(奇数位是 off,偶数位是 on)长度 >= 7px:阶梯图的转折点多、
 * 线段短,纯短促笔画(比如曾经试过的纯点状 "2 4")在短线段上会被裁得只剩
 * 零星几个点,视觉上判若无线。"10 4 2 4"(长虚线+一个点)与
 * "10 4 2 4 2 4"(长虚线+两个点)里较短的 "2" 只是伴随长笔画的点缀,不是
 * 主要识别特征,整体仍然可读——这条约束(见 followCardView.test.ts)锁的是
 * "至少一段够长",不是"每一段都够长"。
 */
export const STRATEGY_DASHES: (string | undefined)[] = [
  undefined, // 实线
  "7 4", // 长虚线
  "10 4 2 4", // 虚点相间(dash-dot)
  "10 4 2 4 2 4", // 虚点点相间(dash-dot-dot)—— 2026-08 第 13 档上线时新增第 4 种,
  // 复用前一种已验证过的 10/4/2 三个数字,只是多重复一节"2 4",不引入新的
  // 未验证笔画长度。
];

/**
 * 净值曲线的非语义色板。up(绿)/down(红)是全站盈亏色语义——图例里紧挨着
 * 的净值数字就用这两色,线条颜色若撞上会让读者误以为颜色代表盈亏,故排除。
 * 设计系统里排除 up/down 后只剩 brand(蓝相)/warn(琥珀相)两种有色相的
 * token,加两档中性灰(n-900/n-500,靠明度而非色相区分)凑够 4 种——这是
 * 当前设计系统实际拥有的、非语义色相的上限,不是随手挑的数字(见下方
 * STRATEGY_STROKES 注释"为什么不追求组合数无限增长")。
 */
export const STRATEGY_COLORS = [
  "var(--brand-500)", // 电蓝 · 品牌主色
  "var(--n-900)", // 近黑 · 最强中性色
  "var(--warn-700)", // 深琥珀 · 与蓝/黑拉开色相,兼容色觉差异
  "var(--n-500)", // 中灰 · 弱中性色,与近黑靠明度而非色相区分
] as const;

/**
 * 线型 × 颜色的完整组合表,颜色外层、线型内层展开(`COLORS.flatMap(color =>
 * DASHES.map(dash => ...))`)—— 这个展开顺序本身就是"相邻下标线型必不同"这条
 * 性质的证明:同一种颜色内部的几条(线型下标 0..DASHES.length-1)靠线型互相
 * 区分,颜色边界处线型从最后一种回到第一种(必然不同),所以任意相邻下标
 * (i, i+1)之间线型永远不会相同——色盲读者不需要分辨色相就能确认"这是两条
 * 不同的线",颜色只在跨过一整组线型(距离 >= DASHES.length)之后才成为唯一
 * 依据。见 followCardView.test.ts 对这条性质的直接断言。
 *
 * ⚠️ 组合数上限 = STRATEGY_COLORS.length × STRATEGY_DASHES.length(当前
 * 4×4=16)。2026-08 第 13 档「逆势少数边」上线时把这个数字从 12 扩到 16——
 * 12 不是巧合,它就是当时的策略总数,硬编码一个刚好等于当前策略数的常量,
 * 等于把"以后不会再加档"悄悄写进了代码。第 17 档及以后会与
 * (第几档 − 16)号策略回绕成完全相同的线型+颜色,strokeFor 不会报错、
 * 图上会静默出现两条视觉相同的线,只有主动去数策略数才会发现——
 * app/follow/page.tsx 的 FollowPage 用 strokeOverflowCount 在这种情况下
 * console.warn,不能让上限只活在这段注释里。
 *
 * 为什么这里选择"给一个比当前策略数宽裕的上限 + 用尽了主动报警",而不是
 * 追求组合数随策略数无限增长:设计系统里可用的非语义色相已经见底(见上面
 * STRATEGY_COLORS 注释),线型也有极限(过短的笔画在阶梯图短线段上会视觉
 * 消失,见 STRATEGY_DASHES 注释)——硬凑更多维度只会让线型和颜色都变得难以
 * 分辨。更根本的是,人眼同屏分辨十几条以上的线本身就已经很吃力,这是数据
 * 可视化的普遍限制,不是这个组件能靠更聪明的取模算法解决的问题;真到了那个
 * 规模,更合适的修法是产品层面限制同屏对比的策略数(比如加一个"最多同时选
 * N 条"的曲线族筛选器),而不是无止境地往这张表里塞新的线型/颜色。
 */
export const STRATEGY_STROKES = STRATEGY_COLORS.flatMap((color) =>
  STRATEGY_DASHES.map((dash) => ({ dash, color })),
);

/** 按策略在 `shown` 里的顺序下标取对应的线型+颜色,超出容量按 `i % 容量` 回绕。 */
export function strokeFor(i: number): {
  dash: string | undefined;
  color: string;
} {
  return STRATEGY_STROKES[i % STRATEGY_STROKES.length];
}

/**
 * 超出 STRATEGY_STROKES 容量的策略数——第 17 档及以后会与更早的策略共用
 * 同一条线型+颜色,图上视觉不可区分。调用方据此决定要不要 console.warn
 * (见 STRATEGY_STROKES 字段注释)。未超容量返回 0。
 */
export function strokeOverflowCount(totalStrategies: number): number {
  return Math.max(0, totalStrategies - STRATEGY_STROKES.length);
}
