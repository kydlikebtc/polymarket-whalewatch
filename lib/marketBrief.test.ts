import { describe, it, expect } from "vitest";
import { composeMarketBrief, parseMarketInput } from "./marketBrief";
import type { SmartTag } from "./smartWallets";
import type { Trade } from "./types";

let seq = 0;
const mk = (over: Partial<Trade> = {}): Trade =>
  ({
    transactionHash: `0xtx${seq++}`,
    asset: "tokYes",
    proxyWallet: "0xA",
    side: "BUY",
    size: 20000,
    price: 0.5, // $10k notional by default
    timestamp: 1000,
    title: "M",
    slug: "m-slug",
    eventSlug: "m-event",
    outcome: "Yes",
    outcomeIndex: 0,
    conditionId: "0xc1",
    ...over,
  }) as Trade;

const tag = (over: Partial<SmartTag> = {}): SmartTag => ({
  score: 80,
  winRate: 0.7,
  netPnl: 100_000,
  isWhitelist: false,
  ...over,
});

const smartOf = (...wallets: string[]) =>
  new Map(wallets.map((w) => [w.toLowerCase(), tag()]));

describe("composeMarketBrief", () => {
  it("两个白名单钱包同向 → consensus 分类,smartFlow 按敞口聚合", () => {
    const trades = [
      mk({ proxyWallet: "0xA" }),
      mk({ proxyWallet: "0xB" }),
      mk({ proxyWallet: "0xNOBODY" }), // 非白名单不进 smartFlow
    ];
    const b = composeMarketBrief(trades, smartOf("0xA", "0xB"), "0xc1");
    expect(b.classification.kind).toBe("consensus");
    if (b.classification.kind === "consensus") {
      expect(b.classification.group.outcome).toBe("Yes");
      expect(b.classification.group.walletCount).toBe(2);
    }
    expect(b.smartFlow).toHaveLength(1);
    expect(b.smartFlow[0].outcome).toBe("Yes");
    expect(b.smartFlow[0].totalExposureUsd).toBe(20000);
    expect(b.smartFlow[0].wallets.map((w) => w.wallet).sort()).toEqual([
      "0xa",
      "0xb",
    ]);
  });

  it("对立结果都有聪明钱 → disagreement 分类(与推送/页面同口径互斥)", () => {
    const trades = [
      mk({ proxyWallet: "0xA" }),
      mk({
        proxyWallet: "0xB",
        outcome: "No",
        asset: "tokNo",
        outcomeIndex: 1,
      }),
    ];
    const b = composeMarketBrief(trades, smartOf("0xA", "0xB"), "0xc1");
    expect(b.classification.kind).toBe("disagreement");
  });

  it("等股买卖清零的钱包不进 smartFlow(P0.6 敞口口径)", () => {
    const trades = [
      mk({ proxyWallet: "0xA", price: 0.75 }),
      mk({ proxyWallet: "0xA", side: "SELL", price: 0.25 }),
      mk({ proxyWallet: "0xB" }),
    ];
    const b = composeMarketBrief(trades, smartOf("0xA", "0xB"), "0xc1");
    expect(b.smartFlow[0].wallets.map((w) => w.wallet)).toEqual(["0xb"]);
  });

  it("其他市场的成交被过滤;单钱包不足以成共识 → none", () => {
    const trades = [
      mk({ proxyWallet: "0xA" }),
      mk({ proxyWallet: "0xB", conditionId: "0xOTHER" }),
    ];
    const b = composeMarketBrief(trades, smartOf("0xA", "0xB"), "0xc1");
    expect(b.classification.kind).toBe("none");
    expect(b.smartFlow[0].wallets).toHaveLength(1);
  });

  it("拆单累计只保留本市场且按敞口排序", () => {
    const split = (w: string, cid: string) => [
      mk({ proxyWallet: w, conditionId: cid, size: 8000, price: 0.5 }),
      mk({ proxyWallet: w, conditionId: cid, size: 8000, price: 0.5 }),
      mk({ proxyWallet: w, conditionId: cid, size: 8000, price: 0.5 }),
    ];
    const trades = [...split("0xS1", "0xc1"), ...split("0xS2", "0xOTHER")];
    const b = composeMarketBrief(trades, new Map(), "0xc1");
    expect(b.accum).toHaveLength(1);
    expect(b.accum[0].wallet).toBe("0xS1");
    expect(b.accum[0].exposureUsd).toBe(12000);
  });
});

// 结算闸门 —— 线上实测的「幽灵敞口」回归。0x6d20…a165 在 Iron Wing vs
// BoomBoys(0xbee7d5…)买入 3,339,219 股、卖出 139,219 股,随后在 13:58:00
// 以 REDEEM 一次性赎回 3,200,000 股;Polymarket /positions 返回空,而本卡片
// 报了 $1,829,963 敞口。REDEEM 不是 SELL,永远进不了 PositionAcc,所以
// netShares 会停在结算前的水位不动 —— 靠成交流水永远推不出「已经没有了」。
// 唯一诚实的答案是拿市场自己的结算事实当闸门。
describe("composeMarketBrief · 结算闸门", () => {
  it("已结算市场:留存敞口全部归零,settled 置位", () => {
    const trades = [mk({ proxyWallet: "0xA" }), mk({ proxyWallet: "0xB" })];
    const b = composeMarketBrief(trades, smartOf("0xA", "0xB"), "0xc1", {
      settled: true,
    });
    expect(b.settled).toBe(true);
    expect(b.smartFlow[0].totalExposureUsd).toBe(0);
    expect(b.smartFlow[0].wallets.every((w) => w.exposureUsd === 0)).toBe(true);
  });

  it("已结算:净股数与买入均价照旧保留(卡片仍是一本可复盘的台账)", () => {
    const trades = [mk({ proxyWallet: "0xA", size: 20000, price: 0.6 })];
    const b = composeMarketBrief(trades, smartOf("0xA"), "0xc1", {
      settled: true,
    });
    const w = b.smartFlow[0].wallets[0];
    expect(w.netShares).toBe(20000);
    expect(w.avgBuyPrice).toBeCloseTo(0.6, 10);
    expect(w.exposureUsd).toBe(0);
  });

  it("已结算:敞口归零后仍按净股数排序(大押注在前,不退化成插入序)", () => {
    const trades = [
      mk({ proxyWallet: "0xSMALL", size: 20000, price: 0.5 }),
      mk({ proxyWallet: "0xBIG", size: 90000, price: 0.5 }),
    ];
    const b = composeMarketBrief(trades, smartOf("0xSMALL", "0xBIG"), "0xc1", {
      settled: true,
    });
    expect(b.smartFlow[0].wallets.map((w) => w.wallet)).toEqual([
      "0xbig",
      "0xsmall",
    ]);
  });

  it("未结算(默认)口径完全不变 —— 回归护栏", () => {
    const trades = [mk({ proxyWallet: "0xA" }), mk({ proxyWallet: "0xB" })];
    const open = composeMarketBrief(trades, smartOf("0xA", "0xB"), "0xc1");
    expect(open.settled).toBe(false);
    expect(open.smartFlow[0].totalExposureUsd).toBe(20000);
    expect(
      composeMarketBrief(trades, smartOf("0xA", "0xB"), "0xc1", {
        settled: false,
      }).smartFlow[0].totalExposureUsd,
    ).toBe(20000);
  });

  it("合计在截断前算 —— 一边超过 8 个聪明钱时表头不得少算", () => {
    // 10 个钱包 > MAX_WALLETS_PER_OUTCOME(8):wallets 只留 8 行,
    // 但 totalNetShares / totalExposureUsd 必须是全部 10 个的和。
    const trades = Array.from({ length: 10 }, (_, i) =>
      mk({ proxyWallet: `0xW${i}`, size: 10_000, price: 0.5 }),
    );
    const wallets = Array.from({ length: 10 }, (_, i) => `0xW${i}`);
    const open = composeMarketBrief(trades, smartOf(...wallets), "0xc1");
    expect(open.smartFlow[0].wallets).toHaveLength(8); // 展示截断
    expect(open.smartFlow[0].totalNetShares).toBe(100_000); // 合计不截断
    expect(open.smartFlow[0].totalExposureUsd).toBe(50_000);

    const settled = composeMarketBrief(trades, smartOf(...wallets), "0xc1", {
      settled: true,
    });
    expect(settled.smartFlow[0].totalNetShares).toBe(100_000);
    expect(settled.smartFlow[0].totalExposureUsd).toBe(0);
  });

  it("已结算不动「净买入」分类 —— 窗口流量在结算后依然是事实", () => {
    const trades = [mk({ proxyWallet: "0xA" }), mk({ proxyWallet: "0xB" })];
    const b = composeMarketBrief(trades, smartOf("0xA", "0xB"), "0xc1", {
      settled: true,
    });
    expect(b.classification.kind).toBe("consensus");
  });
});

describe("parseMarketInput", () => {
  it("66 位 0x 开头 → conditionId 直达", () => {
    const cid = `0x${"a".repeat(64)}`;
    expect(parseMarketInput(cid)).toEqual({ kind: "cid", value: cid });
  });
  it("polymarket URL → 取路径末段作 slug(去查询串)", () => {
    expect(
      parseMarketInput(
        "https://polymarket.com/event/fed-september-2026?tid=123",
      ),
    ).toEqual({ kind: "slug", value: "fed-september-2026" });
  });
  it("裸 slug 原样返回;空输入报 null", () => {
    expect(parseMarketInput("fed-september-2026")).toEqual({
      kind: "slug",
      value: "fed-september-2026",
    });
    expect(parseMarketInput("   ")).toBeNull();
  });
});
