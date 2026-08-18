import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import { ackQueued, leaseQueued, queueDepth, reclaimStale } from "./xQueue";

const NOW = Math.floor(Date.UTC(2026, 7, 18, 12) / 1000);

function seedQueued(
  db: DB,
  rows: { kind: string; dedup: string; createdAt?: number }[],
) {
  for (const r of rows) {
    db.prepare(
      `INSERT INTO x_posts (kind, dedup_key, text, has_link, est_cost_usd, status, channel, created_at)
       VALUES (?, ?, ?, 0, 0, 'queued', 'extension', ?)`,
    ).run(r.kind, r.dedup, `text-${r.dedup}`, r.createdAt ?? NOW);
  }
}

function statusOf(db: DB, dedup: string) {
  return db
    .prepare(
      "SELECT status, x_post_id, leased_at FROM x_posts WHERE dedup_key = ?",
    )
    .get(dedup) as {
    status: string;
    x_post_id: string | null;
    leased_at: number | null;
  };
}

describe("leaseQueued", () => {
  it("取走后置 leased 并盖 leased_at,第二次取不到同一条", () => {
    const db = openDb(":memory:");
    seedQueued(db, [{ kind: "whale", dedup: "a" }]);
    expect(
      leaseQueued(db, { limit: 5, nowSec: NOW }).map((p) => p.text),
    ).toEqual(["text-a"]);
    // 租约是锁:同一条不能被第二次取走,否则两个浏览器会各发一遍。
    expect(leaseQueued(db, { limit: 5, nowSec: NOW })).toEqual([]);
    expect(statusOf(db, "a")).toMatchObject({
      status: "leased",
      leased_at: NOW,
    });
  });

  it("独家信号优先:consensus 排在更早入队的 whale 前面", () => {
    const db = openDb(":memory:");
    seedQueued(db, [
      { kind: "whale", dedup: "w", createdAt: NOW },
      { kind: "consensus", dedup: "c", createdAt: NOW + 10 },
    ]);
    // 插件一轮只拉几条,不能让量大的大单流把窗口占满。
    expect(
      leaseQueued(db, { limit: 5, nowSec: NOW }).map((p) => p.kind),
    ).toEqual(["consensus", "whale"]);
  });

  it("同 kind 内按入队时间先进先出", () => {
    const db = openDb(":memory:");
    seedQueued(db, [
      { kind: "whale", dedup: "late", createdAt: NOW + 100 },
      { kind: "whale", dedup: "early", createdAt: NOW },
    ]);
    expect(
      leaseQueued(db, { limit: 5, nowSec: NOW }).map((p) => p.text),
    ).toEqual(["text-early", "text-late"]);
  });

  it("只碰 extension 通道的 queued —— api 通道的 claimed 一行都不能动", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO x_posts (kind, dedup_key, text, has_link, est_cost_usd, status, channel, created_at)
       VALUES ('whale', 'api1', 't', 0, 0.015, 'claimed', 'api', ?)`,
    ).run(NOW);
    expect(leaseQueued(db, { limit: 5, nowSec: NOW })).toEqual([]);
    expect(statusOf(db, "api1").status).toBe("claimed");
  });

  it("limit 生效", () => {
    const db = openDb(":memory:");
    seedQueued(db, [
      { kind: "whale", dedup: "a" },
      { kind: "whale", dedup: "b" },
      { kind: "whale", dedup: "c" },
    ]);
    expect(leaseQueued(db, { limit: 2, nowSec: NOW })).toHaveLength(2);
    expect(queueDepth(db)).toBe(1);
  });

  it("空队列返回空数组,不炸", () => {
    expect(leaseQueued(openDb(":memory:"), { limit: 5, nowSec: NOW })).toEqual(
      [],
    );
  });
});

describe("ackQueued", () => {
  function leaseOne(db: DB) {
    seedQueued(db, [{ kind: "whale", dedup: "a" }]);
    return leaseQueued(db, { limit: 1, nowSec: NOW })[0];
  }

  it("posted 落 x_post_id 并清租约", () => {
    const db = openDb(":memory:");
    const p = leaseOne(db);
    expect(
      ackQueued(db, {
        id: p.id,
        result: "posted",
        xPostId: "1234",
        nowSec: NOW,
      }),
    ).toBe(true);
    expect(statusOf(db, "a")).toEqual({
      status: "posted",
      x_post_id: "1234",
      leased_at: null,
    });
  });

  it("unconfirmed 是独立状态 —— 既不能算成功也不能算失败", () => {
    // 算成功:x_post_id 为空会污染周报统计。算失败:重发 = 重复发帖。
    const db = openDb(":memory:");
    const p = leaseOne(db);
    ackQueued(db, { id: p.id, result: "unconfirmed", nowSec: NOW });
    expect(statusOf(db, "a").status).toBe("posted_unconfirmed");
  });

  it("failed 落终态,队列继续往下走", () => {
    const db = openDb(":memory:");
    const p = leaseOne(db);
    ackQueued(db, { id: p.id, result: "failed", nowSec: NOW });
    expect(statusOf(db, "a").status).toBe("failed");
  });

  it("channel_error 退回 queued 并清 leased_at —— 不烧掉这条帖", () => {
    // 通道级故障(掉登录/DOM 改版)与单帖失败必须分开:按 failed 处理会让
    // 一次故障把整个队列依次标死,且永不重发。
    const db = openDb(":memory:");
    const p = leaseOne(db);
    expect(
      ackQueued(db, { id: p.id, result: "channel_error", nowSec: NOW }),
    ).toBe(true);
    expect(statusOf(db, "a")).toMatchObject({
      status: "queued",
      leased_at: null,
    });
    // 退回后必须能被重新租借
    expect(leaseQueued(db, { limit: 1, nowSec: NOW })).toHaveLength(1);
  });

  it("重复 ack 幂等:返回 false 且不覆盖已定终态", () => {
    // at-least-once 下重复 ack 是正常流量(插件本地补 ack),不是错误。
    const db = openDb(":memory:");
    const p = leaseOne(db);
    ackQueued(db, { id: p.id, result: "posted", xPostId: "1", nowSec: NOW });
    expect(ackQueued(db, { id: p.id, result: "failed", nowSec: NOW })).toBe(
      false,
    );
    expect(statusOf(db, "a")).toMatchObject({
      status: "posted",
      x_post_id: "1",
    });
  });

  it("ack 一个不存在的 id 返回 false,不抛", () => {
    expect(
      ackQueued(openDb(":memory:"), {
        id: 9999,
        result: "posted",
        nowSec: NOW,
      }),
    ).toBe(false);
  });
});

describe("reclaimStale", () => {
  it("leased 超租约 → 退回 queued(插件崩了/标签页被关)", () => {
    const db = openDb(":memory:");
    seedQueued(db, [{ kind: "whale", dedup: "a" }]);
    leaseQueued(db, { limit: 1, nowSec: NOW });
    expect(
      reclaimStale(db, {
        nowSec: NOW + 400,
        queueTtlSec: 7200,
        leaseTtlSec: 300,
      }),
    ).toEqual({ expired: 0, reclaimed: 1 });
    expect(statusOf(db, "a")).toMatchObject({
      status: "queued",
      leased_at: null,
    });
  });

  it("queued 超 TTL → expired,且**留墓碑不删行**", () => {
    // 删行会腾空 (kind, dedup_key) 唯一索引,下一轮同一条 alert 会被重新
    // 入队 —— 「恢复后喷出一堆隔夜旧闻」这个 bug 就是这么来的。
    const db = openDb(":memory:");
    seedQueued(db, [{ kind: "whale", dedup: "a" }]);
    expect(
      reclaimStale(db, {
        nowSec: NOW + 8000,
        queueTtlSec: 7200,
        leaseTtlSec: 300,
      }),
    ).toEqual({ expired: 1, reclaimed: 0 });
    expect(statusOf(db, "a").status).toBe("expired");
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM x_posts").get() as { n: number })
        .n,
    ).toBe(1);
  });

  it("同一轮里租约超时的会先退回,再按入队时间判过期", () => {
    // 顺序很重要:先 reclaim 再 expire,否则一条既超租约又超 TTL 的行会
    // 卡在 leased 上永远收不掉。
    const db = openDb(":memory:");
    seedQueued(db, [{ kind: "whale", dedup: "a" }]);
    leaseQueued(db, { limit: 1, nowSec: NOW });
    expect(
      reclaimStale(db, {
        nowSec: NOW + 9000,
        queueTtlSec: 7200,
        leaseTtlSec: 300,
      }),
    ).toEqual({ expired: 1, reclaimed: 1 });
    expect(statusOf(db, "a").status).toBe("expired");
  });

  it("未超时的一条都不动", () => {
    const db = openDb(":memory:");
    seedQueued(db, [{ kind: "whale", dedup: "a" }]);
    expect(
      reclaimStale(db, {
        nowSec: NOW + 60,
        queueTtlSec: 7200,
        leaseTtlSec: 300,
      }),
    ).toEqual({ expired: 0, reclaimed: 0 });
    expect(statusOf(db, "a").status).toBe("queued");
  });

  it("不碰 api 通道的行(claimed 的孤儿由 api 侧自己的口径管)", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO x_posts (kind, dedup_key, text, has_link, est_cost_usd, status, channel, created_at)
       VALUES ('whale', 'api1', 't', 0, 0.015, 'claimed', 'api', ?)`,
    ).run(NOW);
    expect(
      reclaimStale(db, {
        nowSec: NOW + 99999,
        queueTtlSec: 7200,
        leaseTtlSec: 300,
      }),
    ).toEqual({ expired: 0, reclaimed: 0 });
    expect(statusOf(db, "api1").status).toBe("claimed");
  });
});

describe("queueDepth", () => {
  it("只数 extension 通道的 queued", () => {
    const db = openDb(":memory:");
    seedQueued(db, [
      { kind: "whale", dedup: "a" },
      { kind: "whale", dedup: "b" },
    ]);
    db.prepare(
      `INSERT INTO x_posts (kind, dedup_key, text, has_link, est_cost_usd, status, channel, created_at)
       VALUES ('whale', 'api1', 't', 0, 0.015, 'claimed', 'api', ?)`,
    ).run(NOW);
    expect(queueDepth(db)).toBe(2);
  });
});
