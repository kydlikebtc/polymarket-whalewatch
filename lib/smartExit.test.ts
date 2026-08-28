import { describe, it, expect } from "vitest";
import type { SmartTag } from "./smartWallets";
import type { Trade } from "./types";
import { detectSmartExits, DEFAULT_SMART_EXIT } from "./smartExit";

// 聪明钱离场(第二梯队八件套):卖侧镜像 consensus 会计 —— 净卖出股数 ×
// 卖出均价过线的池内非 MM 钱包,同 (市场,结果) 凑满 minWallets 即离场组。
// 窗口局限:窗内只见卖不见此前建仓 —— 「减持老仓」正是要抓的事实。

let seq = 0;
function trade(over: Partial<Trade> = {}): Trade {
  seq++;
  return {
    proxyWallet: "0xA",
    side: "SELL",
    asset: "tok1",
    conditionId: "c1",
    size: 10_000,
    price: 0.6, // $6k
    timestamp: 1000 + seq,
    title: "M",
    slug: "m",
    eventSlug: "e",
    outcome: "Yes",
    outcomeIndex: 0,
    transactionHash: `h${seq}`,
    ...over,
  };
}

function tags(entries: [string, Partial<SmartTag>][]): Map<string, SmartTag> {
  const m = new Map<string, SmartTag>();
  for (const [w, over] of entries) {
    m.set(w.toLowerCase(), {
      score: 80,
      winRate: 0.6,
      realizedPnl: 10_000,
      isWhitelist: true,
      isMarketMaker: false,
      ...over,
    } as SmartTag);
  }
  return m;
}

describe("detectSmartExits", () => {
  it("两个池内钱包各净卖 ≥$5k 同市场同结果 → 一个离场组,字段完整", () => {
    const out = detectSmartExits(
      [
        trade({ proxyWallet: "0xA" }),
        trade({ proxyWallet: "0xB", price: 0.5 }), // $5k
      ],
      tags([
        ["0xa", {}],
        ["0xb", {}],
      ]),
    );
    expect(out.length).toBe(1);
    const g = out[0];
    expect(g.conditionId).toBe("c1");
    expect(g.outcome).toBe("Yes");
    expect(g.walletCount).toBe(2);
    expect(g.totalSoldUsd).toBeCloseTo(11_000);
    expect(g.wallets[0].soldUsd).toBeCloseTo(6_000); // 净额降序
    expect(g.wallets[0].avgSellPrice).toBeCloseTo(0.6);
    expect(g.asset).toBe("tok1");
    expect(g.lastTs).toBeGreaterThan(0);
  });

  it("非池内钱包与 MM 都不计票", () => {
    const out = detectSmartExits(
      [
        trade({ proxyWallet: "0xA" }),
        trade({ proxyWallet: "0xStranger" }),
        trade({ proxyWallet: "0xBot" }),
      ],
      tags([
        ["0xa", {}],
        ["0xbot", { isMarketMaker: true }],
      ]),
    );
    expect(out).toEqual([]);
  });

  it("窗内买回等股的钱包净卖为零 —— 现金流口径的「假卖出」不合格", () => {
    const out = detectSmartExits(
      [
        trade({ proxyWallet: "0xA" }),
        trade({ proxyWallet: "0xA", side: "BUY", size: 10_000, price: 0.55 }),
        trade({ proxyWallet: "0xB" }),
        trade({ proxyWallet: "0xC" }),
      ],
      tags([
        ["0xa", {}],
        ["0xb", {}],
        ["0xc", {}],
      ]),
    );
    expect(out.length).toBe(1);
    expect(out[0].walletCount).toBe(2);
    expect(out[0].wallets.map((w) => w.wallet)).not.toContain("0xa");
  });

  it("逐钱包净卖低于门槛不计票;重复行去重", () => {
    const t1 = trade({ proxyWallet: "0xA", size: 4_000 }); // $2.4k < $5k
    const out = detectSmartExits(
      [t1, { ...t1 }, trade({ proxyWallet: "0xB" })],
      tags([
        ["0xa", {}],
        ["0xb", {}],
      ]),
      DEFAULT_SMART_EXIT,
    );
    expect(out).toEqual([]);
  });

  it("多组按合计卖出降序", () => {
    const out = detectSmartExits(
      [
        trade({ proxyWallet: "0xA", conditionId: "c1" }),
        trade({ proxyWallet: "0xB", conditionId: "c1" }),
        trade({ proxyWallet: "0xA", conditionId: "c2", size: 40_000 }),
        trade({ proxyWallet: "0xB", conditionId: "c2", size: 40_000 }),
      ],
      tags([
        ["0xa", {}],
        ["0xb", {}],
      ]),
    );
    expect(out.map((g) => g.conditionId)).toEqual(["c2", "c1"]);
  });
});
