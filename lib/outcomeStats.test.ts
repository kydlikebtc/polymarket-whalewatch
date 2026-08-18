import { describe, it, expect } from "vitest";
import {
  OUTCOME_EPSILON,
  consensusFoldKey,
  directionVerdict,
  settleWon,
  wilsonInterval,
  clusteredInterval,
  summarizeOutcomes,
} from "./outcomeStats";

describe("settleWon", () => {
  it("judges by P&L direction vs the fill price, not a fixed 0.5 divider", () => {
    // The headline bug: BUY@0.9 settling 0.6 is a real 0.3/share LOSS.
    expect(settleWon("BUY", 0.9, 0.6)).toBe(false);
    // …and BUY@0.3 settling 0.45 is a real profit.
    expect(settleWon("BUY", 0.3, 0.45)).toBe(true);
    // SELL mirrors both.
    expect(settleWon("SELL", 0.9, 0.6)).toBe(true);
    expect(settleWon("SELL", 0.3, 0.45)).toBe(false);
  });

  it("matches the old rule on standard 0/1 settlements", () => {
    expect(settleWon("BUY", 0.6, 1)).toBe(true);
    expect(settleWon("BUY", 0.6, 0)).toBe(false);
    expect(settleWon("SELL", 0.6, 0)).toBe(true);
    expect(settleWon("SELL", 0.6, 1)).toBe(false);
  });

  it("returns null (push) for ≈50/50 rulings and settles within ε of the fill", () => {
    // Cancelled event / draw ruling: both sides refunded at 0.5.
    expect(settleWon("BUY", 0.9, 0.5)).toBeNull();
    expect(settleWon("SELL", 0.1, 0.5)).toBeNull();
    // Settle inside the deadband around the fill: P&L noise, not a verdict.
    // (Fractional/scalar settlements only — see the binary cases below.)
    expect(settleWon("BUY", 0.6, 0.6 + OUTCOME_EPSILON / 2)).toBeNull();
    expect(settleWon("SELL", 0.6, 0.6 - OUTCOME_EPSILON / 2)).toBeNull();
  });

  // Regression: the ε-near-fill push used to apply to 0/1 settlements too,
  // which made the deadband one-sided — an extreme fill could only ever lose
  // (or, at the low end, only ever win). Smart money loading up at 0.997 is
  // exactly the signal shape this tool exists to catch, so the record must
  // grade it both ways.
  describe("binary settlements stay decisive at extreme fills", () => {
    const EXTREME_HIGH = [0.996, 0.997, 0.999];
    const EXTREME_LOW = [0.001, 0.003, 0.004];

    it("a high fill that settles at 1 is a WIN, at 0 a LOSS", () => {
      for (const entry of EXTREME_HIGH) {
        expect(settleWon("BUY", entry, 1)).toBe(true);
        expect(settleWon("BUY", entry, 0)).toBe(false);
      }
    });

    it("a low fill that settles at 1 is a WIN, at 0 a LOSS", () => {
      for (const entry of EXTREME_LOW) {
        expect(settleWon("BUY", entry, 1)).toBe(true);
        expect(settleWon("BUY", entry, 0)).toBe(false);
      }
    });

    it("SELL mirrors it at both extremes", () => {
      for (const entry of [...EXTREME_HIGH, ...EXTREME_LOW]) {
        expect(settleWon("SELL", entry, 0)).toBe(true);
        expect(settleWon("SELL", entry, 1)).toBe(false);
      }
    });

    it("the deadband is symmetric: no fill can be verdict-free in only one direction", () => {
      // For every fill price, a 0-settle and a 1-settle must either BOTH
      // produce a verdict or BOTH be pushes. A one-sided null is the bug.
      for (let e = 0.001; e < 1; e += 0.001) {
        const entry = Number(e.toFixed(3));
        const atOne = settleWon("BUY", entry, 1);
        const atZero = settleWon("BUY", entry, 0);
        expect(
          [atOne === null, atZero === null],
          `entry=${entry} → settle1=${atOne} settle0=${atZero}`,
        ).toEqual([false, false]);
      }
    });

    it("zero P&L is still a push (fill exactly at the settle)", () => {
      expect(settleWon("BUY", 1, 1)).toBeNull();
      expect(settleWon("BUY", 0, 0)).toBeNull();
      expect(settleWon("SELL", 1, 1)).toBeNull();
    });
  });
});

describe("directionVerdict", () => {
  it("BUY hits on a rise, SELL hits on a fall", () => {
    expect(directionVerdict("BUY", 0.5, 0.56)).toBe("hit");
    expect(directionVerdict("BUY", 0.5, 0.44)).toBe("miss");
    expect(directionVerdict("SELL", 0.5, 0.44)).toBe("hit");
    expect(directionVerdict("SELL", 0.5, 0.56)).toBe("miss");
  });

  it("moves inside the ε deadband are pushes, not hits or misses", () => {
    expect(directionVerdict("BUY", 0.5, 0.5 + OUTCOME_EPSILON / 2)).toBe(
      "push",
    );
    expect(directionVerdict("SELL", 0.5, 0.5 - OUTCOME_EPSILON / 2)).toBe(
      "push",
    );
    // Exactly at the boundary counts (strict inequality inside).
    expect(directionVerdict("BUY", 0.5, 0.5 + OUTCOME_EPSILON)).toBe("hit");
  });
});

describe("wilsonInterval", () => {
  it("exposes how unreliable a small sample really is (2/3 ≈ 21%–94%)", () => {
    const { lo, hi } = wilsonInterval(2, 3);
    expect(lo).toBeCloseTo(0.208, 2);
    expect(hi).toBeCloseTo(0.939, 2);
  });

  it("tightens with sample size and stays clamped to [0, 1]", () => {
    const small = wilsonInterval(2, 3);
    const big = wilsonInterval(67, 100);
    expect(big.hi - big.lo).toBeLessThan(small.hi - small.lo);
    expect(wilsonInterval(0, 10).lo).toBeGreaterThanOrEqual(0);
    expect(wilsonInterval(10, 10).hi).toBeLessThanOrEqual(1);
  });

  it("degrades to the trivial [0,1] interval on an empty sample", () => {
    expect(wilsonInterval(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
});

describe("summarizeOutcomes", () => {
  const alerts = [
    { id: 1, type: "large", side: "BUY", price: 0.5 },
    { id: 2, type: "smart", side: "SELL", price: 0.5 },
    { id: 3, type: "consensus", side: "BUY", price: 0.4 },
    { id: 4, type: "large", side: "BUY", price: 0.5 },
    { id: 5, type: "large", side: "BUY", price: 0.5 }, // no outcome yet
  ];
  const outcomes = {
    // 1h hit, 24h hit, settled win.
    1: { price1h: 0.56, price24h: 0.6, resolved: true, won: true },
    // SELL that rose: 1h miss; settled loss.
    2: { price1h: 0.6, price24h: null, resolved: true, won: false },
    // 1h inside the deadband (push → excluded), 24h hit; unresolved.
    3: { price1h: 0.401, price24h: 0.5, resolved: false, won: null },
    // Settled push (won=null) stays out of the win-rate entirely.
    4: { price1h: null, price24h: null, resolved: true, won: null },
  };

  it("groups by type, tallies 1h separately, and drops pushes from both sides", () => {
    const s = summarizeOutcomes(alerts, outcomes);
    // clusters 等于 total:这批夹具没带 clusterKey,每行自成一簇。
    expect(s.dir1h).toEqual({
      hits: 1,
      total: 2,
      clusters: 2,
      byType: {
        large: { hits: 1, total: 1 },
        smart: { hits: 0, total: 1 },
      },
    });
    expect(s.dir24h).toEqual({
      hits: 2,
      total: 2,
      clusters: 2,
      byType: {
        large: { hits: 1, total: 1 },
        consensus: { hits: 1, total: 1 },
      },
    });
    expect(s.settled).toEqual({
      hits: 1,
      total: 2,
      clusters: 2,
      byType: {
        large: { hits: 1, total: 1 },
        smart: { hits: 0, total: 1 },
      },
    });
  });

  it("returns all-zero stats when nothing has been computed", () => {
    const s = summarizeOutcomes(alerts, {});
    expect(s.dir1h.total).toBe(0);
    expect(s.dir24h.total).toBe(0);
    expect(s.settled.total).toBe(0);
  });

  it("同一次共识的升级行只计一次（看板胜率条与推送战绩同口径）", () => {
    // 共识 dedup_key 含 walletCount,2→3→4 人写三行。逐行计数会把一次共识
    // 计三次,且升级过的组恰是更强的组 —— 看板胜率条与推送战绩必须同口径,
    // 否则同一件事在两处报出两个数字。
    const escalations = [
      {
        id: 10,
        type: "consensus",
        side: "BUY",
        price: 0.4,
        foldKey: "c|Yes",
        createdAt: 100,
      },
      {
        id: 11,
        type: "consensus",
        side: "BUY",
        price: 0.5,
        foldKey: "c|Yes",
        createdAt: 200,
      },
      {
        id: 12,
        type: "consensus",
        side: "BUY",
        price: 0.6,
        foldKey: "c|Yes",
        createdAt: 300,
      },
    ];
    const won = { resolved: true, won: true, price1h: null, price24h: null };
    const s = summarizeOutcomes(escalations, { 10: won, 11: won, 12: won });
    expect(s.settled.total).toBe(1);
    expect(s.settled.byType.consensus).toEqual({ hits: 1, total: 1 });
  });

  it("每个统计各自折叠 —— 形成行还没回填 1h 价时不该拖累整组", () => {
    // price_1h/price_24h/结算 是按告警 id 独立惰性回填的,同一组的形成行与
    // 升级行回填进度可以不同。若先折叠再判可评分,形成行(无 1h 价)会赢下
    // 折叠然后被丢弃,整组从 1h 命中率里消失;而结算维度它明明是可评分的。
    const alerts = [
      {
        id: 1,
        type: "consensus",
        side: "BUY",
        price: 0.4,
        foldKey: "c|Yes",
        createdAt: 100,
      },
      {
        id: 2,
        type: "consensus",
        side: "BUY",
        price: 0.5,
        foldKey: "c|Yes",
        createdAt: 200,
      },
    ];
    const s = summarizeOutcomes(alerts, {
      1: { price1h: null, price24h: null, resolved: true, won: true },
      2: { price1h: 0.7, price24h: null, resolved: true, won: true },
    });
    // 结算维度:形成行可评分 → 折叠后计 1 次。
    expect(s.settled).toEqual({
      hits: 1,
      total: 1,
      clusters: 1,
      byType: { consensus: { hits: 1, total: 1 } },
    });
    // 1h 维度:只有升级行有价 → 仍应计 1 次,而不是整组消失。
    expect(s.dir1h.total).toBe(1);
    expect(s.dir1h.hits).toBe(1);
  });

  it("consensusFoldKey 剥掉 dedup_key 的钱包数末段", () => {
    expect(consensusFoldKey("consensus:0xabc:Yes:3")).toBe(
      "consensus:0xabc:Yes",
    );
    // 同市场同方向的不同人数折叠到同一个键 —— 这正是折叠要合并的那组。
    expect(consensusFoldKey("consensus:0xabc:Yes:2")).toBe(
      consensusFoldKey("consensus:0xabc:Yes:7"),
    );
    // 不同方向不能撞键。
    expect(consensusFoldKey("consensus:0xabc:No:3")).not.toBe(
      consensusFoldKey("consensus:0xabc:Yes:3"),
    );
    expect(consensusFoldKey(null)).toBeNull();
    expect(consensusFoldKey("nocolon")).toBeNull();
  });

  it("无 foldKey 的行逐行计数（大额/聪明钱每笔都是独立信号）", () => {
    const fills = [
      { id: 20, type: "large", side: "BUY", price: 0.5 },
      { id: 21, type: "large", side: "BUY", price: 0.5 },
    ];
    const won = { resolved: true, won: true, price1h: null, price24h: null };
    const s = summarizeOutcomes(fills, { 20: won, 21: won });
    expect(s.settled.total).toBe(2);
  });
});

describe("市场聚类有效样本量", () => {
  // 同一市场的多条告警共享同一个结算结果 —— 它们是 1 个随机事件的 N 份
  // 副本,不是 N 个独立观测。实测本项目历史库:3852 条已结算告警只落在
  // 669 个市场上,单个市场最多 201 条(世界杯期间一场球的大额单)。按告警
  // 数算 Wilson 区间会把误差低估约 1.9 倍,而且分组结论经常与聚类口径
  // 符号相反。点估计(发了多少条、对了多少条)保持按告警,只有【区间】必须
  // 用有效样本量。
  const won = { resolved: true, won: true, price1h: null, price24h: null };
  const lost = { resolved: true, won: false, price1h: null, price24h: null };

  it("同一市场的多条告警只贡献一个有效样本", () => {
    const alerts = [
      { id: 1, type: "large", side: "BUY", price: 0.5, clusterKey: "mktA" },
      { id: 2, type: "large", side: "BUY", price: 0.5, clusterKey: "mktA" },
      { id: 3, type: "large", side: "BUY", price: 0.5, clusterKey: "mktA" },
      { id: 4, type: "large", side: "BUY", price: 0.5, clusterKey: "mktB" },
    ];
    const s = summarizeOutcomes(alerts, {
      1: won,
      2: won,
      3: won,
      4: lost,
    });
    // 点估计不变:确实发了 4 条,对了 3 条。
    expect(s.settled.total).toBe(4);
    expect(s.settled.hits).toBe(3);
    // 但只有 2 个市场 —— 真实的独立观测数。
    expect(s.settled.clusters).toBe(2);
  });

  it("二元市场的正反两面同属一簇（Yes 赢则 No 必输,绝不独立）", () => {
    // clusterKey 取 conditionId 而不含 outcome/side:同一市场买 Yes 与买 No
    // 的输赢完全互补,把它们当两个独立观测会凭空翻倍有效样本量。
    const alerts = [
      { id: 1, type: "large", side: "BUY", price: 0.6, clusterKey: "mktA" },
      { id: 2, type: "large", side: "SELL", price: 0.6, clusterKey: "mktA" },
    ];
    const s = summarizeOutcomes(alerts, { 1: won, 2: lost });
    expect(s.settled.total).toBe(2);
    expect(s.settled.clusters).toBe(1);
  });

  it("缺 clusterKey 时每行自成一簇（老 API / 未接线时行为不变）", () => {
    const alerts = [
      { id: 1, type: "large", side: "BUY", price: 0.5 },
      { id: 2, type: "large", side: "BUY", price: 0.5 },
    ];
    const s = summarizeOutcomes(alerts, { 1: won, 2: won });
    expect(s.settled.total).toBe(2);
    expect(s.settled.clusters).toBe(2);
  });

  it("三个统计各自计簇 —— 回填进度不同不该串味", () => {
    const alerts = [
      { id: 1, type: "large", side: "BUY", price: 0.5, clusterKey: "mktA" },
      { id: 2, type: "large", side: "BUY", price: 0.5, clusterKey: "mktB" },
    ];
    const s = summarizeOutcomes(alerts, {
      // 只有 1 号回填了 1h 价,两者都已结算。
      1: { price1h: 0.6, price24h: null, resolved: true, won: true },
      2: { price1h: null, price24h: null, resolved: true, won: true },
    });
    expect(s.dir1h.clusters).toBe(1);
    expect(s.settled.clusters).toBe(2);
    expect(s.dir24h.clusters).toBe(0);
  });

  it("共识折叠与市场聚类叠加:先折升级行,再按市场并簇", () => {
    // 同一市场的 Yes 共识升级了两次(2→3 人),另有该市场 No 侧的一条共识。
    // 折叠吃掉升级重报(3 行 → 2 行),聚类再把同市场的正反两面并成 1 簇。
    const alerts = [
      {
        id: 1,
        type: "consensus",
        side: "BUY",
        price: 0.4,
        foldKey: "c|Yes",
        createdAt: 100,
        clusterKey: "mktA",
      },
      {
        id: 2,
        type: "consensus",
        side: "BUY",
        price: 0.5,
        foldKey: "c|Yes",
        createdAt: 200,
        clusterKey: "mktA",
      },
      {
        id: 3,
        type: "consensus",
        side: "BUY",
        price: 0.3,
        foldKey: "c|No",
        createdAt: 150,
        clusterKey: "mktA",
      },
    ];
    const s = summarizeOutcomes(alerts, { 1: won, 2: won, 3: lost });
    expect(s.settled.total).toBe(2); // 折叠后 2 行
    expect(s.settled.clusters).toBe(1); // 但只有 1 个市场
  });
});

describe("clusteredInterval", () => {
  it("有效样本量小于告警数时,区间比按告警算的更宽", () => {
    const naive = wilsonInterval(60, 100);
    const clustered = clusteredInterval(60, 100, 10);
    expect(clustered.hi - clustered.lo).toBeGreaterThan(naive.hi - naive.lo);
  });

  it("点估计不被区间校正改动（中心仍围绕 hits/total）", () => {
    const { lo, hi } = clusteredInterval(60, 100, 10);
    expect(lo).toBeLessThan(0.6);
    expect(hi).toBeGreaterThan(0.6);
  });

  it("每条告警各自成簇时与 wilsonInterval 完全一致", () => {
    expect(clusteredInterval(60, 100, 100)).toEqual(wilsonInterval(60, 100));
  });

  it("簇数异常（0 / 超过告警数）时退回按告警计,绝不虚报精度", () => {
    expect(clusteredInterval(60, 100, 0)).toEqual(wilsonInterval(60, 100));
    // 簇数不可能多于告警数;真出现了也不能拿它换更窄的区间。
    expect(clusteredInterval(60, 100, 999)).toEqual(wilsonInterval(60, 100));
  });

  it("空样本退化为平凡区间", () => {
    expect(clusteredInterval(0, 0, 0)).toEqual({ lo: 0, hi: 1 });
  });
});
