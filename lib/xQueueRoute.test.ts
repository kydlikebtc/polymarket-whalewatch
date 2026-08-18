import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import { issueApiKey } from "./apiKeys";
import { handleXQueueAck, handleXQueueGet } from "./xQueueRoute";

const NOW = Math.floor(Date.UTC(2026, 7, 18, 12) / 1000);
const PROD = { NODE_ENV: "production" } as Record<string, string | undefined>;
const DEV = { NODE_ENV: "development" } as Record<string, string | undefined>;
const PUBLIC_URL = "https://whalewatch.wired.fund";

function seedQueued(
  db: DB,
  rows: { kind: string; dedup: string; text?: string }[],
) {
  for (const r of rows) {
    db.prepare(
      `INSERT INTO x_posts (kind, dedup_key, text, has_link, est_cost_usd, status, channel, created_at)
       VALUES (?, ?, ?, 0, 0, 'queued', 'extension', ?)`,
    ).run(r.kind, r.dedup, r.text ?? `text-${r.dedup}`, NOW);
  }
}

const getReq = (q = "", headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/x-queue${q}`, { headers });

const ackReq = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/x-queue/ack", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("handleXQueueGet", () => {
  it("租借并返回待发帖", async () => {
    const db = openDb(":memory:");
    seedQueued(db, [{ kind: "whale", dedup: "a" }]);
    const res = await handleXQueueGet(getReq(), db, {
      publicUrl: PUBLIC_URL,
      nowSec: NOW,
      env: DEV,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      posts: {
        id: number;
        kind: string;
        text: string;
        imageUrl: string | null;
      }[];
      serverTime: number;
    };
    expect(body.posts).toHaveLength(1);
    expect(body.posts[0]).toMatchObject({
      kind: "whale",
      text: "text-a",
      imageUrl: null,
    });
    expect(body.serverTime).toBe(NOW);
  });

  it("weekly 帖带上图卡地址(插件自己去下载)", async () => {
    const db = openDb(":memory:");
    seedQueued(db, [{ kind: "weekly", dedup: "w" }]);
    const res = await handleXQueueGet(getReq(), db, {
      publicUrl: PUBLIC_URL,
      nowSec: NOW,
      env: DEV,
    });
    const body = (await res.json()) as {
      posts: { kind: string; imageUrl: string | null }[];
    };
    expect(body.posts[0]).toMatchObject({
      kind: "weekly",
      imageUrl: `${PUBLIC_URL}/api/og/weekly`,
    });
  });

  it("limit 被夹在 1..10 —— 客户端传什么都不能把队列一次抽干", async () => {
    const db = openDb(":memory:");
    seedQueued(
      db,
      Array.from({ length: 20 }, (_, i) => ({ kind: "whale", dedup: `k${i}` })),
    );
    const res = await handleXQueueGet(getReq("?limit=999"), db, {
      publicUrl: PUBLIC_URL,
      nowSec: NOW,
      env: DEV,
    });
    const body = (await res.json()) as { posts: unknown[] };
    expect(body.posts).toHaveLength(10);
  });

  it("limit 非法值回落默认而不是报错", async () => {
    const db = openDb(":memory:");
    seedQueued(db, [{ kind: "whale", dedup: "a" }]);
    const res = await handleXQueueGet(getReq("?limit=abc"), db, {
      publicUrl: PUBLIC_URL,
      nowSec: NOW,
      env: DEV,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { posts: unknown[] }).posts).toHaveLength(1);
  });

  it("空队列返回 200 空数组(插件据此静默待命,不该当错误)", async () => {
    const res = await handleXQueueGet(getReq(), openDb(":memory:"), {
      publicUrl: PUBLIC_URL,
      nowSec: NOW,
      env: DEV,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { posts: unknown[] }).posts).toEqual([]);
  });

  it("无 key → 401,无能力位 → 403", async () => {
    const db = openDb(":memory:");
    seedQueued(db, [{ kind: "whale", dedup: "a" }]);
    expect(
      (
        await handleXQueueGet(getReq(), db, {
          publicUrl: PUBLIC_URL,
          nowSec: NOW,
          env: PROD,
        })
      ).status,
    ).toBe(401);
    const reader = issueApiKey(db, { label: "r", tier: "realtime" });
    expect(
      (
        await handleXQueueGet(getReq("", { "x-feed-token": reader.key }), db, {
          publicUrl: PUBLIC_URL,
          nowSec: NOW,
          env: PROD,
        })
      ).status,
    ).toBe(403);
    // 鉴权失败必须**零副作用**:队列不能被租走。
    expect(
      (db.prepare("SELECT status FROM x_posts").get() as { status: string })
        .status,
    ).toBe("queued");
  });
});

describe("handleXQueueAck", () => {
  async function leaseOne(db: DB) {
    seedQueued(db, [{ kind: "whale", dedup: "a" }]);
    const res = await handleXQueueGet(getReq(), db, {
      publicUrl: PUBLIC_URL,
      nowSec: NOW,
      env: DEV,
    });
    return ((await res.json()) as { posts: { id: number }[] }).posts[0].id;
  }

  it("posted 结算并落 x_post_id", async () => {
    const db = openDb(":memory:");
    const id = await leaseOne(db);
    const res = await handleXQueueAck(
      ackReq({ id, result: "posted", xPostId: "1899" }),
      db,
      { nowSec: NOW, env: DEV },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: false });
    expect(
      db.prepare("SELECT status, x_post_id FROM x_posts").get(),
    ).toMatchObject({ status: "posted", x_post_id: "1899" });
  });

  it("重复 ack 返回 200 + duplicate:true —— at-least-once 下这是正常流量", async () => {
    const db = openDb(":memory:");
    const id = await leaseOne(db);
    await handleXQueueAck(ackReq({ id, result: "posted", xPostId: "1" }), db, {
      nowSec: NOW,
      env: DEV,
    });
    const res = await handleXQueueAck(
      ackReq({ id, result: "posted", xPostId: "1" }),
      db,
      { nowSec: NOW, env: DEV },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
  });

  it("channel_error 退回队列并**发一条告警**", async () => {
    const db = openDb(":memory:");
    const id = await leaseOne(db);
    const sent: string[] = [];
    const res = await handleXQueueAck(
      ackReq({ id, result: "channel_error", error: "composer not found" }),
      db,
      { nowSec: NOW, env: DEV, notify: async (m) => void sent.push(m) },
    );
    expect(res.status).toBe(200);
    expect(
      (db.prepare("SELECT status FROM x_posts").get() as { status: string })
        .status,
    ).toBe("queued");
    // 通道级故障运营者必须立刻知道 —— 否则队列会静默积压到 TTL 全部作废。
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("composer not found");
  });

  it("告警发送失败不影响 ack 结果(通知是尽力而为,状态机不能被它拖累)", async () => {
    const db = openDb(":memory:");
    const id = await leaseOne(db);
    const res = await handleXQueueAck(
      ackReq({ id, result: "channel_error" }),
      db,
      {
        nowSec: NOW,
        env: DEV,
        notify: async () => {
          throw new Error("tg down");
        },
      },
    );
    expect(res.status).toBe(200);
    expect(
      (db.prepare("SELECT status FROM x_posts").get() as { status: string })
        .status,
    ).toBe("queued");
  });

  it("unconfirmed 落 posted_unconfirmed", async () => {
    const db = openDb(":memory:");
    const id = await leaseOne(db);
    await handleXQueueAck(ackReq({ id, result: "unconfirmed" }), db, {
      nowSec: NOW,
      env: DEV,
    });
    expect(
      (db.prepare("SELECT status FROM x_posts").get() as { status: string })
        .status,
    ).toBe("posted_unconfirmed");
  });

  it("body 不合法 → 400,且不动任何状态", async () => {
    const db = openDb(":memory:");
    const id = await leaseOne(db);
    for (const bad of [
      { id, result: "banana" },
      { result: "posted" },
      { id: "not-a-number", result: "posted" },
      "not json at all",
    ]) {
      const req =
        typeof bad === "string"
          ? new Request("http://localhost/api/x-queue/ack", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: bad,
            })
          : ackReq(bad);
      expect(
        (await handleXQueueAck(req, db, { nowSec: NOW, env: DEV })).status,
      ).toBe(400);
    }
    expect(
      (db.prepare("SELECT status FROM x_posts").get() as { status: string })
        .status,
    ).toBe("leased");
  });

  it("鉴权同 GET:无 key → 401", async () => {
    const db = openDb(":memory:");
    expect(
      (
        await handleXQueueAck(ackReq({ id: 1, result: "posted" }), db, {
          nowSec: NOW,
          env: PROD,
        })
      ).status,
    ).toBe(401);
  });
});
