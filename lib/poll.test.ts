import { it, expect } from "vitest";
import { selectNewTrades } from "./poll";
const mk = (h: string, ts: number) =>
  ({
    transactionHash: h,
    asset: "a",
    proxyWallet: "w",
    side: "BUY",
    size: 1,
    price: 1,
    timestamp: ts,
  }) as any;
it("returns only unseen trades, oldest first", () => {
  const fetched = [mk("0x3", 30), mk("0x1", 10), mk("0x2", 20)];
  const seen = new Set(["0x2:a:w:BUY:1"]);
  const out = selectNewTrades(fetched, (k) => seen.has(k));
  expect(out.map((t) => t.transactionHash)).toEqual(["0x1", "0x3"]);
});
