import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import { walletPriceImpact } from "./priceImpact";

// 价格影响持久性(第二梯队八件套):某钱包的告警落地后,市场初动(10m)有没有
// 被 24h 走势留住 —— 「被市场相信程度」。描述统计,非策略信号;聚簇区间按
// 市场(同市场多条告警共享一次行情演化)。

const T0 = 1_700_000_000;
const W = "0xabcdef0123456789abcdef0123456789abcdef01";
let seq = 0;

function insertGraded(
  db: DB,
  over: {
    type?: string;
    cid?: string;
    price?: number;
    side?: string;
    price10m?: number | null;
    price24h?: number | null;
    wallet?: string;
    consensusMembers?: { wallet: string; avgBuyPrice: number }[];
  } = {},
): number {
  seq++;
  const type = over.type ?? "smart";
  const payload: Record<string, unknown> = over.consensusMembers
    ? {
        conditionId: over.cid ?? `0xc${seq}`,
        outcome: "Yes",
        asset: "tok",
        outcomeIndex: 0,
        avgBuyPrice: over.price ?? 0.5,
        lastTs: T0,
        wallets: over.consensusMembers.map((m) => ({
          wallet: m.wallet,
          netUsd: 5000,
          buyCount: 1,
          avgBuyPrice: m.avgBuyPrice,
          score: null,
          winRate: null,
          qualifiedTs: T0,
        })),
      }
    : {
        proxyWallet: over.wallet ?? W,
        side: over.side ?? "BUY",
        asset: "tok",
        conditionId: over.cid ?? `0xc${seq}`,
        size: 10_000,
        price: over.price ?? 0.5,
        timestamp: T0,
        title: "M",
        slug: "m",
        eventSlug: "e",
        outcome: "Yes",
        outcomeIndex: 0,
        transactionHash: `h${seq}`,
      };
  const r = db
    .prepare(
      "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(type, `k${seq}`, JSON.stringify(payload), T0);
  const id = Number(r.lastInsertRowid);
  db.prepare(
    `INSERT INTO alert_outcomes (alert_id, price_10m, price_24h, resolved, checked_at)
     VALUES (?, ?, ?, 1, ?)`,
  ).run(id, over.price10m ?? null, over.price24h ?? null, T0);
  return id;
}

describe("walletPriceImpact", () => {
  it("市场数 < 8 → insufficient,不给率也不给判词以外的结论", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 3; i++) {
      insertGraded(db, { price: 0.5, price10m: 0.56, price24h: 0.58 });
    }
    const r = walletPriceImpact(db, W, { nowSec: T0 + 1000 });
    expect(r.verdict).toBe("insufficient");
    expect(r.markets).toBe(3);
    expect(r.rate).toBeNull();
  });

  it("初动全被留住(10 市场,+6¢ → +8¢)→ followed,聚簇区间下界 > 0.5", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 10; i++) {
      insertGraded(db, { price: 0.5, price10m: 0.56, price24h: 0.58 });
    }
    const r = walletPriceImpact(db, W, { nowSec: T0 + 1000 });
    expect(r.measured).toBe(10);
    expect(r.retained).toBe(10);
    expect(r.rate).toBe(1);
    expect(r.verdict).toBe("followed");
    expect(r.medImpactCents).toBeCloseTo(6);
    expect(r.med24hCents).toBeCloseTo(8);
  });

  it("初动全被回吐(+6¢ → +1¢,不足一半)→ faded", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 10; i++) {
      insertGraded(db, { price: 0.5, price10m: 0.56, price24h: 0.51 });
    }
    const r = walletPriceImpact(db, W, { nowSec: T0 + 1000 });
    expect(r.retained).toBe(0);
    expect(r.verdict).toBe("faded");
  });

  it("SELL 方向化:入场 0.6、10m 0.54 是 +6¢ 顺势初动", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 10; i++) {
      insertGraded(db, {
        side: "SELL",
        price: 0.6,
        price10m: 0.54,
        price24h: 0.5,
      });
    }
    const r = walletPriceImpact(db, W, { nowSec: T0 + 1000 });
    expect(r.measured).toBe(10);
    expect(r.verdict).toBe("followed");
  });

  it("初动 < 2¢ 不计入可测(噪声不进留存率分母);24h 缺失同样不计", () => {
    const db = openDb(":memory:");
    insertGraded(db, { price: 0.5, price10m: 0.51, price24h: 0.6 }); // +1¢
    insertGraded(db, { price: 0.5, price10m: 0.56, price24h: null }); // 无 24h
    const r = walletPriceImpact(db, W, { nowSec: T0 + 1000 });
    expect(r.measured).toBe(0);
    expect(r.verdict).toBe("insufficient");
  });

  it("consensus 成员展开:p0 用成员自己的 avgBuyPrice(记分卡同款),他人的告警不算", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 10; i++) {
      insertGraded(db, {
        type: "consensus",
        consensusMembers: [
          { wallet: W, avgBuyPrice: 0.4 },
          { wallet: "0xother", avgBuyPrice: 0.9 },
        ],
        price10m: 0.46,
        price24h: 0.48,
      });
    }
    const r = walletPriceImpact(db, W, { nowSec: T0 + 1000 });
    expect(r.measured).toBe(10);
    expect(r.medImpactCents).toBeCloseTo(6); // 0.46−0.40,不是 0.46−0.90
    expect(r.verdict).toBe("followed");
  });

  it("同市场多条折进聚簇分母:20 行 2 市场 → markets=2 → insufficient", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 20; i++) {
      insertGraded(db, {
        cid: i % 2 === 0 ? "0xm1" : "0xm2",
        price: 0.5,
        price10m: 0.56,
        price24h: 0.58,
      });
    }
    const r = walletPriceImpact(db, W, { nowSec: T0 + 1000 });
    expect(r.measured).toBe(20);
    expect(r.markets).toBe(2);
    expect(r.verdict).toBe("insufficient");
  });
});
