import { describe, it, expect } from "vitest";
import {
  classifyCardState,
  computeTimeTicks,
  equityCurveMarkerRadius,
  estimateAxisLabelWidth,
  formatAxisUsd,
  smoothCurvePath,
  sparklineAreaPath,
  LOW_SAMPLE_THRESHOLD,
  STRATEGY_COLORS,
  STRATEGY_DASHES,
  STRATEGY_STROKES,
  strokeFor,
  strokeOverflowCount,
} from "./followCardView";

// 从生成的 SVG path 字符串里按顺序抽出所有 (x, y) 坐标对——path 里的数字全部
// 空格分隔(M/C 命令都不用逗号,见 smoothCurvePath 的拼接方式),按 "M x y"
// 后跟若干 "C c1x c1y c2x c2y ex ey" 排列,所以去掉命令字母、按空白切分、
// 两两成对即可还原出完整点序,不需要为 M/C 分别写正则。
function allPointsOf(path: string): { x: number; y: number }[] {
  const nums = path
    .split(/[MC\s]+/)
    .filter((s) => s.length > 0)
    .map(Number);
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    pts.push({ x: nums[i], y: nums[i + 1] });
  }
  return pts;
}

// 断言 smoothCurvePath 的输出对给定 curve 不过冲:逐段取该段两个贝塞尔控制点
// 的 y 值,必须落在该段两端点 y 值的值域内(±EPS 容忍 toFixed(1) 的舍入,
// 最大舍入误差 0.05,过冲测试用例里真实的越界幅度是这个量级的几十到上百倍,
// 不会被 EPS 掩盖)。allPointsOf 返回 [起点, c1_0,c2_0,end_0, c1_1,c2_1,end_1,
// …],第 seg 段(连接 curve[seg]→curve[seg+1])的两个控制点位于下标
// 1+seg*3、1+seg*3+1。
function assertNoOvershoot(
  curve: { ts: number; cum: number }[],
  path: string,
): void {
  const pts = allPointsOf(path);
  const ys = curve.map((p) => p.cum);
  const EPS = 0.1;
  for (let seg = 0; seg < curve.length - 1; seg++) {
    const lo = Math.min(ys[seg], ys[seg + 1]) - EPS;
    const hi = Math.max(ys[seg], ys[seg + 1]) + EPS;
    const c1 = pts[1 + seg * 3];
    const c2 = pts[1 + seg * 3 + 1];
    expect(c1.y).toBeGreaterThanOrEqual(lo);
    expect(c1.y).toBeLessThanOrEqual(hi);
    expect(c2.y).toBeGreaterThanOrEqual(lo);
    expect(c2.y).toBeLessThanOrEqual(hi);
  }
}

describe("classifyCardState — 三种卡态", () => {
  it("已结算 0 仓 → empty(不画曲线,虚线卡)", () => {
    expect(classifyCardState({ settledCount: 0, openCount: 0 })).toBe("empty");
  });

  it("已结算 0 仓但有持仓 → 仍是 empty(净值曲线需要结算点才有数据)", () => {
    expect(classifyCardState({ settledCount: 0, openCount: 3 })).toBe("empty");
  });

  it("已结算不足阈值 → low_sample(照常显示数字,但加警示)", () => {
    expect(classifyCardState({ settledCount: 3, openCount: 1 })).toBe(
      "low_sample",
    );
  });

  it("恰好等于阈值 → normal(阈值是「达到即可信」)", () => {
    expect(
      classifyCardState({ settledCount: LOW_SAMPLE_THRESHOLD, openCount: 0 }),
    ).toBe("normal");
  });

  it("超过阈值 → normal", () => {
    expect(classifyCardState({ settledCount: 44, openCount: 7 })).toBe(
      "normal",
    );
  });
});

describe("smoothCurvePath — 单调三次插值(Fritsch–Carlson)的平滑路径", () => {
  // 恒等映射:sx/sy 直接返回输入值,断言时坐标就是数据本身,不用另算一遍
  // 缩放系数。smoothCurvePath 对 sx/sy 的处理是纯回调转发(不内置任何坐标
  // 系假设),用恒等函数测试和用真实的缩放/平移函数测试,覆盖的是同一段
  // 代码——下面另有一个用例专门验证非恒等 sx/sy 真的被用上,而不是内部抄了
  // 近路。
  const idSx = (t: number) => t;
  const idSy = (v: number) => v;

  it("空曲线 → 空字符串(调用方据此不渲染 svg)", () => {
    expect(smoothCurvePath([], idSx, idSy)).toBe("");
  });

  it("单点 → 只有 M、没有 C 段(没有第二个点,谈不上曲线)", () => {
    const d = smoothCurvePath([{ ts: 100, cum: 50 }], idSx, idSy);
    expect(d).toBe("M 100.0 50.0");
    expect(d).not.toContain("C");
  });

  it("全部同值(cum 恒定)→ 不产生 NaN/Infinity,且不鼓出偏离该值的凸起", () => {
    const curve = [
      { ts: 1, cum: 10 },
      { ts: 2, cum: 10 },
      { ts: 3, cum: 10 },
    ];
    const d = smoothCurvePath(curve, idSx, idSy);
    expect(d).not.toContain("NaN");
    expect(d).not.toContain("Infinity");
    for (const p of allPointsOf(d)) {
      expect(p.y).toBeCloseTo(10, 1);
    }
  });

  it("恰好两点 → 退化成两点间的直线(没有第三个点可供插值,贝塞尔控制点落在连线上)", () => {
    // ts 跨度取 3(h/3 恰好整除)——贝塞尔控制点 x 坐标本身就该落在 .0,
    // 避免 toFixed(1) 的舍入误差被下面 ×10 的斜率检验放大 10 倍,那样会把
    // "实现正确"的用例误判成失败,不是在测真正的过冲逻辑。
    const d = smoothCurvePath(
      [
        { ts: 0, cum: 0 },
        { ts: 3, cum: 30 },
      ],
      idSx,
      idSy,
    );
    for (const p of allPointsOf(d)) {
      expect(p.y).toBeCloseTo(p.x * 10, 1); // 斜率 = 30/3 = 10
    }
  });

  it("不过冲:平-平-陡升-平构造,每段的两个贝塞尔控制点 y 都落在该段两端点的值域内", () => {
    // 这是会让"简单相邻割线取平均"的朴素三次样条过冲的经典构造:两段平坦
    // (ts 0→1、1→2,cum 恒 10)紧贴一段陡升(2→3,10→50),陡升后又是一段
    // 平坦(3→4,cum 恒 50)。未做 Fritsch–Carlson 修正时,紧贴陡升的那个
    // 端点(ts=2 与 ts=3)会分到一个非零的平均切线,导致相邻的平坦段被拽出
    // 一个偏离 10(或 50)的鼓包——手算过一遍:朴素平均给 ts=2 处切线 20、
    // ts=3 处切线 20,ts=1→2 这段的终点控制点 y 会算到 10-20/3≈3.3,越过
    // 该段值域 [10,10];ts=3→4 这段的起点控制点 y 会算到 50+20/3≈56.7,
    // 越过该段值域 [50,50]。这条用例把这两处算错都会触发的断言写成通用
    // 的逐段值域检查(assertNoOvershoot),不是只测这一个手算出的数字。
    const curve = [
      { ts: 0, cum: 10 },
      { ts: 1, cum: 10 },
      { ts: 2, cum: 10 },
      { ts: 3, cum: 50 },
      { ts: 4, cum: 50 },
    ];
    assertNoOvershoot(curve, smoothCurvePath(curve, idSx, idSy));
  });

  it("不过冲:锯齿构造(0→100→0→100)——每个内部点都是局部极值,朴素平均会在极值点两侧双向过冲", () => {
    const curve = [
      { ts: 0, cum: 0 },
      { ts: 1, cum: 100 },
      { ts: 2, cum: 0 },
      { ts: 3, cum: 100 },
    ];
    assertNoOvershoot(curve, smoothCurvePath(curve, idSx, idSy));
  });

  it("不过冲:随机波动数据(非整数间隔、含负值),仍逐段成立——不是只对整数构造凑巧成立", () => {
    const curve = [
      { ts: 0, cum: -30 },
      { ts: 3, cum: 12.5 },
      { ts: 5, cum: 8 },
      { ts: 6, cum: 8 },
      { ts: 12, cum: -5.5 },
      { ts: 13, cum: 40 },
    ];
    assertNoOvershoot(curve, smoothCurvePath(curve, idSx, idSy));
  });

  it("相邻两点被 sx 映射到同一 x(如调用方 tSpan===0 时的兜底)→ 不产生 NaN/Infinity", () => {
    const d = smoothCurvePath(
      [
        { ts: 1, cum: 10 },
        { ts: 2, cum: 90 },
      ],
      () => 50, // 常函数,模拟"多个点共享同一像素位置"
      idSy,
    );
    expect(d).not.toContain("NaN");
    expect(d).not.toContain("Infinity");
  });

  it("输入乱序时按 ts 升序重排(不信任入参有序性)", () => {
    const points = [
      { ts: 1, cum: 0 },
      { ts: 2, cum: 100 },
      { ts: 3, cum: 40 },
    ];
    const ordered = smoothCurvePath(points, idSx, idSy);
    const shuffled = smoothCurvePath(
      [points[2], points[0], points[1]],
      idSx,
      idSy,
    );
    expect(shuffled).toBe(ordered);
  });

  it("不修改入参数组", () => {
    const input = [
      { ts: 2, cum: 100 },
      { ts: 1, cum: 0 },
    ];
    const snapshot = JSON.stringify(input);
    smoothCurvePath(input, idSx, idSy);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("严格通过 sx/sy 回调映射——EquityCurve 传共享绝对坐标、Sparkline 传局部平移坐标,两种调用方式都要生效", () => {
    const d = smoothCurvePath(
      [
        { ts: 0, cum: 0 },
        { ts: 1, cum: 10 },
      ],
      (t) => 100 + t * 50, // 偏移 + 缩放
      (v) => 200 - v * 2, // 偏移 + 反向缩放(SVG y 轴向下为正)
    );
    expect(d.startsWith("M 100.0 200.0")).toBe(true);
    expect(d).toContain("150.0 180.0"); // 终点:sx(1)=150,sy(10)=180
  });
});

describe("sparklineAreaPath — 面积填充路径", () => {
  const W = 240;
  const H = 52;

  it("空输入 → 空字符串", () => {
    expect(sparklineAreaPath("", W, H)).toBe("");
  });

  it("非空输入 → 以 Z 结尾且含底边两点(与 linePath 终点、原点闭合)", () => {
    // 手写一段最小 path 字符串即可——sparklineAreaPath 只做字符串拼接闭合,
    // 不解析 linePath 内部结构,不需要依赖 smoothCurvePath 的真实输出来验证
    // 它(两个函数的测试保持互相独立)。
    const line = "M 0.0 52.0 C 80.0 10.0 160.0 10.0 240.0 0.0";
    const area = sparklineAreaPath(line, W, H);
    expect(area.endsWith("Z")).toBe(true);
    expect(area).toContain(`L ${W.toFixed(1)} ${H}`);
    expect(area).toContain(`L 0 ${H}`);
  });
});

describe("formatAxisUsd — 净值曲线 y 轴标签格式化", () => {
  it("正数不带符号:$1,234", () => {
    expect(formatAxisUsd(1234)).toBe("$1,234");
  });

  it("负数用数学减号(U+2212),不是 ASCII 连字符:−$1,234", () => {
    expect(formatAxisUsd(-1234)).toBe("−$1,234");
    expect(formatAxisUsd(-1234)).not.toContain("-"); // ASCII 连字符
  });

  it("0 记为不带符号的 $0(不是 −$0)", () => {
    expect(formatAxisUsd(0)).toBe("$0");
  });

  it("四舍五入取整、千分位分组", () => {
    expect(formatAxisUsd(1234.6)).toBe("$1,235");
    expect(formatAxisUsd(1000000)).toBe("$1,000,000");
  });
});

describe("estimateAxisLabelWidth — 轴标签宽度估算(bug 修复:负号被裁)", () => {
  const FONT = 10;

  it("负数比同位数的正数需要更多宽度(多一个负号字符)", () => {
    // 回归本次 bug 的原始现场:−$11,448 这类大额亏损曾经被 padL=48 裁掉
    // 负号,显示成看似盈利的 $11,448。
    const positive = estimateAxisLabelWidth(11448, FONT);
    const negative = estimateAxisLabelWidth(-11448, FONT);
    expect(negative).toBeGreaterThan(positive);
  });

  it("大额比小额需要更多宽度(数位更多)", () => {
    const small = estimateAxisLabelWidth(42, FONT);
    const large = estimateAxisLabelWidth(1234567, FONT);
    expect(large).toBeGreaterThan(small);
  });

  it("字号越大,估算宽度按比例放大", () => {
    const small = estimateAxisLabelWidth(1000, 10);
    const large = estimateAxisLabelWidth(1000, 20);
    expect(large).toBeCloseTo(small * 2, 5);
  });

  it("宽度 = formatAxisUsd 输出的字符数 × 字号 × 固定比例(与实际渲染文字同源)", () => {
    const v = -98765;
    const fontSize = 12;
    const expected = formatAxisUsd(v).length * fontSize * 0.6;
    expect(estimateAxisLabelWidth(v, fontSize)).toBeCloseTo(expected, 5);
  });
});

describe("computeTimeTicks — 净值曲线 x 轴时间刻度(EquityCurve/放大版 Sparkline 共用)", () => {
  // 用本地时间构造器(而非裸时间戳字面量)拿到测试用的 epoch 秒——保证
  // "这一分钟从 0 秒开始"这个前提在任何时区跑测试都成立,不依赖 CI 时区
  // 与实现巧合一致(实现本身就是按 new Date(ts*1000) 的本地时间取值)。
  const localTs = (
    y: number,
    monthIndex: number,
    d: number,
    h: number,
    mi: number,
    s = 0,
  ) => Math.floor(new Date(y, monthIndex, d, h, mi, s, 0).getTime() / 1000);

  it("单点(tMin===tMax)→ 一个刻度,居中锚定;跨度 0 不满足「≥3 天」分支,仍带时分", () => {
    const ts = localTs(2026, 0, 15, 10, 30);
    expect(computeTimeTicks(ts, ts)).toEqual([
      { ts, label: "1/15 10:30", anchor: "middle" },
    ]);
  });

  it("跨度 <3 天 → 四个三分点标签都带时分(HH:mm),互不相同", () => {
    const tMin = localTs(2026, 0, 15, 0, 0);
    const tMax = tMin + 86400; // 1 天跨度
    const ticks = computeTimeTicks(tMin, tMax);
    expect(ticks).toHaveLength(4);
    for (const t of ticks) {
      expect(t.label).toMatch(/^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
    }
  });

  it("跨度恰为 3 天(边界含)→ 触发纯日期格式,不带时分", () => {
    const tMin = localTs(2026, 0, 15, 0, 0);
    const tMax = tMin + 3 * 86400;
    for (const t of computeTimeTicks(tMin, tMax)) {
      expect(t.label).toMatch(/^\d{1,2}\/\d{1,2}$/);
    }
  });

  it("跨度差 1 小时不到 3 天 → 仍带时分,3 天是硬边界不是约等于", () => {
    const tMin = localTs(2026, 0, 15, 0, 0);
    const tMax = tMin + 3 * 86400 - 3600;
    for (const t of computeTimeTicks(tMin, tMax)) {
      expect(t.label).toMatch(/:\d{2}$/);
    }
  });

  it("端点朝内锚定、中间点居中:首 start · 中 middle × 2 · 尾 end", () => {
    const tMin = localTs(2026, 0, 1, 0, 0);
    const tMax = tMin + 10 * 86400; // 跨度够大,四个三分点标签互不相同不触发去重
    const ticks = computeTimeTicks(tMin, tMax);
    expect(ticks.map((t) => t.anchor)).toEqual([
      "start",
      "middle",
      "middle",
      "end",
    ]);
  });

  it("四个三分点的 ts 精确为 tMin + f×span(f = 0, 1/3, 2/3, 1)", () => {
    expect(computeTimeTicks(0, 300).map((t) => t.ts)).toEqual([
      0, 100, 200, 300,
    ]);
  });

  it("极短窗口内四个候选点落进同一分钟 → 全部折叠成 1 个,首刻度(i=0)恒存活、恒 start 锚定", () => {
    const tMin = localTs(2026, 0, 15, 10, 30, 0);
    // 2 秒跨度,四个三分点都落在 [10:30:00, 10:30:02] 内,同一分钟。
    expect(computeTimeTicks(tMin, tMin + 2)).toEqual([
      { ts: tMin, label: "1/15 10:30", anchor: "start" },
    ]);
  });

  it("去重按「相邻」比较,不做全局去重:90 秒跨度里第 2/3 分点越过分钟边界,保留两个不同分钟的刻度", () => {
    const tMin = localTs(2026, 0, 15, 10, 30, 0);
    // 三分点:+0s(10:30:00)/+30s(10:30:30)/+60s(10:31:00)/+90s(10:31:30)
    // → 标签 [10:30, 10:30, 10:31, 10:31],相邻去重后只留每个分钟的第一次出现。
    expect(computeTimeTicks(tMin, tMin + 90)).toEqual([
      { ts: tMin, label: "1/15 10:30", anchor: "start" },
      { ts: tMin + 60, label: "1/15 10:31", anchor: "middle" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 净值曲线多策略叠加的线型 × 颜色组合表(2026-08-13 重做:线上 13 档同屏,
// 旧 4 色 × 4 线型把近半的线涂成近黑/深灰系,用户截图反馈「糊成黑色毛线团」
// —— 色相才是同屏多线的第一区分通道,线型在密集折线上几乎不可辨)。新契约:
//   1. 独立色相优先:前 STRATEGY_COLORS.length(≥13,覆盖当前全部策略)条
//      全部实线且颜色两两不同 —— DASHES 外层/COLORS 内层展开的直接后果
//   2. 色相耗尽后才启用线型:同色的两条(i 与 i+COLORS.length)线型必不同
//   3. 颜色不含 up/down 语义 token,字面色也不落语义色相带(绿 140-170/
//      红 0-40)—— 盈亏语义不能被线条颜色借用
//   4. 非实线 dash 至少一段 >=7px 的 on 笔画(短线段上不消失)
//   5. strokeOverflowCount 正确反映超容量档数(page.tsx 靠它 console.warn)
// ---------------------------------------------------------------------------
describe("strokeFor / STRATEGY_STROKES — 净值曲线线型 × 颜色组合表", () => {
  it("色相数 ≥13(当前全部策略各占独立色相),组合数 = 线型 × 颜色", () => {
    expect(STRATEGY_COLORS.length).toBeGreaterThanOrEqual(13);
    expect(STRATEGY_STROKES).toHaveLength(
      STRATEGY_COLORS.length * STRATEGY_DASHES.length,
    );
  });

  it("容量内的组合两两不重复(dash+color 组合唯一,不存在两个策略天生撞成同一条线)", () => {
    const keys = STRATEGY_STROKES.map((s) => `${s.dash}|${s.color}`);
    expect(new Set(keys).size).toBe(STRATEGY_STROKES.length);
  });

  it("前 COLORS.length 条全部实线且颜色两两不同 —— 当前 13 档每档独立色相,不再靠线型硬分", () => {
    const head = STRATEGY_STROKES.slice(0, STRATEGY_COLORS.length);
    for (const s of head) expect(s.dash).toBeUndefined();
    expect(new Set(head.map((s) => s.color)).size).toBe(head.length);
  });

  it("同色配对(i 与 i+COLORS.length)线型必不同 —— 色相回用时靠线型兜底区分", () => {
    const n = STRATEGY_COLORS.length;
    for (let i = 0; i + n < STRATEGY_STROKES.length; i++) {
      expect(STRATEGY_STROKES[i].color).toBe(STRATEGY_STROKES[i + n].color);
      expect(STRATEGY_STROKES[i].dash).not.toBe(STRATEGY_STROKES[i + n].dash);
    }
  });

  it("颜色不含 up/down 语义 token;字面 oklch 色相不落绿(140-170)/红(≤40)语义带", () => {
    for (const color of STRATEGY_COLORS) {
      expect(color).not.toMatch(/--up-|--down-/);
      const m = color.match(/oklch\([^)]*\s(\d+(?:\.\d+)?)\)/);
      if (m) {
        const hue = Number(m[1]);
        expect(hue > 40).toBe(true);
        expect(hue < 140 || hue > 170).toBe(true);
      }
    }
  });

  it('非实线的 dash 模式里,"on" 笔画(偶数下标,0-based)至少有一段 >= 7px —— 若整段模式全是短促笔画,会在阶梯图短线段上视觉消失(此前因此弃用过纯点状 "2 4")', () => {
    for (const dash of STRATEGY_DASHES) {
      if (dash == null) continue; // 实线没有分段,不适用
      const segments = dash.split(" ").map(Number);
      const onSegments = segments.filter((_, idx) => idx % 2 === 0);
      expect(Math.max(...onSegments)).toBeGreaterThanOrEqual(7);
    }
  });

  it("strokeFor 按 i % 容量 回绕:第 容量+1 个与第 1 个取到完全相同的组合", () => {
    const cap = STRATEGY_STROKES.length;
    expect(strokeFor(cap)).toEqual(strokeFor(0));
    expect(strokeFor(cap + 1)).toEqual(strokeFor(1));
  });

  it("strokeFor 在容量之内逐个不同 —— 与上面「两两不重复」断言互相印证", () => {
    const seen = new Set<string>();
    for (let i = 0; i < STRATEGY_STROKES.length; i++) {
      const s = strokeFor(i);
      seen.add(`${s.dash}|${s.color}`);
    }
    expect(seen.size).toBe(STRATEGY_STROKES.length);
  });

  it("strokeOverflowCount:未超容量(含恰好用满)返回 0,超出返回超出的档数", () => {
    const cap = STRATEGY_STROKES.length;
    expect(strokeOverflowCount(0)).toBe(0);
    expect(strokeOverflowCount(13)).toBe(0); // 当前实际启用的策略数,留有余量
    expect(strokeOverflowCount(cap)).toBe(0); // 恰好用满容量,不算超出
    expect(strokeOverflowCount(cap + 1)).toBe(1);
    expect(strokeOverflowCount(cap + 4)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// equityCurveMarkerRadius(2026-08 真机截图报告:「激进」档 30 个结算点在大图
// 里挤成一条珠链,盖住曲线本身)——与详情弹窗 Sparkline"标记必须无条件比线
// 粗"的规则刻意相反,这里锁住的正是这条分叉规则本身的三条性质:highlighted
// 无条件覆盖点数、非 highlighted 时点数越多半径越小、半径有下限不会消失。
// ---------------------------------------------------------------------------
describe("equityCurveMarkerRadius — 大图结算点标记半径(按点数密度自适应)", () => {
  it("highlighted=true 时固定返回放大半径,不受点数影响", () => {
    const highlighted = [1, 5, 10, 29, 30, 200].map((n) =>
      equityCurveMarkerRadius(n, true),
    );
    expect(new Set(highlighted).size).toBe(1); // 全部相等
    expect(highlighted[0]).toBeGreaterThan(3); // 明确比任何非 highlighted 半径更大
  });

  it("非 highlighted:点数 <= 10(稀疏)返回同一个「明显」半径", () => {
    const r1 = equityCurveMarkerRadius(1, false);
    const r10 = equityCurveMarkerRadius(10, false);
    expect(r1).toBe(r10);
  });

  it("非 highlighted:点数 >= 30(密集)收到下限,不会继续缩小", () => {
    const r30 = equityCurveMarkerRadius(30, false);
    const r100 = equityCurveMarkerRadius(100, false);
    expect(r30).toBe(r100);
    expect(r30).toBeGreaterThan(0); // 下限不是 0——再密也留一点可见度,不能彻底消失
  });

  it("非 highlighted:10~30 点之间,点数越多半径单调不增(不会出现「点更多反而更大」的反直觉结果)", () => {
    const counts = [10, 12, 15, 18, 20, 22, 25, 28, 30];
    const radii = counts.map((n) => equityCurveMarkerRadius(n, false));
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeLessThanOrEqual(radii[i - 1]);
    }
  });

  it("非 highlighted:20(阈值区间中点)恰好是稀疏半径与下限的算术平均——验证线性插值而非跳变", () => {
    const sparse = equityCurveMarkerRadius(10, false);
    const min = equityCurveMarkerRadius(30, false);
    const mid = equityCurveMarkerRadius(20, false);
    expect(mid).toBeCloseTo((sparse + min) / 2, 5);
  });

  it("非 highlighted 的半径在任意点数下都不超过稀疏半径、不低于下限(全区间边界检查)", () => {
    const sparse = equityCurveMarkerRadius(1, false);
    const min = equityCurveMarkerRadius(30, false);
    for (const n of [0, 1, 5, 10, 11, 15, 19, 20, 21, 25, 29, 30, 31, 500]) {
      const r = equityCurveMarkerRadius(n, false);
      expect(r).toBeLessThanOrEqual(sparse);
      expect(r).toBeGreaterThanOrEqual(min);
    }
  });

  it("highlighted 半径无条件大于该点数下的非 highlighted 半径(hover 必须让点变得更明显,不能反而更弱)", () => {
    for (const n of [1, 10, 20, 30, 100]) {
      expect(equityCurveMarkerRadius(n, true)).toBeGreaterThan(
        equityCurveMarkerRadius(n, false),
      );
    }
  });
});
