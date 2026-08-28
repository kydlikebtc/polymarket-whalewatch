import { describe, expect, it } from "vitest";
import type { WfTierReport } from "../../lib/walkforward";
import { reportMeta, runStateLine, tierLine } from "./walkforwardView";

function tier(over: Partial<WfTierReport>): WfTierReport {
  return {
    strategyId: 1,
    name: "巨鲸",
    code: "whale_follow",
    source: "heavy",
    settledRaw: 163,
    universeN: 150,
    universeDropped: { noFormation: 3, noFee: 10, badShares: 0 },
    thin: false,
    currentStat: { n: 150, nc: 120, point: 0.01, seC: 0.02, seNaive: 0.01 },
    baseline: null,
    candidates: [],
    survivors: [],
    watchlist: [],
    trainRejected: 0,
    insufficient: 0,
    ...over,
  };
}

describe("阈值重推卡文案", () => {
  it("薄档:只报现状 ± 聚类 CI", () => {
    const line = tierLine(tier({ thin: true }));
    expect(line).toContain("🪶");
    expect(line).toContain("薄档");
    expect(line).toContain("+1.00 ± 3.92 点/仓");
    expect(line).toContain("市场 120");
  });

  it("无存活:一等结论带候选数与基线 OOS", () => {
    const line = tierLine(
      tier({
        candidates: [
          {
            key: "k",
            label: "x",
            dim: "d",
            category: "all",
            exitRule: "hold",
            folds: [],
            pooled: { n: 20, markets: 20, point: -0.1, seC: 0.1 },
            loBonf: -0.4,
            randP: 0.5,
            passClustered: false,
            passRand: false,
            survives: false,
          },
        ],
        baseline: {
          key: "base|all|hold",
          label: "当前参数",
          dim: "base",
          category: "all",
          exitRule: "hold",
          folds: [],
          pooled: { n: 48, markets: 48, point: -0.005, seC: 0.03 },
          loBonf: null,
          randP: null,
          passClustered: false,
          passRand: false,
          survives: false,
        },
      }),
    );
    expect(line).toContain("⭕");
    expect(line).toContain("无变体存活");
    expect(line).toContain("候选 1");
    expect(line).toContain("−0.50 点");
  });

  it("存活:按 Bonferroni 下界挑最强,带 OOS/下界/p", () => {
    const survivor = (label: string, lo: number) => ({
      key: label,
      label,
      dim: "minSingleFillUsd",
      category: "all" as const,
      exitRule: "hold",
      folds: [],
      pooled: { n: 24, markets: 24, point: 0.5, seC: 0 },
      loBonf: lo,
      randP: 0.0001,
      passClustered: true,
      passRand: true,
      survives: true,
    });
    const line = tierLine(
      tier({ candidates: [survivor("弱的", 0.1), survivor("强的", 0.3)] }),
    );
    expect(line).toContain("🏁");
    expect(line).toContain("存活 2");
    expect(line).toContain("最强:强的");
    expect(line).toContain("+30.00");
    expect(line).toContain("p=0.0001");
  });

  it("卡头:跑于/折/网格/G/z/种子齐活", () => {
    const meta = reportMeta({
      createdAt: Date.UTC(2026, 7, 28, 10, 30) / 1000,
      report: {
        gateStart: 0,
        folds: [Date.UTC(2026, 7, 10) / 1000, Date.UTC(2026, 7, 17) / 1000],
        gridTotal: 390,
        scoredCells: 42,
        zBonf: 3.24,
        alpha: 0.05,
        randDraws: 10_000,
        seed: 20_260_828,
        tiers: [],
        declarations: [],
      },
    });
    expect(meta).toContain("2026-08-28 10:30");
    expect(meta).toContain("2026-08-10/2026-08-17");
    expect(meta).toContain("390 格");
    expect(meta).toContain("G=42");
    expect(meta).toContain("z=3.24");
    expect(meta).toContain("10,000");
  });
});

describe("运行状态一行", () => {
  it("跑中:显示已耗秒数", () => {
    const line = runStateLine(
      { running: true, startedAt: 1_000, lastRun: null },
      1_042,
    );
    expect(line).toContain("⏳");
    expect(line).toContain("42s");
  });

  it("上次成功:时刻 + 耗时", () => {
    const line = runStateLine(
      {
        running: false,
        startedAt: null,
        lastRun: {
          startedAt: Date.UTC(2026, 7, 28, 10, 0) / 1000,
          finishedAt: Date.UTC(2026, 7, 28, 10, 0, 37) / 1000,
          ok: true,
          exitCode: 0,
          tail: "",
        },
      },
      0,
    );
    expect(line).toContain("✅");
    expect(line).toContain("2026-08-28 10:00");
    expect(line).toContain("37s");
  });

  it("上次失败:❌ + exit 码(tail 由卡另行展示)", () => {
    const line = runStateLine(
      {
        running: false,
        startedAt: null,
        lastRun: {
          startedAt: 1,
          finishedAt: 2,
          ok: false,
          exitCode: 1,
          tail: "boom",
        },
      },
      0,
    );
    expect(line).toContain("❌");
    expect(line).toContain("exit 1");
  });

  it("本进程还没跑过 → null(卡不渲染这一行)", () => {
    expect(
      runStateLine({ running: false, startedAt: null, lastRun: null }, 0),
    ).toBeNull();
  });
});
