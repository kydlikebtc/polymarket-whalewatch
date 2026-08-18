import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  QueueClient,
  type FetchLike,
  type PostOutcome,
  type QueueStore,
} from "./queue.client";
import type { QueuedPost } from "../shared/protocol";

// 内存版 store —— 生产实现打在 chrome.storage.local 上,这里只测逻辑。
function memStore(): QueueStore & { data: Record<number, string> } {
  const data: Record<number, string> = {};
  return {
    data,
    async getPosted(id) {
      return data[id] ?? null;
    },
    async rememberPosted(id, xPostId) {
      data[id] = xPostId;
    },
    async forgetPosted(id) {
      delete data[id];
    },
    async listPending() {
      return Object.entries(data).map(([id, xPostId]) => ({
        id: Number(id),
        xPostId,
      }));
    },
  };
}

const CFG = { baseUrl: "https://ww.test", apiKey: "wlk_x" };
const post = (over: Partial<QueuedPost> = {}): QueuedPost => ({
  id: 1,
  kind: "whale",
  text: "hello",
  imageUrl: null,
  ...over,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("QueueClient.fetchBatch", () => {
  it("带上 x-feed-token 并解析 posts", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ posts: [post()], serverTime: 1 }));
    const c = new QueueClient({ store: memStore(), fetchImpl });
    const r = await c.fetchBatch(CFG, 3);
    expect(r.kind).toBe("ok");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ww.test/api/x-queue?limit=3");
    expect((init.headers as Record<string, string>)["x-feed-token"]).toBe(
      "wlk_x",
    );
  });

  it("401 → unauthorized(调用方据此清空本地配置)", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ error: "bad key" }, 401));
    const c = new QueueClient({ store: memStore(), fetchImpl });
    expect((await c.fetchBatch(CFG, 3)).kind).toBe("unauthorized");
  });

  it("403 也算 unauthorized —— key 有效但没有发帖能力,同样要人去改配置", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ error: "no cap" }, 403));
    const c = new QueueClient({ store: memStore(), fetchImpl });
    expect((await c.fetchBatch(CFG, 3)).kind).toBe("unauthorized");
  });

  it("5xx / 网络错误 → error(可重试,不清配置)", async () => {
    const c1 = new QueueClient({
      store: memStore(),
      fetchImpl: vi.fn<FetchLike>().mockResolvedValue(jsonResponse({}, 502)),
    });
    expect((await c1.fetchBatch(CFG, 3)).kind).toBe("error");
    const c2 = new QueueClient({
      store: memStore(),
      fetchImpl: vi.fn<FetchLike>().mockRejectedValue(new Error("offline")),
    });
    expect((await c2.fetchBatch(CFG, 3)).kind).toBe("error");
  });
});

describe("QueueClient.processOne —— 防重发是它的全部意义", () => {
  let store: ReturnType<typeof memStore>;
  let fetchImpl: Mock<FetchLike>;

  beforeEach(() => {
    store = memStore();
    fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));
  });

  it("正常路径:发帖 → 先记本地 → ack → 清本地", async () => {
    const publish = vi
      .fn<() => Promise<PostOutcome>>()
      .mockResolvedValue({ result: "posted", xPostId: "t1" });
    const c = new QueueClient({ store, fetchImpl });
    const r = await c.processOne(CFG, post({ id: 7 }), publish);
    expect(r).toEqual({ result: "posted", xPostId: "t1" });
    expect(publish).toHaveBeenCalledOnce();
    // ack 成功后本地记录必须清掉,否则会无限补 ack
    expect(store.data[7]).toBeUndefined();
  });

  it("**已发过的 id 再次被租借到 → 只补 ack,绝不重发**", async () => {
    // 场景:上次发帖成功但 ack 因断网没送达,服务端 lease 超时把它退回
    // queued,插件又取到了同一条。这是 at-least-once 的经典裂缝 —— 唯一
    // 能堵住它的信息(「我已经发过了」)只有插件自己有。
    await store.rememberPosted(42, "already-sent");
    const publish = vi.fn<() => Promise<PostOutcome>>();
    const c = new QueueClient({ store, fetchImpl });
    const r = await c.processOne(CFG, post({ id: 42 }), publish);
    expect(publish).not.toHaveBeenCalled();
    expect(r).toEqual({ result: "posted", xPostId: "already-sent" });
    const body = JSON.parse(
      (fetchImpl.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toMatchObject({
      id: 42,
      result: "posted",
      xPostId: "already-sent",
    });
    expect(store.data[42]).toBeUndefined();
  });

  it("ack 失败则保留本地记录,下次继续补", async () => {
    fetchImpl.mockResolvedValue(jsonResponse({}, 500));
    const publish = vi
      .fn<() => Promise<PostOutcome>>()
      .mockResolvedValue({ result: "posted", xPostId: "t2" });
    const c = new QueueClient({ store, fetchImpl });
    await c.processOne(CFG, post({ id: 9 }), publish);
    // 记录必须留着 —— 丢了就等于下轮会重发
    expect(store.data[9]).toBe("t2");
  });

  it("发帖失败(failed)不记本地,ack 后照常继续", async () => {
    const publish = vi
      .fn<() => Promise<PostOutcome>>()
      .mockResolvedValue({ result: "failed", error: "button disabled" });
    const c = new QueueClient({ store, fetchImpl });
    const r = await c.processOne(CFG, post({ id: 3 }), publish);
    expect(r.result).toBe("failed");
    expect(store.data[3]).toBeUndefined();
  });

  it("unconfirmed 也要记本地 —— 可能真发出去了,绝不能让它被重发", async () => {
    // 「点了发送但没抓到回执」:重发的代价是账号上出现两条一样的帖,
    // 比漏发一条严重得多。所以按"发过"处理,由 /manage 上的人工核对兜底。
    const publish = vi
      .fn<() => Promise<PostOutcome>>()
      .mockResolvedValue({ result: "unconfirmed" });
    const c = new QueueClient({ store, fetchImpl });
    await c.processOne(CFG, post({ id: 11 }), publish);
    const body = JSON.parse(
      (fetchImpl.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.result).toBe("unconfirmed");
    // ack 成功 → 清掉
    expect(store.data[11]).toBeUndefined();
  });

  it("unconfirmed 且 ack 失败 → 本地留痕,下轮补 ack 时仍报 unconfirmed", async () => {
    fetchImpl.mockResolvedValue(jsonResponse({}, 500));
    const publish = vi
      .fn<() => Promise<PostOutcome>>()
      .mockResolvedValue({ result: "unconfirmed" });
    const c = new QueueClient({ store, fetchImpl });
    await c.processOne(CFG, post({ id: 12 }), publish);
    expect(store.data[12]).toBe(""); // 空串 = 发过但没有 post id

    // 下一轮:不重发,补 ack,且仍然是 unconfirmed 而不是 posted
    fetchImpl.mockResolvedValue(jsonResponse({ ok: true }));
    const publish2 = vi.fn<() => Promise<PostOutcome>>();
    await c.processOne(CFG, post({ id: 12 }), publish2);
    expect(publish2).not.toHaveBeenCalled();
    const body = JSON.parse(
      (fetchImpl.mock.calls[1][1] as RequestInit).body as string,
    );
    expect(body).toMatchObject({ id: 12, result: "unconfirmed" });
    expect(body.xPostId).toBeUndefined();
  });

  it("channel_error 直接上报,不记本地(这条帖没发出去)", async () => {
    const publish = vi
      .fn<() => Promise<PostOutcome>>()
      .mockResolvedValue({ result: "channel_error", error: "composer 404" });
    const c = new QueueClient({ store, fetchImpl });
    const r = await c.processOne(CFG, post({ id: 5 }), publish);
    expect(r.result).toBe("channel_error");
    expect(store.data[5]).toBeUndefined();
    const body = JSON.parse(
      (fetchImpl.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toMatchObject({
      result: "channel_error",
      error: "composer 404",
    });
  });

  it("publish 抛异常按 channel_error 处理(未知故障宁可当通道坏了)", async () => {
    // 方向选择:未知异常按"整条通道有问题"处理,会触发熔断停下来等人看;
    // 按单帖失败处理则会一条条把队列烧光。停下来的代价可恢复,烧光的不可。
    const publish = vi
      .fn<() => Promise<PostOutcome>>()
      .mockRejectedValue(new Error("tab crashed"));
    const c = new QueueClient({ store, fetchImpl });
    const r = await c.processOne(CFG, post({ id: 6 }), publish);
    expect(r.result).toBe("channel_error");
    expect(r.error).toContain("tab crashed");
  });
});

describe("QueueClient.flushPending", () => {
  it("把积压的本地记录逐条补 ack,成功的清掉", async () => {
    const store = memStore();
    await store.rememberPosted(1, "a");
    await store.rememberPosted(2, "b");
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));
    const c = new QueueClient({ store, fetchImpl });
    expect(await c.flushPending(CFG)).toBe(2);
    expect(await store.listPending()).toEqual([]);
  });

  it("补 ack 失败的保留,下次再来", async () => {
    const store = memStore();
    await store.rememberPosted(1, "a");
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({}, 500));
    const c = new QueueClient({ store, fetchImpl });
    expect(await c.flushPending(CFG)).toBe(0);
    expect(await store.listPending()).toHaveLength(1);
  });
});
