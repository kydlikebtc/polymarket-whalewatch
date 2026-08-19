import { describe, it, expect, vi } from "vitest";
import { openDb, type DB } from "./db";
import { issueApiKey } from "./apiKeys";
import { registerWebhook, WEBHOOK_DISABLE_AFTER } from "./webhookDelivery";
import {
  BUS_MAX_SENDS_PER_CYCLE,
  BusEventV1Schema,
  runBusWebhookCycle,
} from "./busWebhook";

const NOW = 1_790_000_000;

function seedKey(db: DB, busTypes?: string[]) {
  return issueApiKey(
    db,
    { label: "订户", tier: "realtime", busTypes },
    NOW - 100,
  ).id;
}

function insertBus(
  db: DB,
  over: Partial<{
    sourceType: string;
    dedupKey: string;
    conditionId: string | null;
    title: string | null;
    payload: unknown;
    emittedAt: number;
  }> = {},
): number {
  const r = db
    .prepare(
      "INSERT INTO bus_signals (source_type, dedup_key, condition_id, title, payload, emitted_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      over.sourceType ?? "large",
      over.dedupKey ?? `alert:${Math.floor(Math.random() * 1e9)}`,
      over.conditionId === undefined ? "0xabc" : over.conditionId,
      over.title === undefined ? "Market A" : over.title,
      JSON.stringify(over.payload ?? { usd: 120000, side: "BUY" }),
      over.emittedAt ?? NOW - 60,
    );
  return Number(r.lastInsertRowid);
}

const okFetch = () =>
  vi.fn(
    async () => new Response("", { status: 200 }),
  ) as unknown as typeof fetch;

describe("runBusWebhookCycle · 路由与形状", () => {
  it("勾选类型的端点收到该类型事件,body 过 BusEventV1 schema,头带 event=bus", async () => {
    const db = openDb(":memory:");
    const keyId = seedKey(db);
    registerWebhook(
      db,
      {
        apiKeyId: keyId,
        url: "https://sub.example/hook",
        secret: "s".repeat(16),
        busTypes: ["large"],
      },
      NOW - 500,
    );
    const busId = insertBus(db);
    const calls: {
      url: string;
      body: string;
      headers: Record<string, string>;
    }[] = [];
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: String(init?.body),
        headers: init?.headers as Record<string, string>,
      });
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const r = await runBusWebhookCycle(db, { nowSec: NOW, fetchFn });
    expect(r).toEqual({ sent: 1, failed: 0, frozen: false });
    expect(calls).toHaveLength(1);
    const ev = BusEventV1Schema.parse(JSON.parse(calls[0].body));
    expect(ev.id).toBe(busId);
    expect(ev.bus.sourceType).toBe("large");
    expect(ev.bus.payload).toEqual({ usd: 120000, side: "BUY" });
    expect(calls[0].headers["x-signal-event"]).toBe("bus");
    expect(calls[0].headers["x-signal-id"]).toBe(String(busId));
    expect(calls[0].headers["x-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("未勾选类型的端点(存量,bus_types=null)一条 bus 事件都收不到", async () => {
    const db = openDb(":memory:");
    registerWebhook(
      db,
      { apiKeyId: seedKey(db), url: "https://a/h", secret: "s".repeat(16) },
      NOW - 500,
    );
    insertBus(db);
    const fetchFn = okFetch();
    const r = await runBusWebhookCycle(db, { nowSec: NOW, fetchFn });
    expect(r.sent).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("勾了 large 的端点收不到 consensus 事件", async () => {
    const db = openDb(":memory:");
    registerWebhook(
      db,
      {
        apiKeyId: seedKey(db),
        url: "https://a/h",
        secret: "s".repeat(16),
        busTypes: ["large"],
      },
      NOW - 500,
    );
    insertBus(db, { sourceType: "consensus", payload: { walletCount: 3 } });
    const r = await runBusWebhookCycle(db, { nowSec: NOW, fetchFn: okFetch() });
    expect(r.sent).toBe(0);
  });

  it("key 范围是授权上限:端点勾了 key 无权的类型,运行时仍不投(交集兜底)", async () => {
    const db = openDb(":memory:");
    const keyId = seedKey(db, ["large"]); // key 只授权 large
    // 绕过登记校验直接写库,模拟历史脏数据/手工改库。
    db.prepare(
      "INSERT INTO webhook_endpoints (api_key_id, url, secret, created_at, bus_types) VALUES (?, ?, ?, ?, ?)",
    ).run(
      keyId,
      "https://a/h",
      "s".repeat(16),
      NOW - 500,
      JSON.stringify(["large", "consensus"]),
    );
    insertBus(db, { sourceType: "consensus" });
    const r = await runBusWebhookCycle(db, { nowSec: NOW, fetchFn: okFetch() });
    expect(r.sent).toBe(0);
  });
});

describe("runBusWebhookCycle · 幂等与失败模型", () => {
  function seedOne(db: DB, opts: { emittedAt?: number } = {}) {
    registerWebhook(
      db,
      {
        apiKeyId: seedKey(db),
        url: "https://a/h",
        secret: "s".repeat(16),
        busTypes: ["large"],
      },
      NOW - 500,
    );
    return insertBus(db, { emittedAt: opts.emittedAt });
  }

  it("同一事件只投一次:第二轮零发送(claim 台账挡住)", async () => {
    const db = openDb(":memory:");
    seedOne(db);
    expect(
      (await runBusWebhookCycle(db, { nowSec: NOW, fetchFn: okFetch() })).sent,
    ).toBe(1);
    const fetch2 = okFetch();
    expect(
      (await runBusWebhookCycle(db, { nowSec: NOW, fetchFn: fetch2 })).sent,
    ).toBe(0);
    expect(fetch2).not.toHaveBeenCalled();
  });

  it("transient 失败回滚 claim,下一轮重投成功", async () => {
    const db = openDb(":memory:");
    seedOne(db);
    const down = (async () =>
      new Response("", { status: 503 })) as typeof fetch;
    const r1 = await runBusWebhookCycle(db, { nowSec: NOW, fetchFn: down });
    expect(r1).toMatchObject({ sent: 0, failed: 1 });
    const r2 = await runBusWebhookCycle(db, {
      nowSec: NOW,
      fetchFn: okFetch(),
    });
    expect(r2.sent).toBe(1);
  });

  it("permanent(4xx)保留 claim 不再重试,且毒事件不挡住后面的行", async () => {
    const db = openDb(":memory:");
    registerWebhook(
      db,
      {
        apiKeyId: seedKey(db),
        url: "https://a/h",
        secret: "s".repeat(16),
        busTypes: ["large"],
      },
      NOW - 500,
    );
    const poison = insertBus(db, { emittedAt: NOW - 90 });
    insertBus(db, { emittedAt: NOW - 30 });
    let first = true;
    const fetchFn = (async () => {
      if (first) {
        first = false;
        return new Response("", { status: 422 });
      }
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const r = await runBusWebhookCycle(db, { nowSec: NOW, fetchFn });
    expect(r).toMatchObject({ sent: 1, failed: 1 });
    const row = db
      .prepare("SELECT status FROM bus_deliveries WHERE bus_signal_id = ?")
      .get(poison) as { status: string };
    expect(row.status).toBe("failed_permanent");
    // 再跑一轮:毒事件不重试,好事件已投过 → 零动作。
    const fetch2 = okFetch();
    expect(
      (await runBusWebhookCycle(db, { nowSec: NOW, fetchFn: fetch2 })).sent,
    ).toBe(0);
    expect(fetch2).not.toHaveBeenCalled();
  });

  it("transient 中断本端点本轮(不逐行吃超时),第二行下轮再试", async () => {
    const db = openDb(":memory:");
    registerWebhook(
      db,
      {
        apiKeyId: seedKey(db),
        url: "https://a/h",
        secret: "s".repeat(16),
        busTypes: ["large"],
      },
      NOW - 500,
    );
    insertBus(db, { emittedAt: NOW - 90 });
    insertBus(db, { emittedAt: NOW - 30 });
    const down = vi.fn(async () => new Response("", { status: 503 }));
    await runBusWebhookCycle(db, {
      nowSec: NOW,
      fetchFn: down as unknown as typeof fetch,
    });
    expect(down).toHaveBeenCalledTimes(1); // 第一条失败即中断,没去碰第二条
  });

  it(`连续 permanent 失败 ${WEBHOOK_DISABLE_AFTER} 次熔断停用并回调 onDisabled`, async () => {
    const db = openDb(":memory:");
    const keyId = seedKey(db);
    const epId = registerWebhook(
      db,
      {
        apiKeyId: keyId,
        url: "https://a/h",
        secret: "s".repeat(16),
        busTypes: ["large"],
      },
      NOW - 500,
    );
    for (let i = 0; i < WEBHOOK_DISABLE_AFTER + 2; i++) {
      insertBus(db, { emittedAt: NOW - 100 + i });
    }
    const reject = (async () =>
      new Response("", { status: 400 })) as typeof fetch;
    const onDisabled = vi.fn();
    await runBusWebhookCycle(db, { nowSec: NOW, fetchFn: reject, onDisabled });
    expect(onDisabled).toHaveBeenCalledTimes(1);
    const ep = db
      .prepare("SELECT active FROM webhook_endpoints WHERE id = ?")
      .get(epId) as { active: number };
    expect(ep.active).toBe(0);
  });
});

describe("runBusWebhookCycle · 窗口纪律", () => {
  it("不回灌:早于端点登记时刻的事件不投", async () => {
    const db = openDb(":memory:");
    registerWebhook(
      db,
      {
        apiKeyId: seedKey(db),
        url: "https://a/h",
        secret: "s".repeat(16),
        busTypes: ["large"],
      },
      NOW - 50, // 端点 50 秒前登记
    );
    insertBus(db, { emittedAt: NOW - 200 }); // 事件更早
    const r = await runBusWebhookCycle(db, { nowSec: NOW, fetchFn: okFetch() });
    expect(r.sent).toBe(0);
  });

  it("超过新鲜窗(1h)的事件不投", async () => {
    const db = openDb(":memory:");
    registerWebhook(
      db,
      {
        apiKeyId: seedKey(db),
        url: "https://a/h",
        secret: "s".repeat(16),
        busTypes: ["large"],
      },
      NOW - 7200,
    );
    insertBus(db, { emittedAt: NOW - 4000 });
    const r = await runBusWebhookCycle(db, { nowSec: NOW, fetchFn: okFetch() });
    expect(r.sent).toBe(0);
  });

  it("引擎不健康 → 冻结,零请求(安静和死了不长得一样)", async () => {
    const db = openDb(":memory:");
    seedKey(db);
    registerWebhook(
      db,
      {
        apiKeyId: 1,
        url: "https://a/h",
        secret: "s".repeat(16),
        busTypes: ["large"],
      },
      NOW - 500,
    );
    insertBus(db);
    const fetchFn = okFetch();
    const r = await runBusWebhookCycle(db, {
      nowSec: NOW,
      fetchFn,
      checkHealth: () => ({ ok: false }),
    });
    expect(r).toEqual({ sent: 0, failed: 0, frozen: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it(`每端点每轮上限 ${BUS_MAX_SENDS_PER_CYCLE} 条,超出顺延下轮`, async () => {
    const db = openDb(":memory:");
    registerWebhook(
      db,
      {
        apiKeyId: seedKey(db),
        url: "https://a/h",
        secret: "s".repeat(16),
        busTypes: ["large"],
      },
      NOW - 500,
    );
    for (let i = 0; i < BUS_MAX_SENDS_PER_CYCLE + 3; i++) {
      insertBus(db, { emittedAt: NOW - 40 + 0 * i, dedupKey: `alert:${i}` });
    }
    const r1 = await runBusWebhookCycle(db, {
      nowSec: NOW,
      fetchFn: okFetch(),
    });
    expect(r1.sent).toBe(BUS_MAX_SENDS_PER_CYCLE);
    const r2 = await runBusWebhookCycle(db, {
      nowSec: NOW,
      fetchFn: okFetch(),
    });
    expect(r2.sent).toBe(3);
  });
});
