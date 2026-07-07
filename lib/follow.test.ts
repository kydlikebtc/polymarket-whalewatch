import { describe, it, expect } from "vitest";
import {
  positionShares,
  positionRealizedPnl,
  positionSlippage,
  qualifyingGroups,
  latestPriceByAsset,
} from "./follow";
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
