import { describe, it, expect } from "vitest";
import { budgetFor, CARD_BUDGET_PER_MIN } from "./cardBudget";

const loop = (ageSec: number | null, staleAfterSec: number) => ({
  ageSec,
  staleAfterSec,
});

describe("budgetFor", () => {
  it("循环全部准时 —— 满额", () => {
    expect(budgetFor({ staleLoops: [], loops: [loop(4, 60)] })).toBe(
      CARD_BUDGET_PER_MIN,
    );
  });

  it("有循环断更 —— 归零,只发降级", () => {
    // 引擎断更时继续取令牌是在加深故障:断更的原因很可能正是 data-api 被挤爆。
    expect(
      budgetFor({ staleLoops: ["consensus"], loops: [loop(900, 600)] }),
    ).toBe(0);
  });

  it("循环开始漂移(超过 staleAfter 的 60%)—— 降到 25%", () => {
    expect(budgetFor({ staleLoops: [], loops: [loop(40, 60)] })).toBe(
      Math.floor(CARD_BUDGET_PER_MIN * 0.25),
    );
  });

  it("取所有循环里最坏的那个,不是平均 —— 一个循环喘不过气就够了", () => {
    expect(
      budgetFor({ staleLoops: [], loops: [loop(4, 60), loop(500, 600)] }),
    ).toBe(Math.floor(CARD_BUDGET_PER_MIN * 0.25));
  });

  it("ageSec 未知的循环不参与判定 —— 没数据不等于在漂移", () => {
    expect(budgetFor({ staleLoops: [], loops: [loop(null, 60)] })).toBe(
      CARD_BUDGET_PER_MIN,
    );
  });

  it("一个循环都没有 —— 满额(健康位另有判据,这里不重复表态)", () => {
    expect(budgetFor({ staleLoops: [], loops: [] })).toBe(CARD_BUDGET_PER_MIN);
  });
});
