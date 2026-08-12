import { describe, it, expect } from "vitest";
import {
  classifyCardState,
  computeTimeTicks,
  estimateAxisLabelWidth,
  formatAxisUsd,
  sparklinePath,
  sparklineAreaPath,
  LOW_SAMPLE_THRESHOLD,
} from "./followCardView";

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

describe("sparklinePath — 各自缩放的阶梯路径", () => {
  const W = 240;
  const H = 52;

  it("空曲线 → 空字符串(调用方据此不渲染 svg)", () => {
    expect(sparklinePath([], W, H)).toBe("");
  });

  it("单点 → 一条水平线(不能除零)", () => {
    const d = sparklinePath([{ ts: 100, cum: 50 }], W, H);
    expect(d).toContain("M");
    expect(d).not.toContain("NaN");
  });

  it("全部同值(cum 恒定)→ 水平线,不产生 NaN(值域为零的除法防护)", () => {
    const d = sparklinePath(
      [
        { ts: 1, cum: 10 },
        { ts: 2, cum: 10 },
        { ts: 3, cum: 10 },
      ],
      W,
      H,
    );
    expect(d).not.toContain("NaN");
    expect(d).not.toContain("Infinity");
  });

  it("各自缩放:最低点贴底、最高点贴顶(留 padding)", () => {
    const d = sparklinePath(
      [
        { ts: 1, cum: -100 },
        { ts: 2, cum: 100 },
      ],
      W,
      H,
    );
    const ys = [...d.matchAll(/[ML] [\d.]+ ([\d.]+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(Math.min(...ys)).toBeLessThan(H * 0.2);
    expect(Math.max(...ys)).toBeGreaterThan(H * 0.8);
  });

  it("阶梯形状:相邻两点之间先水平后垂直(step-after,与大图同口径)", () => {
    const d = sparklinePath(
      [
        { ts: 0, cum: 0 },
        { ts: 10, cum: 100 },
      ],
      W,
      H,
    );
    expect((d.match(/L/g) ?? []).length).toBe(2);
  });

  it("输入乱序时按 ts 升序重排(不信任入参有序性)", () => {
    const ordered = sparklinePath(
      [
        { ts: 1, cum: 0 },
        { ts: 2, cum: 100 },
      ],
      W,
      H,
    );
    const shuffled = sparklinePath(
      [
        { ts: 2, cum: 100 },
        { ts: 1, cum: 0 },
      ],
      W,
      H,
    );
    expect(shuffled).toBe(ordered);
  });

  it("不修改入参数组", () => {
    const input = [
      { ts: 2, cum: 100 },
      { ts: 1, cum: 0 },
    ];
    const snapshot = JSON.stringify(input);
    sparklinePath(input, W, H);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("sparklineAreaPath — 面积填充路径", () => {
  const W = 240;
  const H = 52;

  it("空输入 → 空字符串", () => {
    expect(sparklineAreaPath("", W, H)).toBe("");
  });

  it("非空输入 → 以 Z 结尾且含底边两点(与 linePath 终点、原点闭合)", () => {
    const line = sparklinePath(
      [
        { ts: 0, cum: 0 },
        { ts: 10, cum: 100 },
      ],
      W,
      H,
    );
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
