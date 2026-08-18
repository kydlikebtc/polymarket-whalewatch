import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import {
  DEFAULT_X_DAILY_CAPS,
  DEFAULT_X_KINDS,
  X_KINDS,
  getXDailyCaps,
  getXDeliveryChannel,
  getXKindSwitches,
  getXPostHistory,
  setXDailyCaps,
  setXDeliveryChannel,
  setXKindSwitches,
} from "./xSettings";

const NOW = Math.floor(Date.UTC(2026, 7, 17, 12) / 1000);

function insertPost(
  db: DB,
  o: {
    kind: string;
    dedup: string;
    status: string;
    cost?: number;
    ts?: number;
    xid?: string | null;
  },
) {
  db.prepare(
    `INSERT INTO x_posts (kind, dedup_key, text, est_cost_usd, status, x_post_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.kind,
    o.dedup,
    `post ${o.dedup}`,
    o.cost ?? 0.015,
    o.status,
    o.xid ?? null,
    o.ts ?? NOW,
  );
}

describe("X_KINDS", () => {
  it("四类内容与默认开关一一对应(UI 靠它渲染,漏一类=该类永远关不掉)", () => {
    expect(X_KINDS.map((k) => k.kind).sort()).toEqual(
      Object.keys(DEFAULT_X_KINDS).sort(),
    );
    for (const k of X_KINDS) {
      expect(k.label.length).toBeGreaterThan(0);
      expect(k.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("getXKindSwitches", () => {
  it("未配置时四类全开(升级到本版本的部署不该突然变哑)", () => {
    expect(getXKindSwitches(openDb(":memory:"))).toEqual(DEFAULT_X_KINDS);
  });

  it("往返读写", () => {
    const db = openDb(":memory:");
    setXKindSwitches(db, { ...DEFAULT_X_KINDS, whale: false, pregame: false });
    expect(getXKindSwitches(db)).toEqual({
      whale: false,
      consensus: true,
      pregame: false,
      weekly: true,
    });
  });

  it("坏 JSON / 非布尔值一律回落默认(坏配置不能变成意外静默)", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('x_broadcast_kinds', 'not-json{')",
    ).run();
    expect(getXKindSwitches(db)).toEqual(DEFAULT_X_KINDS);
    db.prepare(
      `INSERT OR REPLACE INTO config (key, value)
       VALUES ('x_broadcast_kinds', '{"whale":"false","consensus":null,"weekly":false}')`,
    ).run();
    // 字符串 "false" 与 null 都不是布尔 → 保持默认 true;真布尔 false 生效。
    expect(getXKindSwitches(db)).toEqual({
      whale: true,
      consensus: true,
      pregame: true,
      weekly: false,
    });
  });

  it("真实变更才写 config_history(重复保存不该污染变更日志)", () => {
    const db = openDb(":memory:");
    const n = () =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM config_history WHERE key = 'x_broadcast_kinds'",
          )
          .get() as { n: number }
      ).n;
    const off = { ...DEFAULT_X_KINDS, whale: false };
    setXKindSwitches(db, off);
    expect(n()).toBe(1);
    setXKindSwitches(db, off); // 同值重存
    expect(n()).toBe(1);
    setXKindSwitches(db, DEFAULT_X_KINDS);
    expect(n()).toBe(2);
  });
});

describe("getXPostHistory", () => {
  it("按时间倒序返回,带 x_post_id 与成本", () => {
    const db = openDb(":memory:");
    insertPost(db, {
      kind: "whale",
      dedup: "a",
      status: "posted",
      ts: NOW - 300,
      xid: "x1",
    });
    insertPost(db, {
      kind: "consensus",
      dedup: "b",
      status: "posted",
      ts: NOW - 100,
      xid: "x2",
    });
    const h = getXPostHistory(db, NOW);
    expect(h.posts.map((p) => p.kind)).toEqual(["consensus", "whale"]);
    expect(h.posts[0]).toMatchObject({ xPostId: "x2", costUsd: 0.015 });
  });

  it("本月花费与熔断同口径:claimed+posted 计入,skipped/failed 不计", () => {
    const db = openDb(":memory:");
    insertPost(db, {
      kind: "whale",
      dedup: "a",
      status: "posted",
      cost: 0.015,
    });
    insertPost(db, {
      kind: "whale",
      dedup: "b",
      status: "claimed",
      cost: 0.015,
    });
    insertPost(db, {
      kind: "whale",
      dedup: "c",
      status: "skipped",
      cost: 0.015,
    });
    insertPost(db, {
      kind: "whale",
      dedup: "d",
      status: "failed",
      cost: 0.015,
    });
    // 上个 UTC 月的行不计入本月
    insertPost(db, {
      kind: "weekly",
      dedup: "old",
      status: "posted",
      cost: 0.2,
      ts: Math.floor(Date.UTC(2026, 7, 1) / 1000) - 1,
    });
    const h = getXPostHistory(db, NOW);
    expect(h.spentThisMonthUsd).toBeCloseTo(0.03, 10);
    expect(h.counts).toEqual({ posted: 2, claimed: 1, skipped: 1, failed: 1 });
  });

  it("limit 生效(历史表会一直长,UI 只要最近一屏)", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 10; i++) {
      insertPost(db, {
        kind: "whale",
        dedup: `k${i}`,
        status: "posted",
        ts: NOW - i,
      });
    }
    expect(getXPostHistory(db, NOW, 3).posts).toHaveLength(3);
  });

  it("空库不炸", () => {
    const h = getXPostHistory(openDb(":memory:"), NOW);
    expect(h).toEqual({ posts: [], spentThisMonthUsd: 0, counts: {} });
  });
});

describe("发帖通道开关", () => {
  it("默认 api —— 升级不该改变既有部署的行为", () => {
    expect(getXDeliveryChannel(openDb(":memory:"))).toBe("api");
  });
  it("能设成 extension 并读回", () => {
    const db = openDb(":memory:");
    setXDeliveryChannel(db, "extension");
    expect(getXDeliveryChannel(db)).toBe("extension");
  });
  it("坏值降级回 api,不静默变哑", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "x_delivery_channel",
      "banana",
    );
    expect(getXDeliveryChannel(db)).toBe("api");
  });
  it("真实变更才写 config_history(与 kinds 同一条审计纪律)", () => {
    const db = openDb(":memory:");
    setXDeliveryChannel(db, "extension");
    setXDeliveryChannel(db, "extension");
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM config_history WHERE key = ?")
      .get("x_delivery_channel") as { n: number };
    expect(n.n).toBe(1);
  });
});

describe("插件通道日上限", () => {
  it("默认 whale 100 / pregame 6", () => {
    expect(getXDailyCaps(openDb(":memory:"))).toEqual(DEFAULT_X_DAILY_CAPS);
    expect(DEFAULT_X_DAILY_CAPS).toEqual({ whale: 100, pregame: 6 });
  });
  it("能设并读回", () => {
    const db = openDb(":memory:");
    setXDailyCaps(db, { whale: 42, pregame: 9 });
    expect(getXDailyCaps(db)).toEqual({ whale: 42, pregame: 9 });
  });
  it("逐键校验:非正整数回落默认,好键不受坏键连累", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "x_daily_caps",
      JSON.stringify({ whale: -3, pregame: 20 }),
    );
    expect(getXDailyCaps(db)).toEqual({ whale: 100, pregame: 20 });
  });
  it("坏 JSON 整体回落默认", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "x_daily_caps",
      "{ not json",
    );
    expect(getXDailyCaps(db)).toEqual(DEFAULT_X_DAILY_CAPS);
  });
});
