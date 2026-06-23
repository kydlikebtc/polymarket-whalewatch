import { describe, it, expect } from "vitest";
import { notionalUsd, dedupKey } from "./trades";
const t = {
  transactionHash: "0xabc",
  asset: "123",
  proxyWallet: "0xWALLET",
  side: "BUY",
  size: 43895.83,
  price: 0.999,
} as any;
describe("trades", () => {
  it("computes USD notional as size*price", () => {
    expect(Math.round(notionalUsd(t))).toBe(43852);
  });
  it("builds a composite dedup key", () => {
    expect(dedupKey(t)).toBe("0xabc:123:0xWALLET:BUY:43895.83");
  });
});
