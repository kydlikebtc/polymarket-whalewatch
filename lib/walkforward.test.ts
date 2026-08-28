import { describe, expect, it } from "vitest";
import type { StrategyParams } from "./followCandidate";
import { utcWeekStart } from "./followAnalysis";
import {
  buildEntryVariants,
  buildGrid,
  categoryMatches,
  clusterStat,
  contribOf,
  entryMatches,
  foldOf,
  listValidateFolds,
  mulberry32,
  normalQuantile,
  randomizationP,
  runWalkforward,
  subsetOf,
} from "./walkforward";

/** 造一份最小 StrategyParams(通用字段全给默认,专属字段按测试覆写)。 */
function params(over: Partial<StrategyParams>): StrategyParams {
  return {
    id: 1,
    source: "consensus",
    sizeUsd: 1000,
    exitRule: "settlement",
    maxEntryDeviationCents: 10,
    maxPrice: 0.95,
    freshSec: 900,
    ...over,
  };
}

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

describe("网格生成", () => {
  it("heavy 三维阶梯:基线+2+2+2=7 入场变体,×3 赛道 ×10 退出 = 210 格", () => {
    const p = params({
      source: "heavy",
      minSingleFillUsd: 50_000,
      maxPrice: 0.95,
      maxEntryDeviationCents: 10,
    });
    const entries = buildEntryVariants(p);
    expect(entries).toHaveLength(7);
    expect(entries.filter((e) => e.dim === "base")).toHaveLength(1);
    expect(entries.filter((e) => e.dim === "minSingleFillUsd")).toHaveLength(2);
    expect(entries.filter((e) => e.dim === "maxPrice")).toHaveLength(2);
    expect(
      entries.filter((e) => e.dim === "maxEntryDeviationCents"),
    ).toHaveLength(2);
    const cells = buildGrid(p);
    expect(cells).toHaveLength(7 * 3 * 10);
    // key 全网格唯一(报告/管理页按 key 认格)。
    expect(new Set(cells.map((c) => c.key)).size).toBe(cells.length);
    // 恰好一个纯基线格(当前参数×全赛道×hold)。
    expect(
      cells.filter(
        (c) =>
          c.entry.dim === "base" &&
          c.category === "all" &&
          c.exitRule === "hold",
      ),
    ).toHaveLength(1);
  });

  it("阶梯 ∩ 严格紧于当前:maxPrice 已 0.90 → 只剩 0.85", () => {
    const p = params({
      source: "heavy",
      minSingleFillUsd: 50_000,
      maxPrice: 0.9,
    });
    const mp = buildEntryVariants(p).filter((e) => e.dim === "maxPrice");
    expect(mp).toHaveLength(1);
    expect(mp[0].spec).toEqual({ kind: "maxPrice", max: 0.85 });
  });

  it("维度参数缺失不猜默认:heavy 没配 minSingleFillUsd → 该维为空", () => {
    const p = params({ source: "heavy" });
    expect(
      buildEntryVariants(p).filter((e) => e.dim === "minSingleFillUsd"),
    ).toHaveLength(0);
  });

  it("consensus:minWallets+1 / 均值口径 perWallet ×1.5 ×2 / freshSec 已最紧则为空", () => {
    const p = params({
      source: "consensus",
      minWallets: 2,
      minPerWalletUsd: 10_000,
      freshSec: 300,
    });
    const entries = buildEntryVariants(p);
    expect(entries.filter((e) => e.dim === "freshSec")).toHaveLength(0);
    const w = entries.filter((e) => e.dim === "minWallets");
    expect(w).toHaveLength(1);
    expect(w[0].spec).toEqual({ kind: "minWallets", min: 3 });
    const pw = entries.filter((e) => e.dim === "minPerWalletUsd");
    expect(pw.map((e) => e.spec)).toEqual([
      { kind: "minAvgPerWalletUsd", min: 15_000 },
      { kind: "minAvgPerWalletUsd", min: 20_000 },
    ]);
  });

  it("lopsided:minTiltPct+0.1,越界(≥1)则维为空", () => {
    const ok = params({ source: "lopsided", minTiltPct: 0.7 });
    const tilt = buildEntryVariants(ok).filter((e) => e.dim === "minTiltPct");
    expect(tilt).toHaveLength(1);
    expect(tilt[0].spec).toEqual({ kind: "minTiltPct", min: 0.8 });
    const capped = params({ source: "resolved", minTiltPct: 0.95 });
    expect(
      buildEntryVariants(capped).filter((e) => e.dim === "minTiltPct"),
    ).toHaveLength(0);
  });

  it("钱包族:minNetUsd ×1.5/×2 顶替不可回放的 score 维度 —— 网格里不存在任何 score 维", () => {
    const p = params({
      source: "lone_wolf",
      minNetUsd: 20_000,
      minWalletScore: 60,
    });
    const entries = buildEntryVariants(p);
    expect(entries.map((e) => e.dim).sort()).toEqual([
      "base",
      "minNetUsd",
      "minNetUsd",
    ]);
    expect(entries.some((e) => e.dim.toLowerCase().includes("score"))).toBe(
      false,
    );
  });
});

/** 造一笔最小 WfPosition(事实齐全的仓;缺事实场景按测试覆写成 null)。 */
function pos(over: Partial<import("./walkforward").WfPosition> = {}) {
  return {
    id: 1,
    conditionId: "0xc1",
    outcome: "Yes",
    formationTs: 1_000,
    entryTs: 1_100,
    entryPrice: 0.5,
    formationPrice: 0.5,
    shares: 100,
    feeUsd: 0,
    realizedPnl: 50,
    category: "Sports" as string | null,
    walletCount: 3 as number | null,
    totalNetUsd: 60_000 as number | null,
    tiltPct: 0.75 as number | null,
    exitSims: null as Record<string, { exited: number; pnl: number }> | null,
    ...over,
  };
}

describe("子集过滤", () => {
  const m = (spec: import("./walkforward").EntrySpec, p: unknown) =>
    entryMatches(spec, p as import("./walkforward").WfPosition);

  it("base 全进", () => {
    expect(m({ kind: "base" }, pos())).toBe(true);
  });

  it("heavy 单笔下限:75k 进 / 74k 出 / 事实缺失 null", () => {
    const spec = { kind: "minFillUsd", min: 75_000 } as const;
    expect(m(spec, pos({ totalNetUsd: 75_000 }))).toBe(true);
    expect(m(spec, pos({ totalNetUsd: 74_999 }))).toBe(false);
    expect(m(spec, pos({ totalNetUsd: null }))).toBeNull();
  });

  it("maxPrice 引擎语义 entry>max 才拦:0.90 恰好进,0.901 出", () => {
    const spec = { kind: "maxPrice", max: 0.9 } as const;
    expect(m(spec, pos({ entryPrice: 0.9 }))).toBe(true);
    expect(m(spec, pos({ entryPrice: 0.901 }))).toBe(false);
  });

  it("形成偏离 ≤6¢:5.9 进 / 6.1 出 / formation 缺失 null", () => {
    const spec = { kind: "maxDevCents", max: 6 } as const;
    expect(m(spec, pos({ entryPrice: 0.559, formationPrice: 0.5 }))).toBe(true);
    expect(m(spec, pos({ entryPrice: 0.561, formationPrice: 0.5 }))).toBe(
      false,
    );
    expect(m(spec, pos({ formationPrice: null }))).toBeNull();
  });

  it("consensus:钱包数 / 均值每钱包 / 新鲜度(601s 出)", () => {
    expect(m({ kind: "minWallets", min: 3 }, pos({ walletCount: 3 }))).toBe(
      true,
    );
    expect(m({ kind: "minWallets", min: 3 }, pos({ walletCount: 2 }))).toBe(
      false,
    );
    expect(m({ kind: "minWallets", min: 3 }, pos({ walletCount: null }))).toBe(
      null,
    );
    const avg = { kind: "minAvgPerWalletUsd", min: 15_000 } as const;
    expect(m(avg, pos({ totalNetUsd: 45_000, walletCount: 3 }))).toBe(true);
    expect(m(avg, pos({ totalNetUsd: 44_000, walletCount: 3 }))).toBe(false);
    expect(m(avg, pos({ walletCount: null }))).toBeNull();
    const fresh = { kind: "maxStalenessSec", max: 600 } as const;
    expect(m(fresh, pos({ entryTs: 1_600, formationTs: 1_000 }))).toBe(true);
    expect(m(fresh, pos({ entryTs: 1_601, formationTs: 1_000 }))).toBe(false);
  });

  it("tilt 下限:0.8 判 0.75 出、0.85 进、快照缺失 null", () => {
    const spec = { kind: "minTiltPct", min: 0.8 } as const;
    expect(m(spec, pos({ tiltPct: 0.85 }))).toBe(true);
    expect(m(spec, pos({ tiltPct: 0.75 }))).toBe(false);
    expect(m(spec, pos({ tiltPct: null }))).toBeNull();
  });

  it("赛道:sports 只留 Sports;nonsports 留非 null 非 Sports;null 两边都缺事实", () => {
    expect(categoryMatches("all", pos({ category: null }))).toBe(true);
    expect(categoryMatches("sports", pos({ category: "Sports" }))).toBe(true);
    expect(categoryMatches("sports", pos({ category: "Politics" }))).toBe(
      false,
    );
    expect(categoryMatches("sports", pos({ category: null }))).toBeNull();
    expect(categoryMatches("nonsports", pos({ category: "Politics" }))).toBe(
      true,
    );
    expect(categoryMatches("nonsports", pos({ category: "Sports" }))).toBe(
      false,
    );
    expect(categoryMatches("nonsports", pos({ category: null }))).toBeNull();
  });

  it("subsetOf:进/出/缺事实三态,缺事实计数;退出≠hold 还要求 sims 在场", () => {
    const sims = { tp10: { exited: 1, pnl: 10 } };
    const positions = [
      pos({ id: 1, totalNetUsd: 80_000, exitSims: sims }), // 进
      pos({ id: 2, totalNetUsd: 10_000, exitSims: sims }), // 阈值出局
      pos({ id: 3, totalNetUsd: null, exitSims: sims }), // 缺事实
      pos({ id: 4, totalNetUsd: 90_000, exitSims: null }), // hold 进,tp10 缺 sims
    ];
    const entry = {
      entryKey: "minFillUsd:75000",
      dim: "minSingleFillUsd",
      label: "",
      spec: { kind: "minFillUsd", min: 75_000 } as const,
    };
    const hold = subsetOf(positions as never, {
      key: "k1",
      entry,
      category: "all",
      exitRule: "hold",
    });
    expect(hold.included.map((p) => p.id)).toEqual([1, 4]);
    expect(hold.droppedMissing).toBe(1);
    const tp = subsetOf(positions as never, {
      key: "k2",
      entry,
      category: "all",
      exitRule: "tp10",
    });
    expect(tp.included.map((p) => p.id)).toEqual([1]);
    expect(tp.droppedMissing).toBe(2);
  });
});

describe("退出合成", () => {
  it("hold:contrib = (realized_pnl − fee)/shares,二元结算下即 won − q − fee", () => {
    // BUY@0.4 结算 1:realized = 100×0.6 = 60;fee $2 → (60−2)/100 = 0.58。
    const p = pos({
      entryPrice: 0.4,
      shares: 100,
      realizedPnl: 60,
      feeUsd: 2,
    });
    expect(contribOf(p, "hold")).toBeCloseTo(0.58, 12);
  });

  it("九规则:sims.pnl 查表(触发与未触发都直接查 —— 落库时未触发已回填实际值)", () => {
    const p = pos({
      entryPrice: 0.4,
      shares: 100,
      realizedPnl: -40,
      feeUsd: 0,
      exitSims: { tp10: { exited: 1, pnl: 10 }, sl10: { exited: 0, pnl: -40 } },
    });
    expect(contribOf(p, "tp10")).toBeCloseTo(0.1, 12); // 10/100
    expect(contribOf(p, "sl10")).toBeCloseTo(-0.4, 12); // 未触发 = 实际
  });

  it("sims 缺席或缺该规则行 → null(调用方剔除,不猜)", () => {
    expect(contribOf(pos({ exitSims: null }), "tp10")).toBeNull();
    expect(
      contribOf(pos({ exitSims: { sl10: { exited: 0, pnl: 0 } } }), "tp10"),
    ).toBeNull();
  });
});

describe("聚类稳健统计(edge-audit 自检性质原样移植)", () => {
  it("每行独立时,聚类 SE ≈ 朴素 SE(仅差 G/(G−1) 小样本校正)", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      contrib: i % 2 === 0 ? 0.5 : -0.5,
      cluster: `m${i}`,
    }));
    const s = clusterStat(rows)!;
    expect(s.n).toBe(200);
    expect(s.nc).toBe(200);
    expect(s.point).toBeCloseTo(0, 12);
    expect(Math.abs(s.seC / s.seNaive - 1)).toBeLessThan(0.02);
  });

  it("同簇 10 份完全同向复制:点估计不变,SE 约为朴素的 √10 倍", () => {
    const rows = Array.from({ length: 20 }, (_, g) =>
      Array.from({ length: 10 }, () => ({
        contrib: g % 2 === 0 ? 0.5 : -0.5,
        cluster: `m${g}`,
      })),
    ).flat();
    const s = clusterStat(rows)!;
    expect(s.point).toBeCloseTo(0, 12);
    expect(s.nc).toBe(20);
    expect(s.seC / s.seNaive).toBeGreaterThan(2.8);
    expect(s.seC / s.seNaive).toBeLessThan(3.5);
  });

  it("同市场对边各自入账:点估计不被挑边带跑,完全对冲簇的 CRVE 方差为 0", () => {
    const rows = [
      { contrib: 0.4, cluster: "m1" },
      { contrib: -0.4, cluster: "m1" },
      { contrib: 0.4, cluster: "m2" },
      { contrib: -0.4, cluster: "m2" },
    ];
    const s = clusterStat(rows)!;
    expect(s.point).toBeCloseTo(0, 12);
    expect(s.seC).toBeCloseTo(0, 12);
  });

  it("空集 → null;normalQuantile 两个关键分位与 edge-audit 同值", () => {
    expect(clusterStat([])).toBeNull();
    expect(Math.abs(normalQuantile(0.975) - 1.95996)).toBeLessThan(5e-4);
    expect(Math.abs(normalQuantile(1 - 0.05 / 120) - 3.3441)).toBeLessThan(
      5e-3,
    );
  });
});

describe("方向随机化", () => {
  const row = (
    over: Partial<{
      conditionId: string;
      outcome: string;
      q: number;
      feePerShare: number;
    }> = {},
  ) => ({
    conditionId: "0xc1",
    outcome: "Yes",
    q: 0.5,
    feePerShare: 0,
    ...over,
  });

  it("mulberry32 同种子 → 序列逐值相等(报告可复现的根)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it("按市场抽签,不逐仓:单市场 10 仓全胜的 p ≈ 0.5(逐仓独立会虚小到 ~0.001)", () => {
    const rows = Array.from({ length: 10 }, () => row());
    // 实测 stat:全胜 → mean(1 − 0.5) = +0.5。
    const p = randomizationP(rows, 0.5, 100, 42);
    expect(p).toBeGreaterThan(0.25);
    expect(p).toBeLessThan(0.75);
  });

  it("同市场对边反相关耦合:每次抽签恰一胜一负,null 统计量恒为 0", () => {
    const rows = [row(), row({ outcome: "No" })];
    // null 恒 0:观测 0 → 全部 null ≥ 0 → p = 1;观测 0.1 → 无 null ≥ → 最小 p。
    expect(randomizationP(rows, 0, 100, 7)).toBe(1);
    expect(randomizationP(rows, 0.1, 100, 7)).toBeCloseTo(1 / 101, 12);
  });

  it("边际正确:q=0.3 单仓,null 里 won 频率 ≈ 0.3(p 即该频率)", () => {
    const p = randomizationP([row({ q: 0.3 })], 0.7, 10_000, 20260828);
    expect(p).toBeGreaterThan(0.28);
    expect(p).toBeLessThan(0.32);
  });

  it("p 公式 (1+k)/(1+N):零命中不报 0", () => {
    // 观测 1.0 严格高于 null 的上确界(1 − q − fee = 0.99)→ 零命中。
    const p = randomizationP([row({ q: 0.01 })], 1.0, 100, 3);
    expect(p).toBeCloseTo(1 / 101, 12);
  });
});

// ---------------------------------------------------------------------------
// 全档评估管线。合成夹具约定:q=0.5、shares=100、fee=0 → 赢仓 contrib=+0.5、
// 输仓 −0.5;一仓一市场(m<id>);exitSims 默认九规则未触发(pnl=实际)——
// 退出格与 hold 同值,让「子集选择」成为唯一的差异来源。
const F1 = MON + 2 * WEEK;
const F2 = MON + 3 * WEEK;
const TRAIN_ERA = MON + WEEK; // 首个干净周,foldOf=null → 只进 train
const OPTS = {
  gateStart: GATE,
  folds: [F1, F2],
  randDraws: 1_000,
  seed: 20_260_828,
  minFoldSettled: 10,
  minFoldMarkets: 5,
  minValidFolds: 2,
  alpha: 0.05,
};
let nextId = 1;
const RULE_IDS = [
  "sl10",
  "sl20",
  "sl30",
  "tp10",
  "tp20",
  "tp30",
  "t24",
  "t72",
  "t168",
];
function tierPos(
  base: number,
  i: number,
  win: boolean,
  over: Partial<import("./walkforward").WfPosition> = {},
) {
  const id = nextId++;
  const pnl = win ? 50 : -50;
  return pos({
    id,
    conditionId: `m${id}`,
    formationTs: base + i * 600,
    entryTs: base + i * 600 + 60,
    entryPrice: 0.5,
    formationPrice: 0.5,
    shares: 100,
    feeUsd: 0,
    realizedPnl: pnl,
    category: "Sports",
    walletCount: 2,
    tiltPct: null,
    exitSims: Object.fromEntries(
      RULE_IDS.map((r) => [r, { exited: 0, pnl }]),
    ),
    ...over,
  });
}
function tierInput(
  name: string,
  p: StrategyParams,
  positions: unknown[],
): import("./walkforward").WfTierInput {
  return {
    strategyId: p.id,
    name,
    code: null,
    params: p,
    positions: positions as import("./walkforward").WfPosition[],
    settledRaw: positions.length,
    universeDropped: { noFormation: 0, noFee: 0, badShares: 0 },
  };
}

/** 旗舰 heavy 档:大单($120k)全赢、小单($60k)全输,三个时代各 12+12。 */
function mkHeavyTier() {
  const positions: unknown[] = [];
  for (const era of [TRAIN_ERA, F1, F2]) {
    for (let i = 0; i < 12; i++) {
      positions.push(tierPos(era, i, true, { totalNetUsd: 120_000 }));
    }
    for (let i = 12; i < 24; i++) {
      positions.push(tierPos(era, i, false, { totalNetUsd: 60_000 }));
    }
  }
  return tierInput(
    "巨鲸",
    params({ id: 9, source: "heavy", minSingleFillUsd: 50_000 }),
    positions,
  );
}

/** 薄档:F2 12 仓但仅 4 市场(市场闸打掉)→ 基线可评折 1 < 2。 */
function mkThinTier() {
  const positions: unknown[] = [];
  for (let i = 0; i < 24; i++) {
    positions.push(tierPos(TRAIN_ERA, i, i % 2 === 0));
  }
  for (let i = 0; i < 24; i++) {
    positions.push(tierPos(F1, i, i % 2 === 0));
  }
  for (let i = 0; i < 12; i++) {
    positions.push(
      tierPos(F2, i, i % 2 === 0, { conditionId: `thin${i % 4}` }),
    );
  }
  return tierInput(
    "首发共识",
    params({ id: 7, source: "consensus", minWallets: 2, minPerWalletUsd: 5_000 }),
    positions,
  );
}

describe("walk-forward 评估管线", () => {
  const report = runWalkforward([mkHeavyTier(), mkThinTier()], OPTS);
  const heavy = report.tiers.find((t) => t.name === "巨鲸")!;
  const thin = report.tiers.find((t) => t.name === "首发共识")!;

  it("薄档:基线可评折<2 → 跳网格只报现状;折明细带市场闸原因", () => {
    expect(thin.thin).toBe(true);
    expect(thin.candidates).toHaveLength(0);
    expect(thin.currentStat?.n).toBe(60);
    const f2 = thin.baseline?.folds.find((f) => f.fold === F2);
    expect(f2?.evaluable).toBe(false);
    expect(f2?.reason).toContain("validate");
  });

  it("G = 候选 + 非薄档基线,薄档整档不进分母;zBonf 按 G 换算", () => {
    // heavy:强单维 2 阶梯 × {all,sports} × 10 退出 = 40 候选(全 Sports 数据
    // 让 sports 子集 ≡ all,与基线打平的其它维度全部 train 落选)。
    expect(heavy.candidates).toHaveLength(40);
    expect(report.scoredCells).toBe(41);
    expect(report.zBonf).toBeCloseTo(
      normalQuantile(1 - 0.05 / 41 / 2),
      6,
    );
    expect(report.gridTotal).toBe(210); // 薄档的 180 格不计
    expect(report.gateStart).toBe(GATE);
  });

  it("train 打平的变体落选:连 validate 数字都不发布", () => {
    expect(
      heavy.candidates.some((c) => c.key.startsWith("maxPrice:")),
    ).toBe(false);
    expect(heavy.trainRejected).toBeGreaterThan(0);
  });

  it("强 edge 变体三道闸全过存活;基线自己不参与存活判定", () => {
    const c = heavy.candidates.find(
      (c) => c.key === "minFillUsd:75000|all|hold",
    )!;
    expect(c.pooled?.n).toBe(24);
    expect(c.pooled?.point).toBeCloseTo(0.5, 12);
    expect(c.passClustered).toBe(true);
    expect(c.passRand).toBe(true);
    expect(c.survives).toBe(true);
    expect(c.randP!).toBeLessThanOrEqual(0.05 / 41);
    expect(heavy.survivors).toContain("minFillUsd:75000|all|hold");
    expect(heavy.baseline?.pooled?.point).toBeCloseTo(0, 12);
  });

  it("退出格的随机化继承同子集 hold 基准:同入场不同退出的 p 逐字相等", () => {
    const byExit = (rule: string) =>
      heavy.candidates.find((c) => c.key === `minFillUsd:75000|all|${rule}`)!;
    expect(byExit("tp10").randP).toBe(byExit("hold").randP);
    expect(byExit("sl10").randP).toBe(byExit("tp10").randP);
  });

  it("train 赢 validate 输:入围但闸 A 不过,不存活 —— OOS 的全部意义", () => {
    // consensus 档:wc=3 子集 train 强赢(era 12 全胜),validate 4胜8负×2 折。
    const positions: unknown[] = [];
    for (let i = 0; i < 12; i++) {
      positions.push(
        tierPos(TRAIN_ERA, i, true, {
          walletCount: 3,
          totalNetUsd: 60_000,
          category: "Politics",
        }),
      );
    }
    for (let i = 12; i < 24; i++) {
      positions.push(
        tierPos(TRAIN_ERA, i, false, {
          walletCount: 2,
          totalNetUsd: 20_000,
          category: "Politics",
        }),
      );
    }
    for (const era of [F1, F2]) {
      for (let i = 0; i < 12; i++) {
        positions.push(
          tierPos(era, i, i < 4, {
            walletCount: 3,
            totalNetUsd: 60_000,
            category: "Politics",
          }),
        );
      }
      for (let i = 12; i < 24; i++) {
        positions.push(
          tierPos(era, i, i < 20, {
            walletCount: 2,
            totalNetUsd: 20_000,
            category: "Politics",
          }),
        );
      }
    }
    const r = runWalkforward(
      [
        tierInput(
          "激进",
          params({
            id: 2,
            source: "consensus",
            minWallets: 2,
            minPerWalletUsd: 10_000,
          }),
          positions,
        ),
      ],
      OPTS,
    );
    const c = r.tiers[0].candidates.find(
      (c) => c.key === "minWallets:3|all|hold",
    )!;
    expect(c).toBeDefined();
    expect(c.pooled?.point).toBeLessThan(0);
    expect(c.passClustered).toBe(false);
    expect(c.survives).toBe(false);
    expect(r.tiers[0].survivors).toHaveLength(0);
  });

  it("观察名单:只有 1 个可评折但 train 入选的变体,列名不发数", () => {
    const positions: unknown[] = [];
    for (let i = 0; i < 12; i++) {
      positions.push(tierPos(TRAIN_ERA, i, true, { totalNetUsd: 120_000 }));
    }
    for (let i = 12; i < 24; i++) {
      positions.push(tierPos(TRAIN_ERA, i, false, { totalNetUsd: 60_000 }));
    }
    for (let i = 0; i < 20; i++) {
      positions.push(tierPos(F1, i, i % 2 === 0, { totalNetUsd: 60_000 }));
    }
    for (const [i, win] of Array.from({ length: 12 }, (_, i) => [i, true] as const)) {
      positions.push(tierPos(F2, i, win, { totalNetUsd: 120_000 }));
    }
    for (let i = 12; i < 24; i++) {
      positions.push(tierPos(F2, i, false, { totalNetUsd: 60_000 }));
    }
    const r = runWalkforward(
      [
        tierInput(
          "巨鲸",
          params({ id: 9, source: "heavy", minSingleFillUsd: 50_000 }),
          positions,
        ),
      ],
      OPTS,
    );
    expect(r.tiers[0].candidates).toHaveLength(0);
    expect(
      r.tiers[0].watchlist.some(
        (w) => w.key === "minFillUsd:75000|all|hold" && w.validFolds === 1,
      ),
    ).toBe(true);
  });

  it("报告自带固定诚实段落(幸存者宇宙/收紧外推禁令/近似声明)", () => {
    expect(report.declarations.length).toBeGreaterThanOrEqual(6);
    const all = report.declarations.join("\n");
    expect(all).toContain("幸存者");
    expect(all).toContain("收紧");
    expect(all).toContain("score");
    expect(all).toContain("均值口径");
  });
});
