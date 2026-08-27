import { describe, it, expect } from "vitest";
import {
  authHeaders,
  buildUrl,
  DEFAULT_BASE_URL,
  httpGetText,
  NEED_KEY_HINT,
  readEnv,
} from "./lib";

describe("readEnv", () => {
  it("缺省指向线上,空串视同未配置", () => {
    expect(readEnv({})).toEqual({ baseUrl: DEFAULT_BASE_URL, apiKey: null });
    expect(
      readEnv({ WHALEWATCH_BASE_URL: "  ", WHALEWATCH_API_KEY: "" }),
    ).toEqual({ baseUrl: DEFAULT_BASE_URL, apiKey: null });
  });
  it("自托管覆盖 base,尾斜杠归一(否则拼出 //api/health)", () => {
    expect(
      readEnv({ WHALEWATCH_BASE_URL: "http://localhost:3000///" }).baseUrl,
    ).toBe("http://localhost:3000");
  });
  it("key 去空白后透传", () => {
    expect(readEnv({ WHALEWATCH_API_KEY: " k1 " }).apiKey).toBe("k1");
  });
});

describe("buildUrl", () => {
  it("undefined 参数跳过 —— 不产生 ?a=undefined 脏 URL", () => {
    expect(
      buildUrl(DEFAULT_BASE_URL, "/api/signals", { windowHours: undefined }),
    ).toBe(`${DEFAULT_BASE_URL}/api/signals`);
  });
  it("数字参数字符串化,多参数稳定拼接", () => {
    const u = buildUrl("http://x", "/api/signals", { windowHours: 6 });
    expect(u).toBe("http://x/api/signals?windowHours=6");
  });
});

describe("authHeaders", () => {
  it("走服务端认的 x-feed-token 头;无 key 给空对象", () => {
    expect(authHeaders("k1")).toEqual({ "x-feed-token": "k1" });
    expect(authHeaders(null)).toEqual({});
  });
});

describe("NEED_KEY_HINT", () => {
  it("指引必须点名 env 变量与文档位置 —— agent 要能转告用户缺什么", () => {
    expect(NEED_KEY_HINT).toContain("WHALEWATCH_API_KEY");
    expect(NEED_KEY_HINT).toContain("api-docs");
  });
});

describe("httpGetText", () => {
  it("2xx 原样透传响应体", async () => {
    const r = await httpGetText(
      "http://x/api/health",
      {},
      (async () =>
        new Response('{"ok":true}', { status: 200 })) as typeof fetch,
    );
    expect(r).toEqual({ ok: true, status: 200, body: '{"ok":true}' });
  });
  it("非 2xx 也带回响应体 —— 429 背压/401 指引本身就是答案", async () => {
    const r = await httpGetText(
      "http://x/api/signals",
      {},
      (async () =>
        new Response("rate limited", { status: 429 })) as typeof fetch,
    );
    expect(r).toEqual({ ok: false, status: 429, body: "rate limited" });
  });
  it("网络层错误不抛,折成一段能读的话", async () => {
    const r = await httpGetText("http://x/api/health", {}, (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.body).toContain("ECONNREFUSED");
    expect(r.body).toContain("http://x/api/health");
  });
  it("鉴权头真的送出去了", async () => {
    let seen: Record<string, string> | undefined;
    await httpGetText("http://x/api/signals", { "x-feed-token": "k1" }, (async (
      _url: unknown,
      init?: RequestInit,
    ) => {
      seen = init?.headers as Record<string, string>;
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    expect(seen).toMatchObject({ "x-feed-token": "k1" });
  });
});
