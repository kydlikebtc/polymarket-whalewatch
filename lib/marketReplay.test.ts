import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import { collectReplayMarkers, replayRange } from "./marketReplay";

// 时光机(第二梯队八件套):任一市场重建「价格曲线 × 本站告警 × 结算」时间线。
// 标记价格统一到 outcomeIndex 0 的坐标:二元市场 index 1 按 1−p 精确映射;
// 多结果市场只保留 index 0 并由调用方声明局限。

const T0 = 1_700_000_000;
const CID = "0x" + "c".repeat(64);
let seq = 0;

function seedAlert(db: DB, type: string, payload: Record<string, unknown>) {
  seq++;
  db.prepare(
    "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES (?, ?, ?, ?)",
  ).run(type, `k${seq}`, JSON.stringify(payload), T0 + seq);
}

describe("collectReplayMarkers", () => {
  it("单笔(large/smart)按成交时刻;组类(consensus/cohort)按 lastTs;其它市场不进", () => {
    const db = openDb(":memory:");
    seedAlert(db, "smart", {
      proxyWallet: "0xw",
      side: "BUY",
      price: 0.4,
      size: 25_000,
      timestamp: T0 + 100,
      conditionId: CID,
      outcomeIndex: 0,
      outcome: "Yes",
    });
    seedAlert(db, "consensus", {
      conditionId: CID,
      outcome: "Yes",
      outcomeIndex: 0,
      avgBuyPrice: 0.45,
      totalNetUsd: 30_000,
      lastTs: T0 + 200,
      wallets: [],
    });
    seedAlert(db, "large", {
      proxyWallet: "0xw",
      side: "SELL",
      price: 0.5,
      size: 30_000,
      timestamp: T0 + 300,
      conditionId: "0x" + "d".repeat(64),
      outcomeIndex: 0,
      outcome: "Yes",
    });
    const ms = collectReplayMarkers(db, CID, { nowSec: T0 + 1000 });
    expect(ms.length).toBe(2);
    expect(ms.map((m) => m.type)).toEqual(["smart", "consensus"]);
    expect(ms[0].ts).toBe(T0 + 100);
    expect(ms[1].ts).toBe(T0 + 200);
    expect(ms[0].price).toBeCloseTo(0.4);
    expect(ms[1].usd).toBeCloseTo(30_000);
  });

  it("二元市场 index 1 的价格按 1−p 映到 index 0 坐标并标记 mapped", () => {
    const db = openDb(":memory:");
    seedAlert(db, "smart", {
      proxyWallet: "0xw",
      side: "BUY",
      price: 0.3,
      size: 25_000,
      timestamp: T0 + 100,
      conditionId: CID,
      outcomeIndex: 1,
      outcome: "No",
    });
    const ms = collectReplayMarkers(db, CID, {
      nowSec: T0 + 1000,
      outcomeCount: 2,
    });
    expect(ms.length).toBe(1);
    expect(ms[0].price).toBeCloseTo(0.7);
    expect(ms[0].mappedFromOtherSide).toBe(true);
  });

  it("多结果市场只保留 index 0(复数结果没有 1−p 等价,不硬造)", () => {
    const db = openDb(":memory:");
    seedAlert(db, "smart", {
      proxyWallet: "0xw",
      side: "BUY",
      price: 0.3,
      size: 25_000,
      timestamp: T0 + 100,
      conditionId: CID,
      outcomeIndex: 2,
      outcome: "C",
    });
    const ms = collectReplayMarkers(db, CID, {
      nowSec: T0 + 1000,
      outcomeCount: 3,
    });
    expect(ms).toEqual([]);
  });
});

describe("replayRange", () => {
  it("有告警:首告警前推 4h;无告警:近 48h。收盘市场截到结算后 2h", () => {
    const now = T0 + 100_000;
    const withAlerts = replayRange([{ ts: T0 + 10_000 }], now, {
      closed: false,
      endDateSec: null,
    });
    expect(withAlerts.startTs).toBe(T0 + 10_000 - 4 * 3600);
    expect(withAlerts.endTs).toBe(now);

    const empty = replayRange([], now, { closed: false, endDateSec: null });
    expect(empty.startTs).toBe(now - 48 * 3600);

    const closed = replayRange([{ ts: T0 }], now, {
      closed: true,
      endDateSec: T0 + 20_000,
    });
    expect(closed.endTs).toBe(T0 + 20_000 + 2 * 3600);
  });
});
