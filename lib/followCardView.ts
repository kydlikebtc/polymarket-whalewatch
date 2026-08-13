// 跟单页策略卡的纯展示逻辑。提到 lib/ 是因为 app/ 下没有组件测试基建 ——
// 卡态判定、净值曲线的平滑插值(不过冲)是这次改版里仅有的几块可被自动化
// 覆盖的逻辑,留在 page.tsx 里就只能靠目视。
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
 * 净值曲线的平滑路径:单调三次 Hermite 插值(Fritsch–Carlson,1980)生成的
 * 三次贝塞尔曲线,取代原先 EquityCurve 的本地 stepPath 与这里的
 * sparklinePath 两份阶梯(step-after)实现——这次统一成同一个函数,两处
 * 调用方共用(见 app/follow/page.tsx 的 EquityCurve/Sparkline)。
 *
 * 为什么原来是阶梯、现在能改成平滑曲线:阶梯准确表达"下一次结算之前累计
 * 净值保持不变"这条口径(见 lib/follow.ts computeStrategyMetrics 顶部
 * 注释「只记结算盈亏,不做浮盈」)。平滑曲线在视觉上会暗示两次结算之间净值
 * 连续变化,这不真实——补偿办法是把每个结算点的标记做得足够显著(调用方
 * circle 的改动),让读者一眼看出"数据只存在于这些点上,中间只是连接",
 * 不是插值出的真实轨迹。这也是为什么下面的退化情形防护、"不修改入参"这些
 * 纪律原样保留自 sparklinePath——换的只是两点之间怎么连,不是整体设计原则。
 *
 * 为什么不能用最常见的 Catmull-Rom/自然三次样条:那类样条只保证曲线经过
 * 每个数据点,不保证单调——在"平-平-陡升-平"这类形状上会在陡升段两侧的
 * 平段"冲过头",画出一个从未真实发生过的净值峰值/谷底(见
 * followCardView.test.ts 的过冲回归用例)。单调三次插值额外保证:曲线在
 * 任意相邻两个数据点之间,取值不越出这两点 y 值的值域——这是财务图表不能
 * 退让的底线,不是锦上添花的平滑度偏好。
 *
 * 不过冲的证明梗概(推导细节见下方 monotoneTangents 的注释):
 *   1. 三次贝塞尔曲线的取值必然落在它四个控制点的凸包内(凸组合的基本
 *      性质)——只要证明"每段的两个中间控制点的 y 值都落在该段两个端点
 *      y 值的值域内",整条曲线就不可能越界,这是比逐点验证曲线本身更容易
 *      核实的充分条件。
 *   2. 标准 Hermite→Bezier 换算(每段区间宽度记 h,中间控制点从端点沿切线
 *      方向偏移 h/3)下,中间控制点的 y 偏移量正比于 α=m_k/Δ_k(该点切线
 *      与本段割线斜率之比;另一端点同理用 β)。只要 0 ≤ α ≤ 3(β 同理),
 *      偏移量就不会超出端点 y 值的值域。
 *   3. Fritsch–Carlson 条件(见 monotoneTangents)对每段强制 α,β ≥ 0
 *      (符号不符说明该端点是局部极值或平段边界,切线该为 0)且
 *      α²+β² ≤ 9(半径 3 的"圆测试",可以推出 α,β 都 ≤3)。两条件叠加,
 *      上面的充分条件在每一段都成立。
 *
 * 与旧 stepPath 同一种"外部传入 sx/sy"签名,而不是旧 sparklinePath 那种
 * "自带 width/height、各自定域"签名——EquityCurve 要求多条策略共享同一套
 * 坐标系才能互相比较,自定域签名做不到这件事,这次统一按 EquityCurve 的
 * 需求选了 sx/sy 签名;Sparkline(详情弹窗放大版)若要继续"局部坐标 +
 * <g transform> 平移"的画法,调用方自己用现成的绝对坐标 sx/sy 平移出局部
 * 版本即可(两行闭包,不需要这个函数再支持第二种签名)。
 *
 * 退化情形防护(沿用原 sparklinePath 的纪律,不产出 NaN):空数组→空
 * 字符串;单点→只有 M、没有 C 段;相邻两点 x 坐标重合(同一时间戳结算多笔,
 * 或调用方的 sx 在 tSpan===0 时把所有点映射到同一处)→该段割线斜率记 0,
 * 退化成一条竖直线,不除零。不修改入参数组。
 */
export function smoothCurvePath(
  curve: { ts: number; cum: number }[],
  sx: (t: number) => number,
  sy: (v: number) => number,
): string {
  if (curve.length === 0) return "";
  const pts = [...curve].sort((a, b) => a.ts - b.ts);
  const xs = pts.map((p) => sx(p.ts));
  const ys = pts.map((p) => sy(p.cum));
  const n = xs.length;

  if (n === 1) {
    return `M ${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;
  }

  const m = monotoneTangents(xs, ys);
  let d = `M ${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = xs[i + 1] - xs[i];
    const c1x = xs[i] + h / 3;
    const c1y = ys[i] + (m[i] * h) / 3;
    const c2x = xs[i + 1] - h / 3;
    const c2y = ys[i + 1] - (m[i + 1] * h) / 3;
    d +=
      ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ` +
      `${c2x.toFixed(1)} ${c2y.toFixed(1)} ` +
      `${xs[i + 1].toFixed(1)} ${ys[i + 1].toFixed(1)}`;
  }
  return d;
}

/**
 * Fritsch–Carlson(1980)单调三次插值的切线估计,供 smoothCurvePath 使用。
 * xs 必须已按升序排列(smoothCurvePath 排序后才调用)。
 *
 * 步骤:
 *   1. 相邻点割线斜率 Δ_k(像素坐标系下的 dy/dx)。xs[k+1]===xs[k](同一
 *      时间戳,或调用方的 sx 把多点映射到同一处)时记 0——不能除零,也是
 *      唯一几何自洽的选择(该段没有水平范围,谈不上"斜率")。
 *   2. 每个内部点初始切线取相邻两段割线斜率的算术平均,端点切线取唯一
 *      相邻那段的割线斜率(标准初始估计,还未保证单调)。
 *   3. 割线斜率为 0 的段(该段两端点 y 值相等),强制其两端切线也为 0——
 *      否则曲线会在"本该走平"的一段里鼓出一个凸起:该段值域是单个值,
 *      任何偏离都算过冲,不存在"轻微过冲可以接受"这回事。
 *   4. 其余每一段按 α=m_k/Δ_k、β=m_{k+1}/Δ_k 收缩:符号不对(局部极值
 *      点)则对应端点切线清零;α²+β²>9(半径 3 的圆测试)则按比例
 *      τ=3/√(α²+β²) 收缩两端切线。这两条正是 smoothCurvePath 顶部注释里
 *      "不过冲证明"依赖的条件。
 */
function monotoneTangents(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  const secants: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1] - xs[i];
    secants.push(dx === 0 ? 0 : (ys[i + 1] - ys[i]) / dx);
  }

  const m: number[] = new Array(n);
  m[0] = secants[0];
  m[n - 1] = secants[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = (secants[i - 1] + secants[i]) / 2;
  }

  // 平段(割线斜率 0)两端强制清零——见函数顶部注释第 3 步。必须在下面的
  // 符号/圆测试之前做完:那一步要拿 secants[i] 当分母,平段的 0 会除零。
  for (let i = 0; i < n - 1; i++) {
    if (secants[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    }
  }

  // 逐段符号 + 圆测试收缩——见函数顶部注释第 4 步。
  for (let i = 0; i < n - 1; i++) {
    const sec = secants[i];
    if (sec === 0) continue; // 上一步已清零,且 alpha/beta 在这里会除零
    if (m[i] / sec < 0) m[i] = 0;
    if (m[i + 1] / sec < 0) m[i + 1] = 0;
    const alpha = m[i] / sec;
    const beta = m[i + 1] / sec;
    const s = alpha * alpha + beta * beta;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * alpha * sec;
      m[i + 1] = tau * beta * sec;
    }
  }

  return m;
}

/**
 * 面积填充路径 = 折线路径 + 沿底边闭合。仅用于 sparkline 的视觉重量,
 * 不承载任何额外信息。
 *
 * 闭合方式:从 linePath 的终点垂直落到底边(x 不变,y=height),沿底边走到
 * x=0,再 Z 回到 linePath 的起点。linePath 的起点 x 未必是 0(调用方
 * Sparkline 的局部坐标 sx 在 tSpan===0 时把唯一/同值点画在 width/2),所以
 * 这里不假设它是 0 —— Z 命令会自动直线连回路径起点,不需要显式写出起点
 * 坐标。
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
  undefined, // 实线 —— 前 13 档(独立色相区)全部实线
  "7 4", // 长虚线 —— 第 14 档起色相回用时的兜底区分
  // 2026-08-13 从 4 种缩到 2 种:dash-dot/dash-dot-dot 在十几条线同屏的
  // 密集折线上与普通虚线几乎不可辨(线上「黑色毛线团」截图的一部分成因),
  // 区分职责移交给下面扩到 13 个的独立色相;线型降级为色相耗尽后的次要通道。
];

/**
 * 净值曲线专用分类色板(2026-08-13 重做)。旧版只用设计系统的 4 个非语义
 * token(蓝/近黑/深琥珀/中灰),13 档同屏时近半的线挤进黑灰系 —— 线上真机
 * 截图「糊成黑色毛线团」。教训:**同屏多线的第一区分通道是色相**,4×4 的
 * 线型组合弥补不了色相不足。
 *
 * 现版 13 个色相 = 当前策略总数,每档一条独立颜色的实线。字面 oklch 而非
 * token:设计系统的非语义色相只有 2 个,图表分类色板本来就是独立于 UI
 * 语义色的一套(dataviz 惯例),放这里集中管理。三条纪律:
 *  - 亮度/彩度压在同一窗口(L 45%-68%、C 0.05-0.20),没有哪条天生更醒目;
 *  - 避开盈亏语义色相带:绿 140-170(up-500=155)、红 0-40(down-500=25)
 *    整段不用 —— 图例里紧挨的净值数字用的就是这两色,线条撞色相会被误读
 *    成盈亏方向(followCardView.test.ts 直接断言这条带禁);
 *  - 相邻下标色相错开(蓝→紫→橙→青…非顺时针排列),13 条同屏时挨着的
 *    线不会是渐变近邻色。
 */
export const STRATEGY_COLORS = [
  "var(--brand-500)", // 1 电蓝 · 品牌主色(hue 245,保持保守档与旧版视觉连续)
  "oklch(58% 0.19 305)", // 2 紫
  "oklch(65% 0.17 55)", // 3 橙
  "oklch(60% 0.13 210)", // 4 青
  "oklch(60% 0.19 340)", // 5 品红
  "oklch(52% 0.11 120)", // 6 橄榄(黄绿,离 up 155 有距离)
  "var(--n-900)", // 7 近黑 · 强中性
  "oklch(70% 0.15 85)", // 8 琥珀
  "oklch(55% 0.19 280)", // 9 蓝紫
  "oklch(50% 0.10 60)", // 10 棕
  "oklch(55% 0.12 180)", // 11 深青绿
  "oklch(62% 0.05 250)", // 12 灰蓝(低彩度,与电蓝靠彩度区分)
  "oklch(45% 0.15 325)", // 13 深紫红
] as const;

/**
 * 线型 × 颜色的完整组合表,**线型外层、颜色内层**展开(`DASHES.flatMap(dash
 * => COLORS.map(color => ...))`,2026-08-13 与旧版相反)—— 这个展开顺序的
 * 直接后果:前 13 条(= 当前全部策略)全部实线、各占独立色相,色相是第一
 * 区分通道;第 14 条起色相从头回用、换成虚线兜底(同色的两条相距
 * COLORS.length,线型必不同)。旧版「相邻下标线型必不同」的色盲策略随之
 * 换成「同色必不同线型」:13 个色相里刻意混入近黑/灰蓝/棕等靠明度彩度
 * 区分的条目,色觉差异读者仍有抓手,而普通读者不再面对 4 条黑灰线打结。
 * 见 followCardView.test.ts 对这些性质的直接断言。
 *
 * ⚠️ 组合数上限 = COLORS × DASHES(当前 13×2=26)。超出后回绕成视觉相同
 * 的线,strokeFor 不报错 —— app/follow/page.tsx 用 strokeOverflowCount
 * console.warn,上限不能只活在注释里。为什么不追求无限增长:人眼同屏分辨
 * 十几条线已是极限,真到 26+ 档,正确修法是产品层面限制同屏对比数
 * (曲线族筛选器已存在),不是再塞第 27 种视觉编码。
 */
export const STRATEGY_STROKES = STRATEGY_DASHES.flatMap((dash) =>
  STRATEGY_COLORS.map((color) => ({ dash, color })),
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

/* ------------------------------------------------- equity curve markers */
// 大图(app/follow/page.tsx 的 EquityCurve)结算点标记半径,按该条策略曲线
// 自身的点数动态算——2026-08 真机截图报告:「激进」档 30 个结算点在大图里
// 挤成一条实心珠链,把曲线本身盖住了。
//
// 这条规则与详情弹窗放大版 Sparkline"标记必须无条件比线粗"的既有规则
// (见 smoothCurvePath 顶部注释「为什么能从阶梯改成平滑」)刻意相反,不是
// 两处实现漂移出的不一致——同一个补偿决策(曲线改平滑后,标记要足够显眼,
// 提醒读者"数据只在这些点上,中间是插值")在两种数据密度下结论相反:
//   - 详情弹窗一次只画一条线,点数从个位数到二三十,画布接近全宽(~1200px)
//     独占,大把留白装得下醒目的圆点,标记加强只有好处。
//   - 大图最多同屏叠画 16 条策略曲线(见 STRATEGY_STROKES 注释)、共享同一块
//     720×220 画布,单条线点数一多,再叠上其他线的点,固定半径的标记会连成
//     串——这时"曲线本身清晰可辨"比"每个点都突出"更重要,而且大图本身不
//     支持点选查看单笔明细(那是 Sparkline 的职责),标记退化成纯粹的密度
//     提示,不需要在默认状态就抢眼。
//
// 两级策略:
//   - highlighted(该线被图例 hover/聚焦):不管点数多少固定放大——聚焦的
//     意图就是"现在只看这一条线",不该因为点多而缩手缩脚。
//   - 非 highlighted(默认,或因为聚焦了别的线而被淡化,两者共用同一半径,
//     淡化本身已经由调用方在 <g> 整组设 opacity 完成,见 EquityCurve):按
//     点数在 [MIN_RADIUS, SPARSE_RADIUS] 区间线性收缩,点数越多半径越小,
//     但设下限——再密的曲线也留一点可见度,彻底消失会被误读成"这段没有
//     结算",而不是"结算点很密"。
//
// 具体数值是真机(1400/900/375 三档视口 + mock 30 点场景)来回调出来的,不是
// 纯算出来的——见 app/follow/page.tsx EquityCurve 组件的截图验收记录。
export function equityCurveMarkerRadius(
  pointCount: number,
  highlighted: boolean,
): number {
  const HIGHLIGHTED_RADIUS = 4.2;
  if (highlighted) return HIGHLIGHTED_RADIUS;

  const SPARSE_POINT_COUNT = 10; // <= 这个点数:曲线本身够稀疏,给明显的半径
  const DENSE_POINT_COUNT = 30; // >= 这个点数:收到下限,不再继续缩小
  const SPARSE_RADIUS = 2.2;
  const MIN_RADIUS = 1.3;

  if (pointCount <= SPARSE_POINT_COUNT) return SPARSE_RADIUS;
  if (pointCount >= DENSE_POINT_COUNT) return MIN_RADIUS;

  // 两个阈值之间线性插值,不是在 SPARSE/MIN 之间跳变——点数从 11 涨到 29
  // 时半径应该平滑收缩,不能在某个点数上突然跳一截,那样反而会让读者以为
  // 这里发生了什么特殊事件。
  const t =
    (pointCount - SPARSE_POINT_COUNT) /
    (DENSE_POINT_COUNT - SPARSE_POINT_COUNT);
  return SPARSE_RADIUS - t * (SPARSE_RADIUS - MIN_RADIUS);
}
