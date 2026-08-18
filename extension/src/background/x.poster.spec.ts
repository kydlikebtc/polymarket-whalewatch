// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fillComposerInPage,
  installCreateTweetInterceptor,
  readCapturedTweet,
} from "./x.poster";

// 我们的帖文模板全是多行结构化布局 —— 这正是 Draft.js 那个坑的正中靶心。
const MULTILINE = [
  "🐳 WHALE BUY · $184K",
  "",
  "Chiefs win Super Bowl LX?",
  "└ YES @ 67¢",
  "",
  "📊 12% of 24h vol · ⏳ 5h to settle",
  "",
  "#Polymarket #NFL",
].join("\n");

function mountComposer(opts: { onPaste?: "draft" | "ignore" } = {}) {
  const el = document.createElement("div");
  el.setAttribute("data-testid", "tweetTextarea_0");
  el.setAttribute("contenteditable", "true");
  if (opts.onPaste !== "ignore") {
    // 模拟 Draft 的粘贴处理器:整段吃进去(真实 Draft 会切成多个 block,
    // 这里只关心"文本有没有完整到达"这一点)。
    el.addEventListener("paste", (e) => {
      const dt = (e as ClipboardEvent).clipboardData;
      if (dt) el.textContent = dt.getData("text/plain");
    });
  }
  document.body.appendChild(el);
  return el;
}

function mountSendButton(enabled: boolean) {
  const btn = document.createElement("div");
  btn.setAttribute("data-testid", "tweetButtonInline");
  if (!enabled) btn.setAttribute("aria-disabled", "true");
  document.body.appendChild(btn);
  return btn;
}

beforeEach(() => {
  document.body.replaceChildren();
  // jsdom 不实现 execCommand;兜底路径要能被调用而不炸。
  if (!("execCommand" in document)) {
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
  }
});

describe("fillComposerInPage —— Draft.js 多行回归", () => {
  it("多行帖文走 paste 路径后每一行都在（首行不能被吞）", async () => {
    // 这是 aisee 流过血的坑:execCommand('insertText') 传多行时,Draft 会从
    // 光标所在 block(最后一行)重建 ContentState,**静默丢掉前面所有段落**,
    // 帖子最后只剩最后一行。用 paste 才能让 Draft 完整吃下。
    const el = mountComposer();
    const status = await fillComposerInPage(MULTILINE, false);
    expect(status).toBe("filled");
    expect(el.textContent).toBe(MULTILINE);
    // 逐行断言:退化成"只剩最后一行"时,下面每一条都会挂
    expect(el.textContent).toContain("🐳 WHALE BUY · $184K");
    expect(el.textContent).toContain("└ YES @ 67¢");
    expect(el.textContent).toContain("#Polymarket #NFL");
  });

  it("paste 被忽略时走 execCommand 兜底,内容仍然落地", async () => {
    const el = mountComposer({ onPaste: "ignore" });
    const status = await fillComposerInPage(MULTILINE, false);
    expect(status).toBe("filled");
    expect(el.textContent).toContain("WHALE BUY");
  });

  it("找不到编辑器 → not_found（调用方据此报通道级故障）", async () => {
    const status = await fillComposerInPage("hi", false);
    expect(status).toBe("not_found");
  }, 20_000);

  it("autoSubmit 且按钮可点 → 点击并返回 sent", async () => {
    mountComposer();
    const btn = mountSendButton(true);
    const clicked = vi.fn();
    btn.addEventListener("click", clicked);
    const status = await fillComposerInPage("hi", true);
    expect(status).toBe("sent");
    expect(clicked).toHaveBeenCalledOnce();
  }, 20_000);

  it("按钮始终 disabled → filled（不点，交由调用方标为单帖失败）", async () => {
    mountComposer();
    const btn = mountSendButton(false);
    const clicked = vi.fn();
    btn.addEventListener("click", clicked);
    const status = await fillComposerInPage("hi", true);
    expect(status).toBe("filled");
    expect(clicked).not.toHaveBeenCalled();
  }, 20_000);

  it("按钮中途变为可点 → 轮询能捕捉到属性变化", async () => {
    mountComposer();
    const btn = mountSendButton(false);
    setTimeout(() => btn.removeAttribute("aria-disabled"), 400);
    const status = await fillComposerInPage("hi", true);
    expect(status).toBe("sent");
  }, 20_000);
});

describe("installCreateTweetInterceptor", () => {
  it("抓到 CreateTweet 响应里的 rest_id 与 screen_name", async () => {
    const payload = {
      data: {
        create_tweet: {
          tweet_results: {
            result: {
              rest_id: "1899000",
              core: {
                user_results: {
                  result: { legacy: { screen_name: "PolyWhaleFeedHQ" } },
                },
              },
            },
          },
        },
      },
    };
    const w = window as unknown as Record<string, unknown>;
    w.__wwInterceptorInstalled = undefined;
    w.__wwCreatedTweet = null;
    w.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
      }),
    );
    installCreateTweetInterceptor();

    await (w as unknown as { fetch: typeof fetch }).fetch(
      "https://x.com/i/api/graphql/abc/CreateTweet",
      { method: "POST" },
    );
    const captured = await readCapturedTweet();
    expect(captured).toEqual({
      rest_id: "1899000",
      screen_name: "PolyWhaleFeedHQ",
    });
  }, 20_000);

  it("重复安装是幂等的（不会套娃 patch fetch）", () => {
    const w = window as unknown as Record<string, unknown>;
    w.__wwInterceptorInstalled = undefined;
    w.fetch = vi.fn();
    installCreateTweetInterceptor();
    const first = w.fetch;
    installCreateTweetInterceptor();
    expect(w.fetch).toBe(first);
  });

  it("非 CreateTweet 的请求不留痕", async () => {
    const w = window as unknown as Record<string, unknown>;
    w.__wwInterceptorInstalled = undefined;
    w.__wwCreatedTweet = null;
    w.fetch = vi.fn().mockResolvedValue(new Response("{}"));
    installCreateTweetInterceptor();
    await (w as unknown as { fetch: typeof fetch }).fetch("https://x.com/home");
    expect(w.__wwCreatedTweet).toBeNull();
  });
});
