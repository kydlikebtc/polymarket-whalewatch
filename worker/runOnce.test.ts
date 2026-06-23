import { describe, it, expect, vi } from "vitest";
import { openDb } from "../lib/db";
import { runOnce } from "./runOnce";
it("alerts each new trade once and marks it seen", async () => {
  const db = openDb(":memory:");
  const t = {
    transactionHash: "0xh",
    asset: "a",
    proxyWallet: "w",
    side: "BUY",
    size: 100000,
    price: 0.5,
    timestamp: 100,
    title: "M",
    slug: "s",
    eventSlug: "e",
    outcome: "Yes",
    outcomeIndex: 0,
    conditionId: "0xc",
  } as any;
  const send = vi.fn().mockResolvedValue(undefined);
  await runOnce({
    db,
    send,
    fetchTrades: async () => [t],
    thresholds: [10000, 50000],
  });
  expect(send).toHaveBeenCalledTimes(1);
  await runOnce({
    db,
    send,
    fetchTrades: async () => [t],
    thresholds: [10000, 50000],
  });
  expect(send).toHaveBeenCalledTimes(1);
});
