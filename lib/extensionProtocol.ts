// Web 端 ↔ 浏览器插件 的握手协议 —— **单一来源**。
//
// extension/src/shared/protocol.ts 从本文件逐字复制,两边由
// lib/extensionProtocol.test.ts 比对钉死。不这么做的话,改个字符串就会
// 变成「按钮点了没反应、双方都不报错」——扩展里最难查的一类故障。
// (做法借鉴 aisee 的 src/shared/extension/brand.ts。)
//
// 流向:/manage 的「推送配置到插件」按钮 → window.postMessage →
// 插件的 content script(matches 只写自己的域名)→ chrome.runtime.sendMessage
// → background 存进 chrome.storage → popup 显示「已连接」。
//
// 为什么值得做:省掉「手抄服务器地址 + 手抄 API key」两步,而且这两个值是
// 从**签发它们的那个页面**直接推过来的,不可能抄错。

export const WW_EXTENSION_MESSAGE = {
  /** 所有消息都带的来源标记 —— 插件据此忽略页面上其他脚本的噪声。 */
  source: "whalewatch-web",
  /** 页面 → 插件:这是配置,收下。 */
  configure: "whalewatch:configure",
  /** 插件 → 页面:收到了,这是我现在的状态。 */
  ack: "whalewatch:configured",
} as const;

export interface WwExtensionConfig {
  /** 服务器根地址,无尾斜杠,例如 https://whalewatch.wired.fund */
  baseUrl: string;
  /** 带 can_x_queue 能力位的 API key 明文。 */
  apiKey: string;
}

export interface WwExtensionAck {
  ok: boolean;
  /** 插件版本,便于运营者确认装的是不是最新的。 */
  version?: string;
  error?: string;
}
