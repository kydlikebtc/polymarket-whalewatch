// 配置桥:/manage 的「推送配置到插件」按钮 → 这里 → background。
//
// 只在自己的域名上注册(manifest 的 matches 由构建期的 WW_BASE_URL 生成)。
// 即便如此,来源校验仍然要做满三条 —— content script 与页面共享 window,
// 页面上任何第三方脚本(以及被 XSS 注入的脚本)都能发 postMessage:
//   1. event.source === window   —— 拒绝 iframe / 其他窗口发来的
//   2. event.origin 与本页同源   —— 拒绝跨源
//   3. data.source 标记匹配      —— 拒绝页面上其他脚本的噪声
// 三条都过了才转给 background。
import {
  WW_EXTENSION_MESSAGE,
  type WwExtensionAck,
  type WwExtensionConfig,
} from "../shared/protocol";

interface IncomingMessage {
  source?: unknown;
  action?: unknown;
  payload?: unknown;
}

function isConfig(v: unknown): v is WwExtensionConfig {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.baseUrl === "string" &&
    o.baseUrl.length > 0 &&
    typeof o.apiKey === "string" &&
    o.apiKey.length > 0
  );
}

function reply(payload: WwExtensionAck): void {
  window.postMessage(
    {
      source: WW_EXTENSION_MESSAGE.source,
      action: WW_EXTENSION_MESSAGE.ack,
      payload,
    },
    window.location.origin,
  );
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const data = event.data as IncomingMessage | undefined;
  if (
    data?.source !== WW_EXTENSION_MESSAGE.source ||
    data?.action !== WW_EXTENSION_MESSAGE.configure
  ) {
    return;
  }
  if (!isConfig(data.payload)) {
    reply({ ok: false, error: "配置不完整（需要 baseUrl 与 apiKey）" });
    return;
  }
  chrome.runtime.sendMessage(
    { type: "ww:configure", config: data.payload },
    (res: WwExtensionAck | undefined) => {
      // service worker 被浏览器回收时 sendMessage 会走 lastError 而不是抛异常。
      // 不读它的话控制台会留一条 "Unchecked runtime.lastError",而页面那头
      // 只会看到超时 —— 两边都查不出原因。
      const err = chrome.runtime.lastError;
      if (err) {
        reply({ ok: false, error: `插件未响应：${err.message}` });
        return;
      }
      reply(res ?? { ok: false, error: "插件没有返回结果" });
    },
  );
});

console.log("[whalewatch] 配置桥已就绪");
