import { describe, it, expect } from "vitest";
import {
  classifyCardState,
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
