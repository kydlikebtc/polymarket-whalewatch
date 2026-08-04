import { describe, expect, it } from "vitest";
import { openDb, type DB } from "./db";
import { buildSignalFeed, HEAVY_MIN_USD } from "./signalFeed";

const NOW = 1_785_000_000;
const H = 3600;

let seq = 0;
function insert(
  db: DB,
  type: string,
  payload: Record<string, unknown>,
  createdAt: number,
  outcome?: { won: number | null; checkedAt?: number },
): number {
  const r = db
    .prepare(
      "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(type, `k${seq++}`, JSON.stringify(payload), createdAt);
  const id = Number(r.lastInsertRowid);
  if (outcome) {
    db.prepare(
      "INSERT INTO alert_outcomes (alert_id, resolved, won, checked_at) VALUES (?, 1, ?, ?)",
    ).run(id, outcome.won, outcome.checkedAt ?? createdAt);
  }
  return id;
}

function consensus(over: Record<string, unknown> = {}) {
  return {
    conditionId: "0xaaa",
    outcome: "Yes",
    title: "Market A",
    eventSlug: "evt-a",
    outcomeIndex: 0,
    asset: "tok1",
    walletCount: 3,
    totalNetUsd: 169830,
    avgBuyPrice: 0.61,
    firstTs: NOW - 2 * H,
    wallets: [
      { wallet: "0xW1", netUsd: 121400, avgBuyPrice: 0.6 },
      { wallet: "0xW2", netUsd: 48430, avgBuyPrice: 0.62 },
    ],
    ...over,
  };
}

function smart(over: Record<string, unknown> = {}) {
  return {
    conditionId: "0xbbb",
    outcome: "Orioles",
    title: "MLB game",
    eventSlug: "evt-b",
    outcomeIndex: 1,
    asset: "tok2",
    proxyWallet: "0xHEAVY",
    side: "BUY",
    size: 200_000,
    price: 0.4, // notional $80k
    ...over,
  };
}

describe("buildSignalFeed · 折叠与分类", () => {
  it("共识按 市场×方向 折叠，多条升级只出一张卡且保留最初形成时间", () => {
    const db = openDb(":memory:");
    insert(db, "consensus", consensus({ totalNetUsd: 50000 }), NOW - 2 * H);
    insert(db, "consensus", consensus({ totalNetUsd: 169830 }), NOW - 1 * H);
    const feed = buildSignalFeed(db, { nowSec: NOW });
    expect(feed.active).toHaveLength(1);
    expect(feed.active[0].kind).toBe("consensus");
    // 最新总额，但最初形成时刻 —— 交易者用它判断信号新鲜度
    expect(feed.active[0].netUsd).toBe(169830);
    expect(feed.active[0].formationTs).toBe(NOW - 2 * H);
  });

  it("同市场两个方向都有共识 → 合并成一张 split 卡，且不给方向", () => {
    const db = openDb(":memory:");
    insert(
      db,
      "consensus",
      consensus({ outcome: "A", totalNetUsd: 94400, avgBuyPrice: 0.43 }),
      NOW - 2 * H,
    );
    insert(
      db,
      "consensus",
      consensus({ outcome: "B", totalNetUsd: 10918, avgBuyPrice: 0.58 }),
      NOW - 1 * H,
    );
    const feed = buildSignalFeed(db, { nowSec: NOW });
    expect(feed.active).toHaveLength(1);
    const s = feed.active[0];
    expect(s.kind).toBe("split");
    // 拆成两行会让「聪明钱看好 A」紧接「聪明钱看好 B」，整页可信度当场崩塌。
    expect(s.outcome).toBeNull();
    expect(s.sides).toHaveLength(2);
    // 两侧都保留，金额大的在前
    expect(s.sides!.map((x) => x.outcome)).toEqual(["A", "B"]);
    expect(s.sides![0].netUsd).toBe(94400);
    expect(s.netUsd).toBe(94400 + 10918);
  });

  it("单钱包 ≥$50k 成为 heavy；低于门槛的不进 feed", () => {
    const db = openDb(":memory:");
    insert(db, "smart", smart({ size: 200_000, price: 0.4 }), NOW - H); // $80k
    insert(
      db,
      "smart",
      smart({ conditionId: "0xccc", outcome: "X", size: 100_000, price: 0.4 }),
      NOW - H,
    ); // $40k
    const feed = buildSignalFeed(db, { nowSec: NOW });
    expect(feed.active).toHaveLength(1);
    expect(feed.active[0].kind).toBe("heavy");
    expect(feed.active[0].netUsd).toBe(80_000);
    expect(HEAVY_MIN_USD).toBe(50_000);
  });

  it("同一 市场×方向 已有共识时，heavy 被抑制（一个市场不占两张卡）", () => {
    const db = openDb(":memory:");
    insert(db, "consensus", consensus(), NOW - 2 * H);
    insert(
      db,
      "smart",
      smart({
        conditionId: "0xaaa",
        outcome: "Yes",
        size: 500_000,
        price: 0.6,
      }),
      NOW - H,
    );
    const feed = buildSignalFeed(db, { nowSec: NOW });
    expect(feed.active).toHaveLength(1);
    expect(feed.active[0].kind).toBe("consensus");
  });

  it("同 市场×方向 的多笔 heavy 只留最大的一笔", () => {
    const db = openDb(":memory:");
    insert(db, "smart", smart({ size: 200_000, price: 0.4 }), NOW - 2 * H); // 80k
    insert(db, "smart", smart({ size: 400_000, price: 0.4 }), NOW - H); // 160k
    const feed = buildSignalFeed(db, { nowSec: NOW });
    expect(feed.active).toHaveLength(1);
    expect(feed.active[0].netUsd).toBe(160_000);
  });

  it("SELL 不构成 heavy 信号", () => {
    const db = openDb(":memory:");
    insert(
      db,
      "smart",
      smart({ side: "SELL", size: 500_000, price: 0.4 }),
      NOW - H,
    );
    expect(buildSignalFeed(db, { nowSec: NOW }).active).toHaveLength(0);
  });

  it("窗口外的信号不出现", () => {
    const db = openDb(":memory:");
    insert(db, "consensus", consensus(), NOW - 30 * H);
    expect(buildSignalFeed(db, { nowSec: NOW }).active).toHaveLength(0);
    expect(
      buildSignalFeed(db, { nowSec: NOW, windowHours: 48 }).active,
    ).toHaveLength(1);
  });

  it("按形成时间倒序（新的在前）", () => {
    const db = openDb(":memory:");
    insert(
      db,
      "consensus",
      consensus({ conditionId: "0x1", firstTs: NOW - 5 * H }),
      NOW - 5 * H,
    );
    insert(
      db,
      "consensus",
      consensus({ conditionId: "0x2", firstTs: NOW - 1 * H }),
      NOW - 1 * H,
    );
    const feed = buildSignalFeed(db, { nowSec: NOW });
    expect(feed.active.map((s) => s.conditionId)).toEqual(["0x2", "0x1"]);
  });

  it("附带品类（event_category join）", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO event_category (event_slug, category, fetched_at) VALUES ('evt-a','Politics',0)",
    ).run();
    insert(db, "consensus", consensus(), NOW - H);
    expect(buildSignalFeed(db, { nowSec: NOW }).active[0].category).toBe(
      "Politics",
    );
  });

  it("坏 payload 不会让整个 feed 挂掉", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES ('consensus','bad','{not json', ?)",
    ).run(NOW - H);
    insert(db, "consensus", consensus(), NOW - H);
    expect(buildSignalFeed(db, { nowSec: NOW }).active).toHaveLength(1);
  });
});

describe("buildSignalFeed · 认账区与战绩", () => {
  it("已结算列表给出对错与成交价，同 市场×方向 只取最新一条", () => {
    const db = openDb(":memory:");
    insert(db, "consensus", consensus({ avgBuyPrice: 0.73 }), NOW - 20 * H, {
      won: 1,
      checkedAt: NOW - 10 * H,
    });
    insert(db, "consensus", consensus({ avgBuyPrice: 0.7 }), NOW - 22 * H, {
      won: 0,
      checkedAt: NOW - 20 * H,
    });
    const feed = buildSignalFeed(db, { nowSec: NOW });
    expect(feed.settled).toHaveLength(1);
    expect(feed.settled[0]).toMatchObject({ won: true, entryPrice: 0.73 });
  });

  it("30d 战绩是价格调整口径，与推送尾行同源", () => {
    const db = openDb(":memory:");
    // 4 条 @0.5：市场预期赢 2 次，实际赢 3 次 → 超额 +1
    for (let i = 0; i < 3; i++) {
      insert(
        db,
        "consensus",
        consensus({ conditionId: `0x${i}`, avgBuyPrice: 0.5 }),
        NOW - 5 * H,
        { won: 1 },
      );
    }
    insert(
      db,
      "consensus",
      consensus({ conditionId: "0x9", avgBuyPrice: 0.5 }),
      NOW - 5 * H,
      { won: 0 },
    );
    const r = buildSignalFeed(db, { nowSec: NOW }).record30d;
    expect(r.settled).toBe(4);
    expect(r.wins).toBe(3);
    expect(r.implied).toBeCloseTo(2);
    expect(r.excess).toBeCloseTo(1);
  });

  it("无成交价的行不计入战绩（没有基准就无法评分）", () => {
    const db = openDb(":memory:");
    insert(
      db,
      "consensus",
      { conditionId: "0xz", outcome: "Yes", title: "t" },
      NOW - 5 * H,
      { won: 1 },
    );
    expect(buildSignalFeed(db, { nowSec: NOW }).record30d.settled).toBe(0);
  });
});

describe("buildSignalFeed · 契约", () => {
  it("空库返回结构完整的空 feed，而不是抛错", () => {
    const db = openDb(":memory:");
    const feed = buildSignalFeed(db, { nowSec: NOW });
    expect(feed).toMatchObject({
      windowHours: 24,
      heavyMinUsd: HEAVY_MIN_USD,
      active: [],
      settled: [],
    });
    expect(feed.record30d.settled).toBe(0);
    expect(feed.updatedAt).toBe(NOW);
  });
});

describe("buildSignalFeed · record30d 口径（对外契约）", () => {
  it("SELL 侧 implied 取 1−成交价 —— 卖出信号的市场预期方向相反", () => {
    // 这是 /api/signals 的对外 record30d,消费方(mm-mobile App)直接展示。
    // 10 笔 SELL@0.20 全判赢:市场自己就给了 80% 概率,零优势。
    const db = openDb(":memory:");
    for (let i = 0; i < 10; i++) {
      insert(db, "smart", smart({ side: "SELL", price: 0.2 }), NOW - H, {
        won: 1,
      });
    }
    const r = buildSignalFeed(db, { nowSec: NOW }).record30d;
    expect(r.settled).toBe(10);
    expect(r.wins).toBe(10);
    expect(r.implied).toBeCloseTo(8); // 旧口径:2.0
    expect(r.excess).toBeCloseTo(2); // 旧口径:+8.0
  });

  it("共识升级行折叠 —— 同一次共识只进一次分母", () => {
    const db = openDb(":memory:");
    // 同市场同方向的三条升级行(形成 @0.4,升级 @0.5/@0.6)。
    for (const p of [0.4, 0.5, 0.6]) {
      insert(db, "consensus", consensus({ avgBuyPrice: p }), NOW - 3 * H, {
        won: 1,
      });
    }
    const r = buildSignalFeed(db, { nowSec: NOW }).record30d;
    expect(r.settled).toBe(1);
    expect(r.implied).toBeCloseTo(0.4); // 保留形成时刻那条
  });
});
