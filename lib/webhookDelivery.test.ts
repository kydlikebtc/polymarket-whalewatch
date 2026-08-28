import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";
import { openDb } from "./db";
import { issueApiKey, revokeApiKey } from "./apiKeys";
import type { PushSignalRow } from "./signalPush";
import {
  buildSignalEvent,
  buildTestEvent,
  deleteWebhook,
  listActiveWebhooks,
  makeWebhookChannel,
  postSignalEvent,
  postTestEvent,
  recordWebhookResult,
  registerWebhook,
  setWebhookActive,
  signPayload,
  SignalEventV1Schema,
  WEBHOOK_DISABLE_AFTER,
  webhookWantsType,
} from "./webhookDelivery";
import { SIGNAL_DISCLAIMER } from "./signalPush";
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
    // 订户按 code 分派(id 是部署本地行号、name 是中文)——推送路径必须带上它。
    expect(parsed.strategy.code).toBe("whale_follow");
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
    busTypes: null,
    selectedTypes: null,
    createdAt: 0,
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

// --- 端点运维:停用 / 恢复 / 删除 -------------------------------------------

function seedEndpoint() {
  const db = openDb(":memory:");
  const rt = issueApiKey(db, { label: "rt", tier: "realtime" }, 1000);
  const id = registerWebhook(db, {
    apiKeyId: rt.id,
    url: "https://a.com/h",
    secret: "x".repeat(16),
  });
  return { db, keyId: rt.id, id };
}

function endpointRow(db: ReturnType<typeof openDb>, id: number) {
  return db
    .prepare(
      "SELECT active, consecutive_failures, last_error FROM webhook_endpoints WHERE id=?",
    )
    .get(id) as {
    active: number;
    consecutive_failures: number;
    last_error: string | null;
  };
}

describe("setWebhookActive / deleteWebhook", () => {
  it("恢复启用清零连败计数与 last_error —— 恢复后再失败一次不该立刻二次熔断", () => {
    const { db, id } = seedEndpoint();
    for (let i = 0; i < WEBHOOK_DISABLE_AFTER; i++) {
      recordWebhookResult(db, id, false, { error: "timeout" });
    }
    expect(listActiveWebhooks(db)).toHaveLength(0);

    expect(setWebhookActive(db, id, true)).toBe(true);
    const row = endpointRow(db, id);
    expect(row.active).toBe(1);
    expect(row.consecutive_failures).toBe(0);
    expect(row.last_error).toBe(null);
    expect(listActiveWebhooks(db)).toHaveLength(1);

    // 真正要钉死的是**行为后果**:熔断判定是 >= 阈值而非 ==,不清零的话
    // 计数停在 10,恢复后第一次失败就是 11 → 秒回停用,按钮形同虚设。
    const again = recordWebhookResult(db, id, false, { error: "502" });
    expect(again.disabled).toBe(false);
    expect(listActiveWebhooks(db)).toHaveLength(1);
    db.close();
  });

  it("停用保留连败计数(投递史可审计);id 不存在返回 false", () => {
    const { db, id } = seedEndpoint();
    recordWebhookResult(db, id, false, { error: "502" });
    expect(setWebhookActive(db, id, false)).toBe(true);
    const row = endpointRow(db, id);
    expect(row.active).toBe(0);
    expect(row.consecutive_failures).toBe(1);
    expect(row.last_error).toBe("502");
    expect(setWebhookActive(db, 9999, false)).toBe(false);
    expect(setWebhookActive(db, 9999, true)).toBe(false);
    db.close();
  });

  it("删除是真删:行连同 secret 一并消失,重复删返回 false", () => {
    const { db, id } = seedEndpoint();
    expect(deleteWebhook(db, id)).toBe(true);
    const left = db
      .prepare("SELECT COUNT(*) AS c FROM webhook_endpoints")
      .get() as { c: number };
    expect(left.c).toBe(0);
    expect(listActiveWebhooks(db)).toHaveLength(0);
    expect(deleteWebhook(db, id)).toBe(false);
    db.close();
  });
});

// --- 连通性测试 -------------------------------------------------------------

describe("buildTestEvent / postTestEvent", () => {
  const ep = {
    id: 7,
    apiKeyId: 1,
    url: "https://x.test/hook",
    secret: "s".repeat(20),
    active: 1,
    consecutiveFailures: 0,
    busTypes: null,
    selectedTypes: null,
    createdAt: 0,
  };

  it("测试事件通过 SignalEventV1 校验 —— 订户按真信号 schema 解析不会 4xx 误报", () => {
    const ev = buildTestEvent(1_700_000_000);
    expect(() => SignalEventV1Schema.parse(ev)).not.toThrow();
  });

  it("id=0 作哨兵(真信号 AUTOINCREMENT 从 1 起),notice 自证是测试而非信号", () => {
    const ev = buildTestEvent(1_700_000_000);
    expect(ev.id).toBe(0);
    expect(ev.strategy.id).toBe(0);
    // 免责尾行不适用:这条压根不是信号,不能让订户当成「一条模拟信号」。
    expect(ev.notice).not.toBe(SIGNAL_DISCLAIMER);
    expect(ev.notice).toContain("测试");
    expect(ev.notice).toContain("跟单");
  });

  it("走真实投递路径:同一套 HMAC 签名 + 额外 X-Signal-Test 头", async () => {
    let init: RequestInit | undefined;
    const res = await postTestEvent(ep, {
      fetchFn: async (_u, i) => {
        init = i;
        return new Response("", { status: 200 });
      },
    });
    const headers = init!.headers as Record<string, string>;
    expect(headers["x-signal-test"]).toBe("1");
    expect(headers["x-signal-id"]).toBe("0");
    expect(headers["content-type"]).toBe("application/json");
    // 消费方复算得到同一签名 —— 测试没绕开签名这道防线。
    expect(headers["x-signature"]).toBe(
      `sha256=${signPayload(ep.secret, String(init!.body))}`,
    );
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(typeof res.ms).toBe("number");
  });

  it("2xx 全段算通过(订户返 204 也是收下了)", async () => {
    const res = await postTestEvent(ep, {
      fetchFn: async () => new Response(null, { status: 204 }),
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(204);
  });

  it("4xx 诊断点明「真信号也会被永久拒收」,不是含糊的失败", async () => {
    const res = await postTestEvent(ep, {
      fetchFn: async () => new Response("", { status: 404 }),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.detail).toContain("404");
    expect(res.detail).toContain("拒收");
    expect(res.detail).toContain("不再重试");
  });

  it("5xx 诊断说明会自动重试(与 4xx 的处置截然不同)", async () => {
    const res = await postTestEvent(ep, {
      fetchFn: async () => new Response("", { status: 502 }),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
    expect(res.detail).toContain("502");
    expect(res.detail).toContain("重试");
  });

  it("超时与连不上给出各自的排查方向,而非同一句「失败」", async () => {
    const timeout = await postTestEvent(ep, {
      fetchFn: async () => {
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      },
    });
    expect(timeout.ok).toBe(false);
    expect(timeout.status).toBe(null);
    expect(timeout.detail).toContain("超时");

    const refused = await postTestEvent(ep, {
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(refused.ok).toBe(false);
    expect(refused.status).toBe(null);
    expect(refused.detail).toContain("ECONNREFUSED");
    expect(refused.detail).not.toContain("超时");
  });

  it("undici 把网络错包成 `fetch failed`,真实原因埋在 cause 里 —— 必须带出来", async () => {
    // 实测:端口不通时运营者只看到一句「fetch failed」,等于没有诊断。
    const res = await postTestEvent(ep, {
      fetchFn: async () => {
        const e: Error & { cause?: unknown } = new TypeError("fetch failed");
        e.cause = new Error("connect ECONNREFUSED 127.0.0.1:9");
        throw e;
      },
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("ECONNREFUSED 127.0.0.1:9");
  });

  it("最常见的那种 cause 是 message 为空的 AggregateError —— 要摊到子错误", async () => {
    // 端口不通时 undici 的真实形状(实测):
    //   TypeError: fetch failed
    //     └ cause: AggregateError(message="", code=ECONNREFUSED)
    //         └ errors: [connect ECONNREFUSED ::1:59999,
    //                    connect ECONNREFUSED 127.0.0.1:59999]
    // 只读 cause.message 会拿到空串 → 运营者看到的还是光秃秃一句 fetch failed。
    const res = await postTestEvent(ep, {
      fetchFn: async () => {
        const e: Error & { cause?: unknown } = new TypeError("fetch failed");
        e.cause = new AggregateError([
          new Error("connect ECONNREFUSED ::1:59999"),
          new Error("connect ECONNREFUSED 127.0.0.1:59999"),
        ]);
        throw e;
      },
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("ECONNREFUSED 127.0.0.1:59999");
  });

  it("子错误也没 message 时退回 cause.code,不能只剩一句 fetch failed", async () => {
    const res = await postTestEvent(ep, {
      fetchFn: async () => {
        const e: Error & { cause?: unknown } = new TypeError("fetch failed");
        const agg: Error & { code?: string } = new AggregateError([]);
        agg.code = "ENOTFOUND";
        e.cause = agg;
        throw e;
      },
    });
    expect(res.detail).toContain("ENOTFOUND");
  });
});

describe("端点推送类型(2026-08-19)", () => {
  it("registerWebhook 持久化勾选,listActiveWebhooks 原样返回(含 createdAt)", () => {
    const db = openDb(":memory:");
    const key = issueApiKey(db, { label: "订户", tier: "realtime" }, 1000);
    registerWebhook(
      db,
      {
        apiKeyId: key.id,
        url: "https://a/h",
        secret: "s".repeat(16),
        busTypes: ["strategy", "large"],
      },
      1234,
    );
    const [ep] = listActiveWebhooks(db);
    expect(ep.selectedTypes).toEqual(["strategy", "large"]);
    expect(ep.createdAt).toBe(1234);
  });

  it("省略勾选 → 存 NULL(仅策略信号的历史默认)", () => {
    const db = openDb(":memory:");
    const key = issueApiKey(db, { label: "订户", tier: "realtime" }, 1000);
    registerWebhook(
      db,
      { apiKeyId: key.id, url: "https://a/h", secret: "s".repeat(16) },
      1234,
    );
    const [ep] = listActiveWebhooks(db);
    expect(ep.selectedTypes).toBeNull();
  });

  it("webhookWantsType:勾选 null → 仅 strategy;显式勾选按列表;key 范围是上限", () => {
    const base = { busTypes: null, selectedTypes: null };
    expect(webhookWantsType(base, "strategy")).toBe(true);
    expect(webhookWantsType(base, "large")).toBe(false);
    const picked = { busTypes: null, selectedTypes: ["large"] };
    expect(webhookWantsType(picked, "large")).toBe(true);
    expect(webhookWantsType(picked, "strategy")).toBe(false);
    // key 只授权 strategy —— 勾了 large 也不放行(交集)
    const capped = {
      busTypes: ["strategy"],
      selectedTypes: ["strategy", "large"],
    };
    expect(webhookWantsType(capped, "large")).toBe(false);
    expect(webhookWantsType(capped, "strategy")).toBe(true);
  });
});

describe("wallets_json 惰性守卫(向前落库批次)", () => {
  it("行对象带 wallets_json(SELECT s.* 会带上),webhook 事件零泄漏", () => {
    const ev = buildSignalEvent(
      {
        ...row(),
        wallets_json: '[{"wallet":"0xleakcheck","netUsd":1,"score":9}]',
      } as never,
      "entry",
      {
        strategyName: "巨鲸",
        source: "heavy",
        record: { settled: 41, wins: 26, implied: 22.9, excess: 3.1, sd: 3.4 },
        category: "Sports",
        subcategory: "NBA",
      },
    );
    const dumped = JSON.stringify(ev);
    expect(dumped).not.toContain("0xleakcheck");
    expect(dumped).not.toContain("wallets");
  });
});
