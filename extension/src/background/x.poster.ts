// 在浏览器里发 X 帖 —— 开后台标签页 + chrome.scripting 驱动 x.com 自己的
// 编辑器。移植自 aisee-live/aisee-browser-extension 的
// src/pages/background/x.poster.ts,三个坑都是那边流过血才知道的:
//
//  1. **不能用 content script**:x.com 的 CSP 会挡掉 crxjs 的动态 import
//     loader,content script 根本不会执行。executeScript 注入 isolated
//     world 不受页面 script-src 约束。
//  2. **不能用 execCommand('insertText') 填多行**:X 的编辑器是 Draft.js,
//     它会从光标所在 block 重建 ContentState,**静默丢掉前面所有段落**,
//     最后只发出去最后一行。必须伪造 paste 事件走 Draft 的粘贴处理器。
//     我们的模板全是多行结构化布局,正中此坑。
//  3. **发帖确认靠 MAIN world 拦截 CreateTweet**:点击前 patch fetch + XHR,
//     抓 rest_id。抓到才敢关标签页;抓不到就是不确定态,绝不能当失败重试。
//
// 架构立场同样照搬:**只让 X 自己的 JS 去构造和签名请求**,绝不从 background
// 重放 X 的内部 API —— x-client-transaction-id 之类的反爬签名由 X 自己算,
// 比逆向可靠一个数量级,也少一层风控信号。
import type { PostOutcome } from "./queue.client";

/** 编辑器/发送按钮的等待上限。X 冷启动慢时 10s 也可能不够,但再长就该报错了。 */
const COMPOSER_TIMEOUT_MS = 10_000;
const SEND_BUTTON_TIMEOUT_MS = 6_000;
const CAPTURE_TIMEOUT_MS = 6_000;
const TAB_LOAD_TIMEOUT_MS = 15_000;
/** 关标签页前的宽限:让尾随的 in-flight 请求落地,避免关闭打断真实发送。 */
const TAB_CLOSE_GRACE_MS = 1_500;

export interface XComposeInput {
  text: string;
  /** 服务端给的图卡地址(weekly)。插件自己下载,再塞进 X 的 file input。 */
  imageUrl?: string | null;
  /**
   * false = 只填不发(dry-run):把帖文填进编辑器就停,前台弹出来给人看。
   * X 每次改版后先跑这个验 DOM 适配,零发帖风险。
   */
  autoSubmit?: boolean;
}

// ---------------------------------------------------------------------------
// 以下三个函数会被 executeScript **序列化后**在页面里执行,所以必须完全
// 自包含:不能引用任何外部作用域的变量、导入或常量。
// ---------------------------------------------------------------------------

/** 在页面里:填入帖文,(可选)点 X 自己的 Post 按钮。 */
export function fillComposerInPage(
  text: string,
  autoSubmit: boolean,
): Promise<"sent" | "filled" | "not_found"> {
  const findComposer = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(
      '[data-testid="tweetTextarea_0"][contenteditable="true"]',
    ) ??
    document.querySelector<HTMLElement>(
      '[data-testid^="tweetTextarea_"][contenteditable="true"]',
    ) ??
    document.querySelector<HTMLElement>(
      'div[role="textbox"][contenteditable="true"]',
    );

  const findSendButton = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-testid="tweetButtonInline"]') ??
    document.querySelector<HTMLElement>('[data-testid="tweetButton"]');

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // 轮询式等待:也能捕捉属性变化(比如发送按钮从 aria-disabled="true"
  // 变成可点),这是 MutationObserver 写起来更啰嗦的场景。
  const waitFor = async (
    find: () => HTMLElement | null,
    timeoutMs: number,
  ): Promise<HTMLElement | null> => {
    const start = Date.now();
    for (;;) {
      const el = find();
      if (el) return el;
      if (Date.now() - start > timeoutMs) return null;
      await sleep(150);
    }
  };

  return (async () => {
    const composer = await waitFor(findComposer, 10_000);
    if (!composer) return "not_found";

    composer.focus();
    const selectAllContents = () => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection?.removeAllRanges();
      selection?.addRange(range);
    };
    selectAllContents();

    // Draft.js 的多行坑:单次 execCommand('insertText') 传多行文本只会被
    // 部分应用 —— Draft 从光标所在的 DOM block(最后一行)重建 ContentState,
    // 静默丢掉之前的每一段。改为模拟 PASTE:Draft 的粘贴处理器会把整个
    // 字符串吃进去并正确切分成多个 block。
    let filled = false;
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      composer.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        }),
      );
      await sleep(50); // Draft 异步重渲染
      filled = (composer.textContent || "").replace(/\s/g, "").length > 0;
    } catch {
      filled = false;
    }

    // 兜底:某些浏览器/编辑器忽略合成 paste。单行文本走这条路一直是好的。
    if (!filled) {
      selectAllContents();
      const inserted =
        document.execCommand?.("insertText", false, text) ?? false;
      if (!inserted) composer.textContent = text;
      composer.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: text,
        }),
      );
    }

    if (!autoSubmit) return "filled";

    // 等按钮存在**且可点**。超长文本/上传未完成都会让它一直 disabled。
    const sendButton = await waitFor(() => {
      const btn = findSendButton();
      if (!btn) return null;
      const disabled =
        btn.getAttribute("aria-disabled") === "true" ||
        (btn as HTMLButtonElement).disabled === true;
      return disabled ? null : btn;
    }, 6_000);

    if (!sendButton) return "filled";

    sendButton.click();
    await sleep(1_500); // 给 X 发请求的时间
    return "sent";
  })();
}

/** 在 MAIN world:patch fetch/XHR 抓 CreateTweet 响应。必须在点击前装好。 */
export function installCreateTweetInterceptor(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__wwInterceptorInstalled) return;
  w.__wwInterceptorInstalled = true;
  w.__wwCreatedTweet = null;

  const extract = (json: unknown) => {
    try {
      const r = (json as Record<string, any>)?.data?.create_tweet?.tweet_results
        ?.result;
      const restId = r?.rest_id || r?.legacy?.id_str;
      const user = r?.core?.user_results?.result;
      const screenName =
        user?.legacy?.screen_name || user?.core?.screen_name || "";
      if (restId) {
        w.__wwCreatedTweet = {
          rest_id: String(restId),
          screen_name: String(screenName),
        };
      }
    } catch {
      /* ignore */
    }
  };

  const origFetch = w.fetch as typeof fetch;
  w.fetch = function (this: unknown, ...args: unknown[]) {
    return (origFetch as any).apply(this, args).then((res: Response) => {
      try {
        const first = args[0] as string | { url?: string };
        const url = typeof first === "string" ? first : first?.url;
        if (typeof url === "string" && url.indexOf("CreateTweet") !== -1) {
          res
            .clone()
            .json()
            .then(extract)
            .catch(() => {});
        }
      } catch {
        /* ignore */
      }
      return res;
    });
  } as typeof fetch;

  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: any, ...a: any[]) {
    this.__wwUrl = a[1];
    return OrigOpen.apply(this, a as any);
  };
  XMLHttpRequest.prototype.send = function (this: any, ...a: any[]) {
    this.addEventListener("load", function (this: any) {
      try {
        if (
          typeof this.__wwUrl === "string" &&
          this.__wwUrl.indexOf("CreateTweet") !== -1
        ) {
          extract(JSON.parse(this.responseText));
        }
      } catch {
        /* ignore */
      }
    });
    return OrigSend.apply(this, a as any);
  };
}

/** 在 MAIN world:轮询取回捕获到的推文(~6s)。 */
export function readCapturedTweet(): Promise<{
  rest_id: string;
  screen_name: string;
} | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const v = (window as unknown as Record<string, any>).__wwCreatedTweet;
      if (v && v.rest_id) return resolve(v);
      if (Date.now() - start > 6_000) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
}

/** 在页面里:把图片当成用户选文件那样塞进 file input,让 X 跑自己的上传管线。 */
export function attachImageInPage(
  files: { name: string; mime: string; b64: string }[],
): Promise<"attached" | "no_input" | "no_preview"> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return (async () => {
    const input =
      document.querySelector<HTMLInputElement>(
        'input[data-testid="fileInput"]',
      ) ??
      document.querySelector<HTMLInputElement>(
        'input[type="file"][accept*="image"]',
      ) ??
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) return "no_input";

    const dt = new DataTransfer();
    for (const f of files) {
      const bin = atob(f.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name, { type: f.mime }));
    }
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const start = Date.now();
    for (;;) {
      if (document.querySelector('[data-testid="attachments"]'))
        return "attached";
      if (Date.now() - start > 15_000) return "no_preview";
      await sleep(250);
    }
  })();
}

// ---------------------------------------------------------------------------
// 以下在 background(service worker)里跑,无自包含约束。
// ---------------------------------------------------------------------------

/** 下载图片并编码给 executeScript 传输(参数走 JSON,字节必须转 base64)。 */
export async function fetchImageForPage(
  url: string,
): Promise<{ name: string; mime: string; b64: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`图片下载失败 (${res.status}): ${url}`);
  const blob = await res.blob();
  const mime = blob.type || "image/png";
  const last = url.split("/").pop()?.split(/[?#]/)[0] || "";
  const name = last.includes(".")
    ? last
    : `${last || "card"}.${mime.split("/")[1] || "png"}`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000; // String.fromCharCode 的参数个数上限
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return { name, mime, b64: btoa(bin) };
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    // 结构类型而不是 chrome.tabs.TabChangeInfo:该别名在 @types/chrome
    // 的版本之间改过名,而我们只读 status 一个字段。
    const listener = (updatedTabId: number, info: { status?: string }) => {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function focusTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) {
    console.warn("[whalewatch][x] focusTab 失败", e);
  }
}

async function closeTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    console.warn("[whalewatch][x] closeTab 失败", e);
  }
}

/**
 * 发一条新帖。返回的 PostOutcome 直接对应服务端的四种 ack result。
 *
 * 关键的语义分派(见设计文档 §8 错误分类表):
 *   找不到编辑器 / 找不到 file input → channel_error(**通道级**,会触发熔断)
 *   编辑器填好但按钮始终不亮        → failed(单帖问题,队列继续)
 *   点了但没抓到回执                → unconfirmed(不确定,人工核对)
 */
export async function postXCompose(input: XComposeInput): Promise<PostOutcome> {
  const text = (input.text || "").trim();
  if (!text) return { result: "failed", error: "帖文为空" };
  const autoSubmit = input.autoSubmit !== false;

  // 图片在开标签页**之前**取:坏地址能快速干净地失败,不留一个空标签页。
  const files: { name: string; mime: string; b64: string }[] = [];
  if (input.imageUrl) {
    try {
      files.push(await fetchImageForPage(input.imageUrl));
    } catch (e) {
      return { result: "failed", error: msg(e) };
    }
  }

  let tabId: number | undefined;
  try {
    // autoSubmit 时开**后台**标签页:整个来回你不用看见,成功后自动关掉。
    // dry-run 则开前台 —— 那本来就是给人看的。
    const tab = await chrome.tabs.create({
      url: "https://x.com/compose/post",
      active: !autoSubmit,
    });
    tabId = tab.id ?? undefined;
  } catch (e) {
    return { result: "channel_error", error: `打开 X 标签页失败: ${msg(e)}` };
  }
  if (tabId == null) {
    return { result: "channel_error", error: "打开 X 标签页失败(无 tabId)" };
  }

  await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);

  try {
    if (autoSubmit) {
      // 拦截器必须在点击**之前**装好。
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: installCreateTweetInterceptor,
      });
    }

    if (files.length > 0) {
      const [attach] = await chrome.scripting.executeScript({
        target: { tabId },
        func: attachImageInPage,
        args: [files],
      });
      if (attach?.result === "no_input") {
        await focusTab(tabId);
        return {
          result: "channel_error",
          error: "X 编辑器上找不到文件输入框（DOM 可能改版了）",
        };
      }
      // 'no_preview' 继续往下走:上传未完成会让 Post 按钮保持 disabled,
      // 下面等按钮的逻辑要么等到、要么落到 'filled'。
    }

    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fillComposerInPage,
      args: [text, autoSubmit],
    });
    const status = injection?.result;
    console.log(`[whalewatch][x] 注入结果: ${status}`);

    if (status === "not_found") {
      // 找不到编辑器最常见的原因是**掉登录**(跳到了登录页)。这是整条通道
      // 坏了,不是这一条帖的问题 —— 报 channel_error 让熔断停下来等人处理,
      // 而不是把队列里每一条都依次标成 failed。
      await focusTab(tabId);
      return {
        result: "channel_error",
        error: "找不到 X 编辑器（多半是掉登录了，或 DOM 改版）",
      };
    }

    if (status === "filled") {
      if (!autoSubmit) {
        await focusTab(tabId);
        return { result: "failed", error: "dry-run：已填入，未发送" };
      }
      // 按钮始终不亮:超长、重复内容、上传卡住 —— 都是**这一条**的问题。
      await focusTab(tabId);
      return {
        result: "failed",
        error: "帖文已填入但 Post 按钮始终不可点（超长/重复内容/图片未上传完）",
      };
    }

    // status === 'sent':点过了,现在看抓没抓到回执。
    let xPostId: string | undefined;
    try {
      const [cap] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: readCapturedTweet,
      });
      xPostId = cap?.result?.rest_id;
    } catch (e) {
      console.error("[whalewatch][x] 读取回执失败", e);
    }

    if (xPostId) {
      // 抓到回执 = 服务端已落库,可以安全关掉。等一小会儿让尾随请求落地。
      await wait(TAB_CLOSE_GRACE_MS);
      await closeTab(tabId);
      return { result: "posted", xPostId };
    }

    // 点了但没看到 CreateTweet 响应 —— **不确定**发出去没有。
    // 不关标签页(可能还在飞),推到前台让人核对一眼。
    await focusTab(tabId);
    return {
      result: "unconfirmed",
      error: "已点击发送但未捕获到回执，请到 X 上确认一眼",
    };
  } catch (e) {
    console.error("[whalewatch][x] executeScript 失败", e);
    await focusTab(tabId);
    return { result: "channel_error", error: `注入失败: ${msg(e)}` };
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
