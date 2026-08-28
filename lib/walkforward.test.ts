import { describe, expect, it } from "vitest";
import { utcWeekStart } from "./followAnalysis";
import { foldOf, listValidateFolds } from "./walkforward";

// walk-forward 阈值重推的纯函数层测试。设计:docs/plans/2026-08-28-walkforward-
// rederivation-design.md;实现级口径:同名无后缀实现计划 §0。
// 合成数据全部确定性构造(种子 PRNG),测试零随机。

const DAY = 86_400;
const WEEK = 7 * DAY;
/** 闸门起点 2026-07-28 00:00 UTC(/api/continuity streak 起点)。 */
const GATE = Date.UTC(2026, 6, 28) / 1000;
/** 闸门所在周的真实 UTC 周一 = 2026-07-27。 */
const MON = utcWeekStart(GATE);

describe("折切分", () => {
  it("⚠️ 设计前提修正:2026-07-28 是 UTC 周二,不是设计文档说的周一", () => {
    // 独立验算:2026-01-01 为周四,+208 天 → 周二。设计 §4.1 的「恰为周一/
    // 4 整折」按错历推的;实现按真实日历走非周一路径(首个干净整周顺延),
    // 这条测试钉住修正本身 —— 若有人按设计原文把折锚回 07-28,这里会红。
    expect(MON).toBe(GATE - DAY);
  });

  it("validate 折 = 首个干净整周(顺延到 08-03)之后的完整周;跑的当天所在不完整周不进", () => {
    // 2026-08-28(周五)运行:完整周到 08-24 00:00 → 08-10 与 08-17 两折。
    const now = Date.UTC(2026, 7, 28, 12) / 1000;
    expect(listValidateFolds(GATE, now)).toEqual([
      MON + 2 * WEEK, // 08-10
      MON + 3 * WEEK, // 08-17
    ]);
  });

  it("now 恰为周一 00:00 → 刚结束的那周计入完整周", () => {
    const now = MON + 5 * WEEK; // 2026-08-31 00:00,08-24 周恰好完整
    const folds = listValidateFolds(GATE, now);
    expect(folds).toEqual([MON + 2 * WEEK, MON + 3 * WEEK, MON + 4 * WEEK]);
  });

  it("窗口不足 → 无 validate 折", () => {
    const now = MON + 2 * WEEK + 3 * DAY; // 首个 validate 周还在进行中
    expect(listValidateFolds(GATE, now)).toEqual([]);
  });

  it("闸门起点恰为周一时,它所在周直接当首个干净周(不白丢一周)", () => {
    const monGate = MON + 10 * WEEK;
    const now = monGate + 3 * WEEK;
    expect(listValidateFolds(monGate, now)).toEqual([
      monGate + WEEK,
      monGate + 2 * WEEK,
    ]);
  });

  it("foldOf 按 formation_ts 归折:首干净周与窗外都是 null(只进 train)", () => {
    const folds = [MON + 2 * WEEK, MON + 3 * WEEK];
    expect(foldOf(MON + WEEK + 2 * DAY, folds)).toBeNull(); // 首干净周 → train
    expect(foldOf(GATE - 30 * DAY, folds)).toBeNull(); // 闸门前旧数据
    expect(foldOf(MON + 2 * WEEK, folds)).toBe(MON + 2 * WEEK); // 周一 00:00 归本周
    expect(foldOf(MON + 2 * WEEK - 1, folds)).toBeNull(); // 前一秒还在上周
    expect(foldOf(MON + 3 * WEEK + 6 * DAY, folds)).toBe(MON + 3 * WEEK);
    expect(foldOf(MON + 4 * WEEK, folds)).toBeNull(); // 最后一折之后
  });
});
