import { describe, it, expect, vi } from "vitest";
import {
  positionShares,
  positionRealizedPnl,
  positionSlippage,
  qualifyingGroups,
  latestPriceByAsset,
  computeStrategyMetrics,
  computeFundMetrics,
  computeAccountPlan,
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
  slug: "s",
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
  fee_usd: null,
  ...o,
});

describe("computeStrategyMetrics 协议费", () => {
  it("只累计已结算且费用已知的仓，并如实报出未知的那几仓", () => {
    // 费用是 append-only 归因:上线前的老仓恒为 null(费率表是当前值而非
    // 成交时刻值,回填会造出一个看不出是估算的估算)。所以「含协议费」这一
    // 档必须带着覆盖率一起呈现,否则读者会以为它覆盖了全部样本。
    const m = computeStrategyMetrics(
      [
        pos({ realized_pnl: 100, fee_usd: 12.5 }),
        pos({ realized_pnl: -50, fee_usd: 7.5 }),
        pos({ realized_pnl: 30, fee_usd: null }), // 老仓,未知
        pos({ status: "open", realized_pnl: null, fee_usd: 99 }), // 未结算不计
      ],
      {},
    );
    expect(m.feeCost).toBeCloseTo(20);
    expect(m.feeSamples).toBe(2);
    expect(m.feeUnknown).toBe(1);
  });

  it("slippageCostSettled 只算已结算仓 —— 三档相减必须同口径", () => {
    // slippageCost 覆盖 open+settled(追价成本在进场即产生),但 totalRealized
    // 与 feeCost 只覆盖 settled。「净盈亏(含追价+协议费)」若拿全量追价成本去
    // 减已结算盈亏,等于把还没结算的仓的成本提前记进已结算账 —— 三个数必须
    // 同口径才能相减。
    const positions = [
      pos({ status: "settled", entry_price: 0.6, smart_avg_price: 0.5 }),
      pos({
        status: "open",
        entry_price: 0.6,
        smart_avg_price: 0.5,
        realized_pnl: null,
      }),
    ];
    const m = computeStrategyMetrics(positions, {});
    // positionSlippage 由 size/entry 重算份额(不取行里的 shares 列):
    // 每仓 = (500/0.6) × (0.6 − 0.5) = 833.33 × 0.1 = 83.33
    const per = (500 / 0.6) * 0.1;
    expect(m.slippageCost).toBeCloseTo(per * 2); // open + settled
    expect(m.slippageCostSettled).toBeCloseTo(per); // 只已结算那一仓
  });

  it("fee_usd=0 是已知的零（免费市场），计入样本但不加成本", () => {
    const m = computeStrategyMetrics(
      [pos({ realized_pnl: 10, fee_usd: 0 })],
      {},
    );
    expect(m.feeCost).toBe(0);
    expect(m.feeSamples).toBe(1);
    expect(m.feeUnknown).toBe(0);
  });

  it("全是老仓时 feeSamples=0 —— 页面据此整档留白而不是显示 $0", () => {
    const m = computeStrategyMetrics([pos({ realized_pnl: 10 })], {});
    expect(m.feeSamples).toBe(0);
    expect(m.feeUnknown).toBe(1);
  });

  it("netAfterCostsCovered 只在费用已知的子集上算三项 —— 老仓不拖累指标可用性", () => {
    // 老仓永不回填费用,若沿用「有一个未知就整档留白」,这个指标会因为历史
    // 仓的存在而永远不亮。改为限定子集:三项同口径、数字自洽,覆盖率另行披露。
    const per = (500 / 0.6) * 0.1; // 单仓追价成本
    const m = computeStrategyMetrics(
      [
        pos({
          realized_pnl: 100,
          fee_usd: 12.5,
          entry_price: 0.6,
          smart_avg_price: 0.5,
        }),
        // 老仓:盈亏很大但费用未知 —— 绝不能混进这个子集。
        pos({ realized_pnl: 9999, fee_usd: null }),
      ],
      {},
    );
    expect(m.feeSamples).toBe(1);
    expect(m.feeUnknown).toBe(1);
    expect(m.netAfterCostsCovered).toBeCloseTo(100 - per - 12.5);
  });
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
  created_at: null,
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
      // source/maxPrice/freshSec 同样字段缺失,退到与开仓侧 parseStrategy 同源
      // 的默认值(见 lib/follow.ts DEFAULT_MAX_PRICE/DEFAULT_FRESH_SEC 注释)。
      source: "consensus",
      maxPrice: 0.95,
      freshSec: 900,
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
      source: "consensus",
      maxPrice: 0.95,
      freshSec: 900,
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

// --- 基金式档案指标(开始时间/运行天数/峰值占用/年化) ---
describe("computeFundMetrics", () => {
  const DAY = 86400;

  it("空仓 + created_at → startTs=created_at,峰值占用 0,年化 null(无结算仓)", () => {
    const f = computeFundMetrics([], 1000, 1000 + 10 * DAY);
    expect(f.startTs).toBe(1000);
    expect(f.runDays).toBeCloseTo(10);
    expect(f.maxConcurrentUsd).toBe(0);
    expect(f.annualizedRoi).toBeNull();
  });

  it("created_at 缺失 → startTs 回退最早 entry_ts;两者皆无 → 全 null/0", () => {
    const f = computeFundMetrics(
      [
        pos({ entry_ts: 5 * DAY }),
        pos({ condition_id: "b", entry_ts: 2 * DAY }),
      ],
      null,
      12 * DAY,
    );
    expect(f.startTs).toBe(2 * DAY);
    expect(f.runDays).toBeCloseTo(10);

    const empty = computeFundMetrics([], null, 12 * DAY);
    expect(empty.startTs).toBeNull();
    expect(empty.runDays).toBeNull();
    expect(empty.maxConcurrentUsd).toBe(0);
    expect(empty.annualizedRoi).toBeNull();
  });

  it("峰值占用 = 扫描线求同时持仓资金峰值(open 仓占用至今不释放)", () => {
    const f = computeFundMetrics(
      [
        // [0,100] 与 [50,150] 重叠 → 峰值 1000;120 开的 open 仓再叠 → 峰值 1000+
        pos({ condition_id: "a", entry_ts: 0, exit_ts: 100, size_usd: 500 }),
        pos({ condition_id: "b", entry_ts: 50, exit_ts: 150, size_usd: 500 }),
        pos({
          condition_id: "c",
          entry_ts: 120,
          size_usd: 500,
          status: "open",
          exit_ts: null,
          exit_price: null,
          realized_pnl: null,
        }),
      ],
      0,
      30 * DAY,
    );
    // 时间线:0→+500;50→1000(峰);100→500;120→1000(峰);150→500(open 不释放)
    expect(f.maxConcurrentUsd).toBe(1000);
  });

  it("同一时刻先入后出(保守口径):exit 与 entry 同 ts 记作瞬时并存", () => {
    const f = computeFundMetrics(
      [
        pos({ condition_id: "a", entry_ts: 0, exit_ts: 100, size_usd: 500 }),
        pos({ condition_id: "b", entry_ts: 100, exit_ts: 200, size_usd: 500 }),
      ],
      0,
      30 * DAY,
    );
    expect(f.maxConcurrentUsd).toBe(1000);
  });

  it("年化 = 结算净值/峰值占用 × 365/运行天数", () => {
    // 运行 73 天(365/5),净值 +100,峰值占用 500 → 0.2 × 5 = 1.0(+100%)
    const f = computeFundMetrics(
      [pos({ entry_ts: 0, exit_ts: DAY, size_usd: 500, realized_pnl: 100 })],
      0,
      73 * DAY,
    );
    expect(f.annualizedRoi).toBeCloseTo(1.0);
  });

  it("护栏:运行不足 1 天 → 年化 null(短窗年化爆炸,不外推)", () => {
    const f = computeFundMetrics(
      [pos({ entry_ts: 0, exit_ts: 1800, size_usd: 500, realized_pnl: 100 })],
      0,
      3600,
    );
    expect(f.runDays).toBeCloseTo(3600 / DAY);
    expect(f.annualizedRoi).toBeNull();
  });

  it("护栏:峰值占用为 0(size 全 0 的异常数据)→ 年化 null,不除零", () => {
    const f = computeFundMetrics(
      [pos({ entry_ts: 0, exit_ts: DAY, size_usd: 0, realized_pnl: 50 })],
      0,
      30 * DAY,
    );
    expect(f.maxConcurrentUsd).toBe(0);
    expect(f.annualizedRoi).toBeNull();
  });
});

describe("buildFollowView · fund 档案透传", () => {
  const DAY = 86400;

  it("每策略携带 fund;created_at 与 nowSec 流入计算", () => {
    const { strategies } = buildFollowView(
      [strat({ id: 1, created_at: 1000 })],
      [
        pos({
          strategy_id: 1,
          entry_ts: 1000,
          exit_ts: 1000 + DAY,
          size_usd: 500,
          realized_pnl: 100,
        }),
      ],
      {},
      1000 + 73 * DAY,
    );
    const f = strategies[0].fund;
    expect(f.startTs).toBe(1000);
    expect(f.runDays).toBeCloseTo(73);
    expect(f.maxConcurrentUsd).toBe(500);
    expect(f.annualizedRoi).toBeCloseTo(1.0);
  });

  it("created_at null → fund.startTs 回退该策略最早 entry_ts", () => {
    const { strategies } = buildFollowView(
      [strat({ id: 1, created_at: null })],
      [pos({ strategy_id: 1, entry_ts: 7 * DAY })],
      {},
      17 * DAY,
    );
    expect(strategies[0].fund.startTs).toBe(7 * DAY);
    expect(strategies[0].fund.runDays).toBeCloseTo(10);
  });
});

// --- 账户推演(反事实回放:若账户只备 $X,接住/错过/落袋/效率) ---
describe("computeAccountPlan", () => {
  const DAY = 86400;
  const plan = (
    positions: FollowPositionRow[],
    createdAt: number | null,
    nowSec: number,
  ) =>
    computeAccountPlan(
      positions,
      computeFundMetrics(positions, createdAt, nowSec),
      nowSec,
    );

  it("空仓 → rows 空、recommended/suggested null、平均占用 0", () => {
    const p = plan([], 0, 10 * DAY);
    expect(p.rows).toEqual([]);
    expect(p.recommendedUsd).toBeNull();
    expect(p.suggestedUsd).toBeNull();
    expect(p.avgOccupiedUsd).toBe(0);
    expect(p.utilization).toBeNull();
    expect(p.annualizedOnRecommended).toBeNull();
  });

  it("recommended = 峰值占用;峰值档接住全部、错过 0、落袋=结算合计", () => {
    const p = plan(
      [
        pos({
          condition_id: "a",
          entry_ts: 0,
          exit_ts: 100,
          size_usd: 500,
          realized_pnl: 100,
        }),
        pos({
          condition_id: "b",
          entry_ts: 50,
          exit_ts: 150,
          size_usd: 500,
          realized_pnl: -40,
        }),
      ],
      0,
      30 * DAY,
    );
    expect(p.recommendedUsd).toBe(1000); // 两仓 [0,100]×[50,150] 重叠
    const rec = p.rows.find((r) => r.accountUsd === 1000)!;
    expect(rec.taken).toBe(2);
    expect(rec.missed).toBe(0);
    expect(rec.realizedPnl).toBeCloseTo(60);
  });

  it("建议跟单额度 = 峰值 × 1.25 按最小仓量向上取整,且必在档位表中", () => {
    const p = plan(
      [
        pos({
          condition_id: "a",
          entry_ts: 0,
          exit_ts: 100,
          size_usd: 500,
          realized_pnl: 100,
        }),
        pos({
          condition_id: "b",
          entry_ts: 50,
          exit_ts: 150,
          size_usd: 500,
          realized_pnl: -40,
        }),
      ],
      0,
      30 * DAY,
    );
    // 峰值 1000 → 1.25 × 1000 = 1250 → 按 500 向上取整 = 1500
    expect(p.suggestedUsd).toBe(1500);
    expect(p.suggestedUsd! > p.recommendedUsd!).toBe(true);
    expect(p.rows.some((r) => r.accountUsd === p.suggestedUsd)).toBe(true);
  });

  it("账户 < 峰值 → 按开仓顺序精确错过,错过仓的盈亏进 missedPnl 不进落袋", () => {
    const p = plan(
      [
        pos({
          condition_id: "a",
          entry_ts: 0,
          exit_ts: 200,
          size_usd: 500,
          realized_pnl: 100,
        }),
        pos({
          condition_id: "b",
          entry_ts: 50,
          exit_ts: 200,
          size_usd: 500,
          realized_pnl: 100,
        }),
        pos({
          condition_id: "c",
          entry_ts: 60,
          exit_ts: 200,
          size_usd: 500,
          realized_pnl: -500,
        }),
      ],
      0,
      30 * DAY,
    );
    // 峰值 1500;考察 $1,000 档:c 第三个进场时资金已满 → 错过,幸运避亏
    const row = p.rows.find((r) => r.accountUsd === 1000)!;
    expect(row.taken).toBe(2);
    expect(row.missed).toBe(1);
    expect(row.realizedPnl).toBeCloseTo(200);
    expect(row.missedPnl).toBeCloseTo(-500);
  });

  it("结算释放资金可复用:后进仓在前仓退出后进场,小账户也全接住", () => {
    const p = plan(
      [
        pos({
          condition_id: "a",
          entry_ts: 0,
          exit_ts: 100,
          size_usd: 500,
          realized_pnl: 50,
        }),
        pos({
          condition_id: "b",
          entry_ts: 150,
          exit_ts: 300,
          size_usd: 500,
          realized_pnl: 50,
        }),
      ],
      0,
      30 * DAY,
    );
    expect(p.recommendedUsd).toBe(500); // 无重叠 → 峰值一仓
    const rec = p.rows.find((r) => r.accountUsd === 500)!;
    expect(rec.taken).toBe(2);
    expect(rec.missed).toBe(0);
  });

  it("同刻先入后出(保守口径):t 时刻退出的资金 t 时刻不可用 → 同刻新仓错过", () => {
    const p = plan(
      [
        pos({
          condition_id: "a",
          entry_ts: 0,
          exit_ts: 100,
          size_usd: 500,
          realized_pnl: 50,
        }),
        pos({
          condition_id: "b",
          entry_ts: 100,
          exit_ts: 200,
          size_usd: 500,
          realized_pnl: 50,
        }),
      ],
      0,
      30 * DAY,
    );
    expect(p.recommendedUsd).toBe(1000); // 与扫描线峰值同口径:瞬时并存
    const tight = p.rows.find((r) => r.accountUsd === 500)!;
    expect(tight.taken).toBe(1);
    expect(tight.missed).toBe(1);
  });

  it("时间加权平均占用与使用效率:仓 [0,100d] $500 · 窗口 200d → 均 250、效率 50%", () => {
    const p = plan(
      [
        pos({
          entry_ts: 0,
          exit_ts: 100 * DAY,
          size_usd: 500,
          realized_pnl: 0,
        }),
      ],
      0,
      200 * DAY,
    );
    expect(p.avgOccupiedUsd).toBeCloseTo(250);
    expect(p.recommendedUsd).toBe(500);
    expect(p.utilization).toBeCloseTo(0.5);
  });

  it("open 仓占用至今不释放:平均占用把持有段全计入", () => {
    const p = plan(
      [
        pos({
          entry_ts: 5 * DAY,
          size_usd: 500,
          status: "open",
          exit_ts: null,
          exit_price: null,
          realized_pnl: null,
        }),
      ],
      0,
      10 * DAY,
    );
    expect(p.avgOccupiedUsd).toBeCloseTo(250); // [5d,10d] 占用 / 10d 窗口
  });

  it("年化护栏:运行不足 1 天 / 无结算接住仓 → 该档年化 null", () => {
    const shortWin = plan(
      [pos({ entry_ts: 0, exit_ts: 1800, size_usd: 500, realized_pnl: 100 })],
      0,
      3600,
    );
    for (const r of shortWin.rows) expect(r.annualizedRoi).toBeNull();

    const openOnly = plan(
      [
        pos({
          entry_ts: 0,
          size_usd: 500,
          status: "open",
          exit_ts: null,
          exit_price: null,
          realized_pnl: null,
        }),
      ],
      0,
      30 * DAY,
    );
    for (const r of openOnly.rows) expect(r.annualizedRoi).toBeNull();
    expect(openOnly.annualizedOnRecommended).toBeNull();
  });

  it("峰值档年化 = (落袋 ÷ 峰值) × 365/运行天数,与 fund.annualizedRoi 同口径", () => {
    const positions = [
      pos({ entry_ts: 0, exit_ts: DAY, size_usd: 500, realized_pnl: 100 }),
    ];
    const nowSec = 73 * DAY;
    const p = plan(positions, 0, nowSec);
    const f = computeFundMetrics(positions, 0, nowSec);
    expect(p.annualizedOnRecommended).toBeCloseTo(1.0);
    expect(p.annualizedOnRecommended).toBeCloseTo(f.annualizedRoi!);
  });

  it("档位阶梯:0.25/0.5/0.75/1/1.25×峰值,按最小仓量向上取整并去重,滤掉接不住任何一仓的档", () => {
    const p = plan(
      [
        pos({
          condition_id: "a",
          entry_ts: 0,
          exit_ts: 200,
          size_usd: 500,
          realized_pnl: 10,
        }),
        pos({
          condition_id: "b",
          entry_ts: 10,
          exit_ts: 200,
          size_usd: 500,
          realized_pnl: 10,
        }),
        pos({
          condition_id: "c",
          entry_ts: 20,
          exit_ts: 200,
          size_usd: 500,
          realized_pnl: 10,
        }),
        pos({
          condition_id: "d",
          entry_ts: 30,
          exit_ts: 200,
          size_usd: 500,
          realized_pnl: 10,
        }),
      ],
      0,
      30 * DAY,
    );
    // 峰值 2000 → 原始档 [500,1000,1500,2000,2500];全部 ≥ 最小仓量 500,无重复
    expect(p.rows.map((r) => r.accountUsd)).toEqual([
      500, 1000, 1500, 2000, 2500,
    ]);
    // 1.25 冗余档接住数与峰值档一致,但效率更低(闲置拖累可见)
    const rec = p.rows.find((r) => r.accountUsd === 2000)!;
    const buf = p.rows.find((r) => r.accountUsd === 2500)!;
    expect(buf.taken).toBe(rec.taken);
    expect(buf.utilization!).toBeLessThan(rec.utilization!);
  });
});

describe("buildFollowView · account 推演透传", () => {
  const DAY = 86400;
  it("每策略携带 account;recommended 与 fund 峰值一致", () => {
    const { strategies } = buildFollowView(
      [strat({ id: 1, created_at: 0 })],
      [
        pos({
          strategy_id: 1,
          entry_ts: 0,
          exit_ts: DAY,
          size_usd: 500,
          realized_pnl: 100,
        }),
      ],
      {},
      73 * DAY,
    );
    const v = strategies[0];
    expect(v.account.recommendedUsd).toBe(v.fund.maxConcurrentUsd);
    expect(v.account.rows.length).toBeGreaterThan(0);
    expect(v.account.annualizedOnRecommended).toBeCloseTo(1.0);
  });
});

import { parseStrategyForTest } from "./follow";

describe("parseStrategy — source/maxPrice/freshSec 扩展", () => {
  it("向后兼容:无 source 字段 → consensus,且旧字段逐字段不变", () => {
    const old = JSON.stringify({
      minWallets: 3,
      minPerWalletUsd: 10000,
      sizeUsd: 500,
      exitRule: "settlement",
      maxEntryDeviationCents: 10,
    });
    const s = parseStrategyForTest(1, old);
    expect(s).not.toBeNull();
    expect(s!.source).toBe("consensus");
    expect(s!.minWallets).toBe(3);
    expect(s!.minPerWalletUsd).toBe(10000);
    expect(s!.sizeUsd).toBe(500);
    expect(s!.exitRule).toBe("settlement");
    expect(s!.maxEntryDeviationCents).toBe(10);
    // 新字段走默认
    expect(s!.maxPrice).toBe(0.95);
    expect(s!.freshSec).toBe(900);
  });

  it("未知 source → 跳过该策略(返回 null)", () => {
    const s = parseStrategyForTest(
      2,
      JSON.stringify({ source: "accumulate", sizeUsd: 500 }),
    );
    expect(s).toBeNull();
  });

  it("非 consensus 源不再强制要求 minWallets/minPerWalletUsd", () => {
    const s = parseStrategyForTest(
      3,
      JSON.stringify({
        source: "heavy",
        sizeUsd: 500,
        minSingleFillUsd: 50000,
      }),
    );
    expect(s).not.toBeNull();
    expect(s!.source).toBe("heavy");
    expect(s!.minSingleFillUsd).toBe(50000);
  });

  it("consensus 源仍强制要求 minWallets/minPerWalletUsd", () => {
    const s = parseStrategyForTest(
      4,
      JSON.stringify({ source: "consensus", sizeUsd: 500 }),
    );
    expect(s).toBeNull();
  });

  it("maxPrice/freshSec 非法值退默认(只有 >0 的有限数生效)", () => {
    const s = parseStrategyForTest(
      5,
      JSON.stringify({
        minWallets: 2,
        minPerWalletUsd: 5000,
        sizeUsd: 500,
        maxPrice: 0,
        freshSec: -1,
      }),
    );
    expect(s!.maxPrice).toBe(0.95);
    expect(s!.freshSec).toBe(900);
  });

  it("maxPrice > 1 视为非法(价格是 0-1 小数)", () => {
    const s = parseStrategyForTest(
      6,
      JSON.stringify({
        minWallets: 2,
        minPerWalletUsd: 5000,
        sizeUsd: 500,
        maxPrice: 95,
      }),
    );
    expect(s!.maxPrice).toBe(0.95);
  });

  // 「字段缺失」与「字段存在但非法」必须区别对待:前者静默(既有库没有这些
  // 字段,是正常情况),后者留痕(最典型的现实成因是配置手滑,比如把 0-1 小数
  // 的 maxPrice 误写成百分数 —— 而这恰好是这道护栏本该拦住的区间,静默退默认
  // 会让配置错误查无痕迹)。
  it("maxPrice 字段存在但非法(如手滑写成 50)→ console.warn 留痕并注明退默认值", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = parseStrategyForTest(
      7,
      JSON.stringify({
        minWallets: 2,
        minPerWalletUsd: 5000,
        sizeUsd: 500,
        maxPrice: 50,
      }),
    );
    expect(s!.maxPrice).toBe(0.95);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("maxPrice=50"),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("0.95"));
    warnSpy.mockRestore();
  });

  it("freshSec 字段存在但非法(<=0)→ console.warn 留痕并注明退默认值", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = parseStrategyForTest(
      8,
      JSON.stringify({
        minWallets: 2,
        minPerWalletUsd: 5000,
        sizeUsd: 500,
        freshSec: -1,
      }),
    );
    expect(s!.freshSec).toBe(900);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("freshSec=-1"),
    );
    warnSpy.mockRestore();
  });

  it("maxPrice/freshSec 字段缺失(未提供)→ 静默退默认,不留痕", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = parseStrategyForTest(
      9,
      JSON.stringify({ minWallets: 2, minPerWalletUsd: 5000, sizeUsd: 500 }),
    );
    expect(s!.maxPrice).toBe(0.95);
    expect(s!.freshSec).toBe(900);
    // 字段缺失是既有库(两条生产策略)的常态,不该被当成异常留痕 —— 若这里
    // 意外 warn,说明「缺失」和「非法」的判定条件混在了一起。
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
