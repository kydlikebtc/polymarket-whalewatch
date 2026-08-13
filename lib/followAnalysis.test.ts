import { describe, expect, it } from "vitest";
import {
  analyzeBets,
  BUCKET_LOW_SAMPLE_N,
  WEEKLY_FILL_CAP,
  type AnalysisPosition,
} from "./followAnalysis";

// 造仓工具:默认已结算、$100/仓、entry 50¢、entry_ts=1000、exit=entry+1h。
// 只覆写用例关心的字段,其余保持无害默认。
function pos(over: Partial<AnalysisPosition> = {}): AnalysisPosition {
  return {
    status: "settled",
    entry_price: 0.5,
    size_usd: 100,
    realized_pnl: 0,
    entry_ts: 1000,
    exit_ts: 4600,
    category: null,
    ...over,
  };
}

// 周一 2026-08-10T00:00:00Z(UTC)——手算校验:epoch 天数 20675,
// (20675+3)%7===0(1970-01-01 是周四,偏移 +3 后周一余 0)。
const MON = 1786320000;
const DAY = 86400;
const WEEK = 7 * DAY;

describe("analyzeBets — 空输入与 open 仓隔离", () => {
  it("空输入产出全空形状(不抛错、无 NaN)", () => {
    const a = analyzeBets([]);
    expect(a.quality.settledCount).toBe(0);
    expect(a.quality.winRate).toBeNull();
    expect(a.quality.expectancyUsd).toBeNull();
    expect(a.quality.expectancyT).toBeNull();
    expect(a.quality.profitFactor).toBeNull();
    expect(a.quality.bestPnl).toBeNull();
    expect(a.oddsBuckets).toHaveLength(5);
    for (const b of a.oddsBuckets) {
      expect(b.n).toBe(0);
      expect(b.winRate).toBeNull();
      expect(b.edge).toBeNull();
    }
    expect(a.weekly).toEqual([]);
    expect(a.halves).toBeNull();
    expect(a.streaks).toEqual({
      maxWinStreak: 0,
      maxLossStreak: 0,
      current: 0,
    });
    expect(a.concentration.top3WinsShare).toBeNull();
    expect(a.concentration.netWithoutTop3Wins).toBeNull();
    expect(a.concentration.top3LossesShare).toBeNull();
    expect(a.durationBuckets).toHaveLength(5);
    expect(a.categories).toEqual([]);
    expect(a.openCount).toBe(0);
  });

  it("open 仓只进 openCount,不进任何已结算指标", () => {
    const a = analyzeBets([
      pos({ status: "open", realized_pnl: null, exit_ts: null }),
      pos({ realized_pnl: 30 }),
    ]);
    expect(a.openCount).toBe(1);
    expect(a.quality.settledCount).toBe(1);
    expect(a.quality.wins).toBe(1);
    // odds 桶同样只数 settled(0.5 落第三桶)。
    expect(a.oddsBuckets[2].n).toBe(1);
    expect(a.oddsBuckets.reduce((s, b) => s + b.n, 0)).toBe(1);
  });

  it("不修改入参数组(顺序保留)", () => {
    const rows = [
      pos({ exit_ts: 9000, realized_pnl: 5 }),
      pos({ exit_ts: 5000, realized_pnl: -5 }),
    ];
    const before = [...rows];
    analyzeBets(rows);
    expect(rows).toEqual(before);
  });
});

describe("analyzeBets — 下注质量体检", () => {
  it("胜负/胜率/期望/利润因子/盈亏比/极值(push 不进胜率分母)", () => {
    const a = analyzeBets([
      pos({ realized_pnl: 30, exit_ts: 2000 }),
      pos({ realized_pnl: -50, exit_ts: 3000 }),
      pos({ realized_pnl: 30, exit_ts: 4000 }),
      pos({ realized_pnl: 0, exit_ts: 5000 }), // push
    ]);
    const q = a.quality;
    expect(q.settledCount).toBe(4);
    expect(q.wins).toBe(2);
    expect(q.losses).toBe(1);
    expect(q.pushes).toBe(1);
    expect(q.winRate).toBeCloseTo(2 / 3, 10);
    // Wilson 区间与 outcomeStats 同源:只断言区间夹住点估计。
    expect(q.winRateCI.lo).toBeLessThan(2 / 3);
    expect(q.winRateCI.hi).toBeGreaterThan(2 / 3);
    // 期望按全部 settled(含 push)算 —— push 是真实发生的下注结果。
    expect(q.expectancyUsd).toBeCloseTo((30 - 50 + 30 + 0) / 4, 10);
    expect(q.grossProfit).toBe(60);
    expect(q.grossLoss).toBe(50);
    expect(q.profitFactor).toBeCloseTo(1.2, 10);
    expect(q.avgWinUsd).toBeCloseTo(30, 10);
    expect(q.avgLossUsd).toBeCloseTo(50, 10);
    expect(q.payoffRatio).toBeCloseTo(0.6, 10);
    expect(q.bestPnl).toBe(30);
    expect(q.worstPnl).toBe(-50);
  });

  it("期望 t 值:手算样本 [10,20,30] → 20/(10/√3)", () => {
    const a = analyzeBets([
      pos({ realized_pnl: 10, exit_ts: 2000 }),
      pos({ realized_pnl: 20, exit_ts: 3000 }),
      pos({ realized_pnl: 30, exit_ts: 4000 }),
    ]);
    expect(a.quality.expectancyT).toBeCloseTo(20 / (10 / Math.sqrt(3)), 10);
  });

  it("t 值退化:n<2 → null;全部等值(sd=0)→ null", () => {
    expect(analyzeBets([pos({ realized_pnl: 10 })]).quality.expectancyT).toBe(
      null,
    );
    const same = analyzeBets([
      pos({ realized_pnl: 10, exit_ts: 2000 }),
      pos({ realized_pnl: 10, exit_ts: 3000 }),
    ]);
    expect(same.quality.expectancyT).toBeNull();
  });

  it("无亏损仓:profitFactor/avgLossUsd/payoffRatio 为 null(不是 Infinity)", () => {
    const q = analyzeBets([pos({ realized_pnl: 10 })]).quality;
    expect(q.profitFactor).toBeNull();
    expect(q.avgLossUsd).toBeNull();
    expect(q.payoffRatio).toBeNull();
  });
});

describe("analyzeBets — 赔率带校准", () => {
  it("桶边界:0.2 恰落第二桶、1.0 落末桶;每桶 avgEntry/edge/realized", () => {
    const a = analyzeBets([
      pos({ entry_price: 0.1, realized_pnl: 10, exit_ts: 2000 }),
      pos({ entry_price: 0.2, realized_pnl: 10, exit_ts: 3000 }),
      pos({ entry_price: 0.39, realized_pnl: -20, exit_ts: 4000 }),
      pos({ entry_price: 0.5, realized_pnl: 10, exit_ts: 5000 }),
      pos({ entry_price: 0.8, realized_pnl: 10, exit_ts: 6000 }),
      pos({ entry_price: 1.0, realized_pnl: -30, exit_ts: 7000 }),
    ]);
    const [b0, b1, b2, b3, b4] = a.oddsBuckets;
    expect(b0.n).toBe(1);
    expect(b1.n).toBe(2);
    expect(b2.n).toBe(1);
    expect(b3.n).toBe(0);
    expect(b4.n).toBe(2);
    // 第二桶:入场 0.2/0.39,1 胜 1 负 → 实际 0.5,隐含 0.295,edge 0.205。
    expect(b1.avgEntry).toBeCloseTo(0.295, 10);
    expect(b1.winRate).toBeCloseTo(0.5, 10);
    expect(b1.edge).toBeCloseTo(0.5 - 0.295, 10);
    expect(b1.realized).toBeCloseTo(-10, 10);
    // 空桶诚实置 null。
    expect(b3.winRate).toBeNull();
    expect(b3.avgEntry).toBeNull();
    expect(b3.edge).toBeNull();
    // 全 push 桶:winRate null → edge null(隐含照算)。
    const p = analyzeBets([pos({ entry_price: 0.5, realized_pnl: 0 })])
      .oddsBuckets[2];
    expect(p.n).toBe(1);
    expect(p.winRate).toBeNull();
    expect(p.edge).toBeNull();
    expect(p.avgEntry).toBeCloseTo(0.5, 10);
  });

  it("小样本弱化阈值常量导出(UI 与测试同源)", () => {
    expect(BUCKET_LOW_SAMPLE_N).toBeGreaterThan(0);
  });
});

describe("analyzeBets — 周度盈亏", () => {
  it("同一 UTC 周合并;缺口周补零;按周升序", () => {
    const a = analyzeBets([
      pos({ exit_ts: MON + DAY, realized_pnl: 10 }), // 周二
      pos({ exit_ts: MON + 3 * DAY, realized_pnl: -4 }), // 周四,同周
      pos({ exit_ts: MON + 2 * WEEK + DAY, realized_pnl: 7 }), // 隔一周
    ]);
    expect(a.weekly).toEqual([
      { weekStartTs: MON, realized: 6, settled: 2 },
      { weekStartTs: MON + WEEK, realized: 0, settled: 0 },
      { weekStartTs: MON + 2 * WEEK, realized: 7, settled: 1 },
    ]);
  });

  it("周界:周日 23:59 与次周一 00:00 分属两周", () => {
    const a = analyzeBets([
      pos({ exit_ts: MON + WEEK - 60, realized_pnl: 1 }),
      pos({ exit_ts: MON + WEEK, realized_pnl: 2, entry_ts: 2000 }),
    ]);
    expect(a.weekly.map((w) => w.weekStartTs)).toEqual([MON, MON + WEEK]);
  });

  it("跨度超过补零上限:不再补零,只列非空周", () => {
    const a = analyzeBets([
      pos({ exit_ts: MON, realized_pnl: 1 }),
      pos({
        exit_ts: MON + (WEEKLY_FILL_CAP + 5) * WEEK,
        realized_pnl: 2,
        entry_ts: 2000,
      }),
    ]);
    expect(a.weekly).toHaveLength(2);
    expect(a.weekly[0].weekStartTs).toBe(MON);
  });
});

describe("analyzeBets — 前半 vs 后半", () => {
  it("n<6 → null", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      pos({ exit_ts: 2000 + i, realized_pnl: 1 }),
    );
    expect(analyzeBets(rows).halves).toBeNull();
  });

  it("按结算时间排序对半分(mid=floor(n/2)),各算 n/胜率/落袋", () => {
    // 时间乱序入参,验证内部按 exit_ts 排序:前半 w,w,w 后半 l,l,l。
    const rows = [
      pos({ exit_ts: 6000, realized_pnl: -10 }),
      pos({ exit_ts: 1000, realized_pnl: 10 }),
      pos({ exit_ts: 5000, realized_pnl: -10 }),
      pos({ exit_ts: 2000, realized_pnl: 10 }),
      pos({ exit_ts: 4000, realized_pnl: -10 }),
      pos({ exit_ts: 3000, realized_pnl: 10 }),
    ];
    const h = analyzeBets(rows).halves!;
    expect(h.earlier).toEqual({ n: 3, winRate: 1, realized: 30 });
    expect(h.later).toEqual({ n: 3, winRate: 0, realized: -30 });
  });
});

describe("analyzeBets — 连胜连败与集中度", () => {
  it("push 跳过不打断 streak;current 带符号", () => {
    const a = analyzeBets([
      pos({ exit_ts: 1000, realized_pnl: 5 }),
      pos({ exit_ts: 2000, realized_pnl: 5 }),
      pos({ exit_ts: 3000, realized_pnl: 0 }), // push,不打断
      pos({ exit_ts: 4000, realized_pnl: 5 }),
      pos({ exit_ts: 5000, realized_pnl: -5 }),
      pos({ exit_ts: 6000, realized_pnl: -5 }),
    ]);
    expect(a.streaks.maxWinStreak).toBe(3);
    expect(a.streaks.maxLossStreak).toBe(2);
    expect(a.streaks.current).toBe(-2);
  });

  it("Top3 盈利占比/去掉 Top3 后净额/Top3 亏损占比", () => {
    const a = analyzeBets([
      pos({ exit_ts: 1000, realized_pnl: 100 }),
      pos({ exit_ts: 2000, realized_pnl: 50 }),
      pos({ exit_ts: 3000, realized_pnl: 30 }),
      pos({ exit_ts: 4000, realized_pnl: 10 }),
      pos({ exit_ts: 5000, realized_pnl: -20 }),
    ]);
    const c = a.concentration;
    expect(c.top3WinsShare).toBeCloseTo(180 / 190, 10);
    // 总净额 170 − Top3 盈利 180 = −10:去掉三笔大的就转亏,稳健性一眼可见。
    expect(c.netWithoutTop3Wins).toBeCloseTo(-10, 10);
    expect(c.top3LossesShare).toBeCloseTo(1, 10);
  });

  it("无盈利仓/无亏损仓时对应占比为 null", () => {
    const onlyLoss = analyzeBets([pos({ realized_pnl: -5 })]).concentration;
    expect(onlyLoss.top3WinsShare).toBeNull();
    expect(onlyLoss.netWithoutTop3Wins).toBeNull();
    expect(onlyLoss.top3LossesShare).toBeCloseTo(1, 10);
    const onlyWin = analyzeBets([pos({ realized_pnl: 5 })]).concentration;
    expect(onlyWin.top3LossesShare).toBeNull();
  });
});

describe("analyzeBets — 持有时长分布", () => {
  it("五档边界:1h/12h/2d/5d/10d 各落其位", () => {
    const mk = (holdSec: number, pnl: number) =>
      pos({ entry_ts: 1000, exit_ts: 1000 + holdSec, realized_pnl: pnl });
    const a = analyzeBets([
      mk(3600, 10),
      mk(12 * 3600, -10),
      mk(2 * DAY, 10),
      mk(5 * DAY, 10),
      mk(10 * DAY, -10),
    ]);
    expect(a.durationBuckets.map((b) => b.n)).toEqual([1, 1, 1, 1, 1]);
    expect(a.durationBuckets[0].winRate).toBe(1);
    expect(a.durationBuckets[1].winRate).toBe(0);
    expect(a.durationBuckets[4].realized).toBe(-10);
  });

  it("边界值归属:恰 6h 落第二桶、恰 24h 落第三桶(下闭上开)", () => {
    const mk = (holdSec: number) =>
      pos({ entry_ts: 0, exit_ts: holdSec, realized_pnl: 1 });
    const a = analyzeBets([mk(6 * 3600), mk(24 * 3600)]);
    expect(a.durationBuckets.map((b) => b.n)).toEqual([0, 1, 1, 0, 0]);
  });
});

describe("analyzeBets — 赛道细分", () => {
  it("按 category 汇总(null→未分类);n 降序、同 n 按落袋降序", () => {
    const a = analyzeBets([
      pos({ category: "Sports", realized_pnl: 10, entry_price: 0.4 }),
      pos({ category: "Sports", realized_pnl: -5, entry_price: 0.6 }),
      pos({ category: "Crypto", realized_pnl: 20 }),
      pos({ category: null, realized_pnl: 3 }),
    ]);
    expect(a.categories.map((c) => c.category)).toEqual([
      "Sports",
      "Crypto",
      "未分类",
    ]);
    const sports = a.categories[0];
    expect(sports.n).toBe(2);
    expect(sports.wins).toBe(1);
    expect(sports.losses).toBe(1);
    expect(sports.winRate).toBeCloseTo(0.5, 10);
    expect(sports.avgEntry).toBeCloseTo(0.5, 10);
    expect(sports.realized).toBeCloseTo(5, 10);
  });
});
