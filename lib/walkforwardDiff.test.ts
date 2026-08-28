import { describe, it, expect } from "vitest";
import type {
  WalkforwardReport,
  WfTierReport,
  WfVariantReport,
} from "./walkforward";
import {
  diffWalkforwardReports,
  wfDueInfo,
  WF_DUE_DAYS,
} from "./walkforwardDiff";

// 重推日历化(第一梯队五件套):两次报告之间「哪些结论翻案」+ 距下次例行的
// due 口径。翻案 = 结构性结论变化(存活集合/观察名单/薄档判定),point 漂移
// 只作上下文 —— 每次重跑 point 都会动一点,把它算翻案等于天天狼来了。

function variant(key: string, label?: string): WfVariantReport {
  return {
    key,
    label: label ?? key,
    dim: "entry",
    category: "all",
    exitRule: "hold",
    folds: [],
    pooled: { n: 10, markets: 8, point: 0.05, seC: 0.01 },
    loBonf: 0.01,
    randP: 0.001,
    passClustered: true,
    passRand: true,
    survives: true,
  };
}

function tier(over: Partial<WfTierReport> = {}): WfTierReport {
  return {
    strategyId: 1,
    name: "巨鲸",
    code: "T1",
    source: "heavy",
    settledRaw: 100,
    universeN: 90,
    universeDropped: { noFormation: 0, noFee: 10, badShares: 0 },
    thin: false,
    currentStat: { n: 90, nc: 40, point: 0.02, seC: 0.01, seNaive: 0.005 },
    baseline: null,
    candidates: [],
    survivors: [],
    watchlist: [],
    trainRejected: 0,
    insufficient: 0,
    ...over,
  };
}

function report(tiers: WfTierReport[]): WalkforwardReport {
  return {
    gateStart: 0,
    folds: [1000],
    gridTotal: 10,
    scoredCells: 5,
    zBonf: 3,
    alpha: 0.05,
    randDraws: 10_000,
    seed: 1,
    tiers,
    declarations: [],
  };
}

describe("wfDueInfo — 月度例行口径", () => {
  it("从未跑过 → 立即 due(没有报告连基线都没有)", () => {
    const d = wfDueInfo(null, 1_000_000);
    expect(d.hasRun).toBe(false);
    expect(d.due).toBe(true);
    expect(d.daysLeft).toBeNull();
  });

  it("10 天前跑过 → 还有 20 天,不 due(WF_DUE_DAYS=30,与使用说明的「节律:月度」同源)", () => {
    const now = 100 * 86_400;
    const d = wfDueInfo(now - 10 * 86_400, now);
    expect(WF_DUE_DAYS).toBe(30);
    expect(d.due).toBe(false);
    expect(d.daysSinceLast).toBe(10);
    expect(d.daysLeft).toBe(20);
    expect(d.dueAtSec).toBe(now + 20 * 86_400);
  });

  it("45 天前跑过 → 已到期 15 天(daysLeft 为负,页面据此转 amber)", () => {
    const now = 100 * 86_400;
    const d = wfDueInfo(now - 45 * 86_400, now);
    expect(d.due).toBe(true);
    expect(d.daysLeft).toBe(-15);
  });
});

describe("diffWalkforwardReports — 结构性翻案", () => {
  it("存活集合按变体 key 对齐:新增/移出各自列出(展示用 label)", () => {
    const prev = report([
      tier({
        survivors: ["a|__all__|hold", "b|__all__|hold"],
        candidates: [
          variant("a|__all__|hold", "minFillUsd≥75k"),
          variant("b|__all__|hold", "minFillUsd≥100k"),
        ],
      }),
    ]);
    const curr = report([
      tier({
        survivors: ["b|__all__|hold", "c|__all__|hold"],
        candidates: [
          variant("b|__all__|hold", "minFillUsd≥100k"),
          variant("c|__all__|hold", "maxPrice≤0.8"),
        ],
      }),
    ]);
    const d = diffWalkforwardReports(
      { createdAt: 100, report: prev },
      { createdAt: 200, report: curr },
    );
    expect(d.changed.length).toBe(1);
    expect(d.changed[0].survivorAdded).toEqual(["maxPrice≤0.8"]);
    expect(d.changed[0].survivorRemoved).toEqual(["minFillUsd≥75k"]);
    expect(d.unchangedTiers).toBe(0);
  });

  it("无结构变化的档只计数不进 changed;point 漂移不算翻案", () => {
    const mk = (point: number) =>
      report([
        tier({
          currentStat: { n: 90, nc: 40, point, seC: 0.01, seNaive: 0.005 },
          survivors: ["a|__all__|hold"],
          candidates: [variant("a|__all__|hold")],
        }),
      ]);
    const d = diffWalkforwardReports(
      { createdAt: 100, report: mk(0.02) },
      { createdAt: 200, report: mk(0.03) },
    );
    expect(d.changed).toEqual([]);
    expect(d.unchangedTiers).toBe(1);
  });

  it("薄档判定翻转是翻案;pointDelta 作为上下文带出", () => {
    const prev = report([tier({ thin: true, currentStat: null })]);
    const curr = report([
      tier({
        thin: false,
        currentStat: { n: 90, nc: 40, point: 0.02, seC: 0.01, seNaive: 0.005 },
      }),
    ]);
    const d = diffWalkforwardReports(
      { createdAt: 100, report: prev },
      { createdAt: 200, report: curr },
    );
    expect(d.changed[0].thinFlipped).toBe("nowThick");
    expect(d.changed[0].pointDelta).toBeNull(); // prev 无 currentStat → 差值不可算
  });

  it("观察名单增删是翻案;只在一侧出现的档单独点名", () => {
    const prev = report([
      tier({ strategyId: 1, watchlist: [] }),
      tier({ strategyId: 2, name: "老档" }),
    ]);
    const curr = report([
      tier({
        strategyId: 1,
        watchlist: [{ key: "w|__all__|hold", label: "w 变体", validFolds: 1 }],
      }),
      tier({ strategyId: 3, name: "新档" }),
    ]);
    const d = diffWalkforwardReports(
      { createdAt: 100, report: prev },
      { createdAt: 200, report: curr },
    );
    expect(d.changed.length).toBe(1);
    expect(d.changed[0].watchAdded).toEqual(["w 变体"]);
    expect(d.tiersOnlyInPrev).toEqual(["老档"]);
    expect(d.tiersOnlyInCurr).toEqual(["新档"]);
  });
});
