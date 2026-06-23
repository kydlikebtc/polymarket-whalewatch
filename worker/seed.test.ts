import { describe, it, expect, vi } from "vitest";
import { openDb } from "../lib/db";
import { seedSeen, runOnce } from "./runOnce";
import { dedupKey } from "../lib/trades";
import { hasSeen } from "../lib/seen";

const mk = (h: string, ts = 100) =>
  ({
    transactionHash: h,
    asset: "a",
    proxyWallet: "w",
    side: "BUY",
    size: 100000,
    price: 0.5,
    timestamp: ts,
    title: "M",
    slug: "s",
    eventSlug: "e",
    outcome: "Yes",
    outcomeIndex: 0,
    conditionId: "0xc",
  }) as any;

describe("seedSeen (cold-start)", () => {
  it("marks all current trades seen WITHOUT sending, then runOnce alerts none of them", async () => {
    const db = openDb(":memory:");
    const t1 = mk("0x1");
    const t2 = mk("0x2");

    const seeded = await seedSeen({ db, fetchTrades: async () => [t1, t2] });
    expect(seeded).toBe(2);
    expect(hasSeen(db, dedupKey(t1))).toBe(true);
    expect(hasSeen(db, dedupKey(t2))).toBe(true);

    const send = vi.fn().mockResolvedValue(undefined);
    await runOnce({
      db,
      send,
      fetchTrades: async () => [t1, t2],
      thresholds: [10000],
    });
    expect(send).not.toHaveBeenCalled();

    // a genuinely new trade after the cold-start seed still alerts
    const t3 = mk("0x3");
    await runOnce({
      db,
      send,
      fetchTrades: async () => [t1, t2, t3],
      thresholds: [10000],
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not double-seed already-seen trades", async () => {
    const db = openDb(":memory:");
    const t1 = mk("0x1");
    expect(await seedSeen({ db, fetchTrades: async () => [t1] })).toBe(1);
    expect(await seedSeen({ db, fetchTrades: async () => [t1] })).toBe(0);
  });
});
