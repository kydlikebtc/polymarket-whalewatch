import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import {
  DEFAULT_X_KINDS,
  X_KINDS,
  getXKindSwitches,
  getXPostHistogram,
  getXPostHistory,
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
      settled: false,
      pulse: false,
      divergence: false,
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
      settled: false,
      pulse: false,
      divergence: false,
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

describe("getXPostHistogram(天 × UTC 小时 × 类型)", () => {
  it("posted 落进正确的天/小时/类型桶;skipped 与窗外不计;新在前", () => {
    const db = openDb(":memory:");
    // NOW = 2026-08-17 12:00 UTC。
    insertPost(db, { kind: "whale", dedup: "a", status: "posted", ts: NOW });
    insertPost(db, {
      kind: "pregame",
      dedup: "b",
      status: "posted",
      ts: NOW - 5 * 3600, // 同日 07:xx
    });
    insertPost(db, { kind: "whale", dedup: "sk", status: "skipped", ts: NOW });
    insertPost(db, {
      kind: "consensus",
      dedup: "c",
      status: "posted",
      ts: NOW - 13 * 3600, // 昨日 23:00
    });
    insertPost(db, {
      kind: "whale",
      dedup: "old",
      status: "posted",
      ts: NOW - 15 * 86400, // 窗外(>14 天)
    });
    const h = getXPostHistogram(db, NOW);
    expect(h).toHaveLength(14);
    expect(h[0].day).toBe("08-17");
    expect(h[0].total).toBe(2); // skipped 不计
    expect(h[0].hours[12]).toEqual({ whale: 1 });
    expect(h[0].hours[7]).toEqual({ pregame: 1 });
    expect(h[1].day).toBe("08-16");
    expect(h[1].hours[23]).toEqual({ consensus: 1 });
    // 窗外那条不出现在任何桶。
    expect(h.reduce((a, d) => a + d.total, 0)).toBe(3);
  });

  it("空库:14 天全零网格(UI 据此隐藏分布图)", () => {
    const h = getXPostHistogram(openDb(":memory:"), NOW);
    expect(h).toHaveLength(14);
    expect(h.every((d) => d.total === 0)).toBe(true);
  });
});
