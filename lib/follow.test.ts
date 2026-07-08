import { describe, it, expect } from "vitest";
import {
  positionShares,
  positionRealizedPnl,
  positionSlippage,
  qualifyingGroups,
  latestPriceByAsset,
  computeStrategyMetrics,
  buildFollowView,
} from "./follow";
import type { FollowPositionRow } from "./follow";
import type { ConsensusGroup, ConsensusWallet } from "./consensus";
import type { Trade } from "./types";

// --- Task 2: 单仓 P&L 纯函数(约定:价在前、size 在后) ---
describe("follow single-position P&L", () => {
  it("shares = size / entry", () => {
    expect(positionShares(0.5, 500)).toBeCloseTo(1000);
  });
  it("realized = shares*(exit-entry) — 赢", () => {
    expect(positionRealizedPnl(0.5, 1, 500)).toBeCloseTo(500);
  });
  it("realized — 输(结算 0)= -size", () => {
    expect(positionRealizedPnl(0.5, 0, 500)).toBeCloseTo(-500);
  });
  it("slippage = shares*(entry-smartAvg),现价更贵为正", () => {
    expect(positionSlippage(0.6, 0.57, 500)).toBeCloseTo(25, 0);
  });
  it("entry<=0 时 shares=0(防除零)", () => {
    expect(positionShares(0, 500)).toBe(0);
    expect(positionRealizedPnl(0, 1, 500)).toBe(0);
  });
  it("slippage 零入场价 → 0(防除零)", () => {
    // shares=0 → 0*(0-0.57) 在 JS 里是 -0,数值上即 0;用 toBeCloseTo 免去符号零之争。
    expect(positionSlippage(0, 0.57, 500)).toBeCloseTo(0);
  });
});

// 复用真实 ConsensusWallet/ConsensusGroup 类型的桩工厂(补齐全字段,不用 any)。
const wallet = (over: Partial<ConsensusWallet>): ConsensusWallet => ({
  wallet: "w",
  netUsd: 0,
  buyCount: 1,
  avgBuyPrice: 0.5,
  score: null,
  winRate: null,
  qualifiedTs: 0,
  ...over,
});
const group = (over: Partial<ConsensusGroup>): ConsensusGroup => ({
  conditionId: "c",
  outcome: "Yes",
  title: "t",
  eventSlug: "e",
  asset: "a",
  outcomeIndex: 0,
  wallets: [],
  walletCount: 0,
  totalNetUsd: 0,
  avgBuyPrice: 0.5,
  firstTs: 0,
  lastTs: 0,
  formationTs: 0,
  ...over,
});

// --- Task 3: 策略阈值二次过滤 ---
describe("follow qualifyingGroups", () => {
  it("按策略阈值二次筛:每人净买>=floor 且 人数>=minWallets", () => {
    const g = group({
      wallets: [
        wallet({ wallet: "w1", netUsd: 12000 }),
        wallet({ wallet: "w2", netUsd: 11000 }),
        wallet({ wallet: "w3", netUsd: 6000 }),
      ],
    });
    expect(
      qualifyingGroups([g], { minWallets: 3, minPerWalletUsd: 10000 }).length,
    ).toBe(0);
    expect(
      qualifyingGroups([g], { minWallets: 2, minPerWalletUsd: 5000 }).length,
    ).toBe(1);
  });
  it("空输入 → 空数组", () => {
    expect(
      qualifyingGroups([], { minWallets: 2, minPerWalletUsd: 5000 }),
    ).toEqual([]);
  });
});

// 复用真实 Trade 类型的桩工厂。
const trade = (over: Partial<Trade>): Trade => ({
  proxyWallet: "0xabc",
  side: "BUY",
  asset: "a",
  conditionId: "c",
  size: 1,
  price: 0.5,
  timestamp: 0,
  title: "t",
  slug: "s",
  eventSlug: "e",
  outcome: "Yes",
  outcomeIndex: 0,
  transactionHash: "0xhash",
  ...over,
});

// --- Task 4: 窗口最近成交价 ---
describe("follow latestPriceByAsset", () => {
  it("按 max timestamp 取最新价(乱序 + 最新 ts 不在末位,锁死 last-wins)", () => {
    // 生产窗口是 newest-first(见 lib/polymarket.ts),最新 ts 在数组前部。
    // 若实现退化成「取末元素/last-wins」会拿到 0.55(更旧)而 FAIL。
    const trades = [
      trade({ asset: "a", price: 0.63, timestamp: 200 }), // 最新 ts,排在前
      trade({ asset: "a", price: 0.55, timestamp: 150 }), // 更旧,排在后
      trade({ asset: "b", price: 0.4, timestamp: 150 }),
    ];
    const m = latestPriceByAsset(trades);
    expect(m.get("a")).toBe(0.63);
    expect(m.get("b")).toBe(0.4);
  });
  it("timestamp 相等 ⇒ 严格 > ,先见者胜(保留最先出现的那笔)", () => {
    const trades = [
      trade({ asset: "a", price: 0.7, timestamp: 100 }), // 先见,应保留
      trade({ asset: "a", price: 0.8, timestamp: 100 }), // 同 ts,不覆盖
    ];
    expect(latestPriceByAsset(trades).get("a")).toBe(0.7);
  });
  it("空输入 → 空 Map", () => {
    expect(latestPriceByAsset([]).size).toBe(0);
  });
});

// --- Task 6: 策略级指标(净值/回撤/Wilson/滑点/按赛道) ---
const pos = (o: Partial<FollowPositionRow>): FollowPositionRow => ({
  strategy_id: 1,
  condition_id: "c",
  outcome: "Yes",
  size_usd: 500,
  entry_price: 0.5,
  smart_avg_price: 0.48,
  shares: 1000,
  status: "settled",
  entry_ts: 0,
  exit_ts: 86400,
  exit_price: 1,
  realized_pnl: 0,
  ...o,
});

describe("computeStrategyMetrics", () => {
  it("空仓 → 全零/空,winRate/roi 为 null", () => {
    const m = computeStrategyMetrics([], {});
    expect(m.settledCount).toBe(0);
    expect(m.roi).toBeNull();
    expect(m.winRate).toBeNull();
    expect(m.maxDrawdown).toBe(0);
    expect(m.equityCurve).toEqual([]);
    expect(m.byCategory).toEqual({});
  });
  it("净值曲线累计 + 最大回撤(峰100→谷-400 = 500)", () => {
    const positions = [
      pos({ condition_id: "a", exit_ts: 1, realized_pnl: 100 }),
      pos({ condition_id: "b", exit_ts: 2, realized_pnl: -500 }),
      pos({ condition_id: "c", exit_ts: 3, realized_pnl: 200 }),
    ];
    const m = computeStrategyMetrics(positions, {});
    expect(m.equityCurve.map((e) => e.cum)).toEqual([100, -400, -200]);
    expect(m.maxDrawdown).toBeCloseTo(500); // 计划里写的 600 是笔误:峰100→谷-400 = 500
    expect(m.settledCount).toBe(3);
    expect(m.wins).toBe(2);
    expect(m.winRate).toBeCloseTo(2 / 3); // 3 非 push,denom=3
  });
  it("push(realized=0)不计胜率分母", () => {
    const m = computeStrategyMetrics(
      [pos({ realized_pnl: 100 }), pos({ realized_pnl: 0, condition_id: "x" })],
      {},
    );
    expect(m.settledCount).toBe(2);
    expect(m.wins).toBe(1);
    expect(m.winRate).toBeCloseTo(1); // denom = wins+losses = 1
  });
  it("open 仓不计入结算指标,但计入 openCount 与 slippageCost", () => {
    const m = computeStrategyMetrics(
      [
        pos({
          status: "open",
          exit_ts: null,
          exit_price: null,
          realized_pnl: null,
          entry_price: 0.6,
          smart_avg_price: 0.57,
          size_usd: 500,
        }),
      ],
      {},
    );
    expect(m.settledCount).toBe(0);
    expect(m.openCount).toBe(1);
    expect(m.slippageCost).toBeCloseTo(25, 0); // (500/0.6)*(0.6-0.57)
  });
  it("byCategory 按 categoryByCid 分组,缺失归『未分类』", () => {
    const m = computeStrategyMetrics(
      [
        pos({ condition_id: "a", realized_pnl: 100 }),
        pos({ condition_id: "b", realized_pnl: -50 }),
      ],
      { a: "Crypto" },
    );
    expect(m.byCategory["Crypto"]).toEqual({ realized: 100, settledCount: 1 });
    expect(m.byCategory["未分类"]).toEqual({ realized: -50, settledCount: 1 });
  });
});

// --- Task 8: buildFollowView(策略行 + 全部仓位 + 分类 → 每策略视图) ---
// 复用真实入参形状(follow_strategies 行:enabled 为 0/1,params_json 可空)的桩工厂。
type StratRow = Parameters<typeof buildFollowView>[0][number];
const strat = (o: Partial<StratRow>): StratRow => ({
  id: 1,
  name: "保守",
  enabled: 1,
  params_json: JSON.stringify({
    minWallets: 3,
    minPerWalletUsd: 10000,
    sizeUsd: 500,
    exitRule: "settlement",
  }),
  ...o,
});

describe("buildFollowView", () => {
  it("按 strategy_id 分组:各策略只见到自己的仓位,顺序沿用入参(id 升序)", () => {
    const { strategies } = buildFollowView(
      [strat({ id: 1 }), strat({ id: 2, name: "激进" })],
      [
        pos({ strategy_id: 1, condition_id: "a" }),
        pos({ strategy_id: 1, condition_id: "b" }),
        pos({ strategy_id: 2, condition_id: "c" }),
      ],
      {},
    );
    expect(strategies.map((v) => v.id)).toEqual([1, 2]);
    expect(strategies[0].metrics.settledCount).toBe(2);
    expect(strategies[1].metrics.settledCount).toBe(1);
    expect(strategies[0].settled.every((p) => p.strategy_id === 1)).toBe(true);
    expect(strategies[1].settled.every((p) => p.strategy_id === 2)).toBe(true);
  });

  it("open/settled 分列,settled 按 exit_ts 降序(最新在前)", () => {
    const { strategies } = buildFollowView(
      [strat({ id: 1 })],
      [
        pos({ strategy_id: 1, condition_id: "s1", exit_ts: 100 }),
        pos({ strategy_id: 1, condition_id: "s2", exit_ts: 300 }),
        pos({ strategy_id: 1, condition_id: "s3", exit_ts: 200 }),
        pos({
          strategy_id: 1,
          condition_id: "o1",
          status: "open",
          exit_ts: null,
          exit_price: null,
          realized_pnl: null,
        }),
      ],
      {},
    );
    const v = strategies[0];
    expect(v.open.map((p) => p.condition_id)).toEqual(["o1"]);
    expect(v.settled.map((p) => p.exit_ts)).toEqual([300, 200, 100]);
  });

  it("params_json 正常解析,enabled=1 → true", () => {
    const { strategies } = buildFollowView(
      [
        strat({
          id: 1,
          params_json: JSON.stringify({
            minWallets: 2,
            minPerWalletUsd: 5000,
            sizeUsd: 500,
            exitRule: "settlement",
          }),
        }),
      ],
      [],
      {},
    );
    expect(strategies[0].params).toEqual({
      minWallets: 2,
      minPerWalletUsd: 5000,
      sizeUsd: 500,
      exitRule: "settlement",
      // 字段缺失时展示侧退到与开仓侧一致的默认 10¢(不能显示成 0=「无护栏」)。
      maxEntryDeviationCents: 10,
    });
    expect(strategies[0].enabled).toBe(true);
  });

  it("params_json 损坏/为空/缺字段 → 安全默认,不抛", () => {
    const { strategies } = buildFollowView(
      [
        strat({ id: 1, params_json: "{不是合法json" }),
        strat({ id: 2, params_json: null }),
        strat({ id: 3, params_json: JSON.stringify({ minWallets: 4 }) }),
      ],
      [],
      {},
    );
    const dflt = {
      minWallets: 0,
      minPerWalletUsd: 0,
      sizeUsd: 0,
      exitRule: "settlement",
      // 护栏阈值的安全默认是 10(开仓侧实际生效值),不同于其余字段的 0 占位。
      maxEntryDeviationCents: 10,
    };
    expect(strategies[0].params).toEqual(dflt);
    expect(strategies[1].params).toEqual(dflt);
    // 缺字段:已有的 minWallets 保留,其余退默认。
    expect(strategies[2].params).toEqual({ ...dflt, minWallets: 4 });
  });

  it("enabled=0 → false", () => {
    const { strategies } = buildFollowView(
      [strat({ id: 1, enabled: 0 })],
      [],
      {},
    );
    expect(strategies[0].enabled).toBe(false);
  });

  it("categoryByCid 透传给 metrics.byCategory", () => {
    const { strategies } = buildFollowView(
      [strat({ id: 1 })],
      [
        pos({ strategy_id: 1, condition_id: "a", realized_pnl: 100 }),
        pos({ strategy_id: 1, condition_id: "b", realized_pnl: -50 }),
      ],
      { a: "Crypto" },
    );
    expect(strategies[0].metrics.byCategory["Crypto"]).toEqual({
      realized: 100,
      settledCount: 1,
    });
    expect(strategies[0].metrics.byCategory["未分类"]).toEqual({
      realized: -50,
      settledCount: 1,
    });
  });
});
