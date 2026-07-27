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
