import { describe, expect, it } from "vitest";
import { reconcileCardView } from "./reconcileView";

// 🩺 健康度里「结算对账」卡的纯展示逻辑(与渲染分开,才测得动 —— walkforwardView
// 同一纪律)。读数语义见 lib/adminOverview.ts ops.settlementReconcile。
describe("reconcileCardView", () => {
  it("两项都是 0 → up,不高亮,说明句讲清读数应恒为 0", () => {
    const v = reconcileCardView({ stray: 0, tsMismatch7d: 0 });
    expect(v.tone).toBe("up");
    expect(v.hot).toBe(false);
    expect(v.sub).toContain("应恒为 0");
  });

  it("漏网 >0 → down + 高亮,说明句指向 [follow] 日志里的「对账补齐 / 对账写入失败」", () => {
    const v = reconcileCardView({ stray: 2, tsMismatch7d: 0 });
    expect(v.tone).toBe("down");
    expect(v.hot).toBe(true);
    expect(v.sub).toContain("回填路径可能在坏");
    expect(v.sub).toContain("[follow]");
    expect(v.sub).toContain("对账补齐");
    expect(v.sub).toContain("对账写入失败");
  });

  it("漏网 0 但近 7d 时间戳偏差 >0 → warn(次级异常),说明句带上行数", () => {
    const v = reconcileCardView({ stray: 0, tsMismatch7d: 1 });
    expect(v.tone).toBe("warn");
    expect(v.hot).toBe(true);
    expect(v.sub).toContain("1 行");
  });
});
