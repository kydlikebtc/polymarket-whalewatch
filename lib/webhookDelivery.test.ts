import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";
import { openDb } from "./db";
import { issueApiKey, revokeApiKey } from "./apiKeys";
import type { PushSignalRow } from "./signalPush";
import {
  buildSignalEvent,
  listActiveWebhooks,
  makeWebhookChannel,
  postSignalEvent,
  recordWebhookResult,
  registerWebhook,
  signPayload,
  SignalEventV1Schema,
  WEBHOOK_DISABLE_AFTER,
} from "./webhookDelivery";
import { isPermanentSendError } from "./telegram";

// 对外信号批次 3:webhook 通道。HMAC 签名防伪造、5s 超时、4xx=permanent、
// 网络/5xx=transient(重试节奏 = 投递循环 30s,不做环内退避)、连续失败熔断。

const row = (o: Partial<PushSignalRow> = {}): PushSignalRow => ({
  id: 1,
  strategy_id: 6,
  condition_id: "0xc1",
  outcome: "Yes",
  outcome_index: 0,
  asset: "tok1",
  title: "T",
  slug: "s",
  event_slug: "e",
  formation_ts: 1000,
  reference_price: 0.61,
  wallet_count: 1,
  total_net_usd: 52000,
  entry_price: 0.63,
  size_usd: 500,
  emitted_at: 1047,
  settled: 0,
  settled_ts: null,
  exit_price: null,
  won: null,
  realized_pnl: null,
  ...o,
});

describe("signPayload / buildSignalEvent", () => {
  it("签名 = hex(hmac-sha256(secret, body)),消费方可复算", () => {
    const body = '{"v":1}';
    const sig = signPayload("sec-ret", body);
    expect(sig).toBe(
      createHmac("sha256", "sec-ret").update(body).digest("hex"),
    );
  });

  it("entry 事件通过 SignalEventV1 zod 校验,含 paper 追价与免责", () => {
    const ev = buildSignalEvent(row(), "entry", {
      strategyName: "巨鲸",
      source: "heavy",
      record: { settled: 41, wins: 26, implied: 22.9, excess: 3.1, sd: 3.4 },
      category: "Sports",
      subcategory: "NBA",
    });
    const parsed = SignalEventV1Schema.parse(ev);
    expect(parsed.v).toBe(1);
    expect(parsed.event).toBe("entry");
    expect(parsed.strategy.name).toBe("巨鲸");
    expect(parsed.paper.chaseCents).toBeCloseTo(2, 6);
    expect(parsed.paper.latencySec).toBe(47);
    expect(parsed.settle).toBeNull();
    expect(parsed.notice).toContain("非投资建议");
  });

  it("settle 事件带结算块,record 可为 null", () => {
    const ev = buildSignalEvent(
      row({
        settled: 1,
        settled_ts: 5000,
        exit_price: 1,
        won: 1,
        realized_pnl: 293.7,
      }),
      "settle",
      { strategyName: "巨鲸", source: "heavy", record: null },
    );
    const parsed = SignalEventV1Schema.parse(ev);
    expect(parsed.event).toBe("settle");
    expect(parsed.settle?.won).toBe(true);
    expect(parsed.settle?.realizedPnl).toBeCloseTo(293.7);
  });
});

describe("postSignalEvent — 状态分类", () => {
  const ep = {
    id: 1,
    apiKeyId: 1,
    url: "https://example.com/hook",
    secret: "s".repeat(16),
    active: 1,
    consecutiveFailures: 0,
  };
  const ev = buildSignalEvent(row(), "entry", {
    strategyName: "巨鲸",
    source: "heavy",
    record: null,
  });

  it("2xx → ok,请求带签名与事件头", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 200 }));
    const r = await postSignalEvent(ep, ev, { fetchFn });
    expect(r).toBe("ok");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(ep.url);
    const headers = init.headers as Record<string, string>;
    expect(headers["x-signature"]).toBe(
      `sha256=${signPayload(ep.secret, String(init.body))}`,
    );
    expect(headers["x-signal-event"]).toBe("entry");
  });

  it("4xx → permanent;5xx/网络异常 → transient", async () => {
    expect(
      await postSignalEvent(ep, ev, {
        fetchFn: async () => new Response("", { status: 404 }),
      }),
    ).toBe("permanent");
    expect(
      await postSignalEvent(ep, ev, {
        fetchFn: async () => new Response("", { status: 502 }),
      }),
    ).toBe("transient");
    expect(
      await postSignalEvent(ep, ev, {
        fetchFn: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).toBe("transient");
  });
});

describe("registerWebhook / listActiveWebhooks / 熔断", () => {
  it("只列 active=1 且 api_key 未吊销且 tier=realtime 的端点", () => {
    const db = openDb(":memory:");
    const rt = issueApiKey(db, { label: "rt", tier: "realtime" }, 1000);
    const dl = issueApiKey(db, { label: "dl", tier: "delayed" }, 1000);
    const revoked = issueApiKey(db, { label: "rv", tier: "realtime" }, 1000);
    revokeApiKey(db, revoked.id, 1500);
    registerWebhook(db, {
      apiKeyId: rt.id,
      url: "https://a.com/h",
      secret: "x".repeat(16),
    });
    registerWebhook(db, {
      apiKeyId: dl.id,
      url: "https://b.com/h",
      secret: "x".repeat(16),
    });
    registerWebhook(db, {
      apiKeyId: revoked.id,
      url: "https://c.com/h",
      secret: "x".repeat(16),
    });
    const list = listActiveWebhooks(db);
    expect(list).toHaveLength(1);
    expect(list[0].url).toBe("https://a.com/h");
    db.close();
  });

  it("连续失败达阈值自动 active=0;一次成功清零计数", () => {
    const db = openDb(":memory:");
    const rt = issueApiKey(db, { label: "rt", tier: "realtime" }, 1000);
    const id = registerWebhook(db, {
      apiKeyId: rt.id,
      url: "https://a.com/h",
      secret: "x".repeat(16),
    });
    for (let i = 0; i < WEBHOOK_DISABLE_AFTER - 1; i++) {
      const r = recordWebhookResult(db, id, false, { error: "502" });
      expect(r.disabled).toBe(false);
    }
    // 中途一次成功 → 清零。
    recordWebhookResult(db, id, true);
    const rowAfterOk = db
      .prepare(
        "SELECT consecutive_failures, active FROM webhook_endpoints WHERE id=?",
      )
      .get(id) as { consecutive_failures: number; active: number };
    expect(rowAfterOk.consecutive_failures).toBe(0);
    expect(rowAfterOk.active).toBe(1);
    for (let i = 0; i < WEBHOOK_DISABLE_AFTER; i++) {
      recordWebhookResult(db, id, false, { error: "timeout" });
    }
    const rowDisabled = db
      .prepare(
        "SELECT consecutive_failures, active, last_error FROM webhook_endpoints WHERE id=?",
      )
      .get(id) as {
      consecutive_failures: number;
      active: number;
      last_error: string;
    };
    expect(rowDisabled.active).toBe(0);
    expect(rowDisabled.last_error).toBe("timeout");
    expect(listActiveWebhooks(db)).toHaveLength(0);
    db.close();
  });

  it("makeWebhookChannel:permanent 抛 permanent 标记错误(投递循环据此保留 claim)", async () => {
    const db = openDb(":memory:");
    const rt = issueApiKey(db, { label: "rt", tier: "realtime" }, 1000);
    const id = registerWebhook(db, {
      apiKeyId: rt.id,
      url: "https://a.com/h",
      secret: "x".repeat(16),
    });
    const ep = listActiveWebhooks(db)[0];
    const ch = makeWebhookChannel(db, ep, {
      fetchFn: async () => new Response("", { status: 400 }),
    });
    expect(ch.key).toBe(`webhook:${id}`);
    let caught: unknown;
    try {
      await ch.sendEvent!([row()], "entry", {
        strategyName: () => "巨鲸",
        source: () => "heavy",
        record: () => null,
        category: () => ({ category: null, subcategory: null }),
      });
    } catch (e) {
      caught = e;
    }
    expect(isPermanentSendError(caught)).toBe(true);
    db.close();
  });
});
