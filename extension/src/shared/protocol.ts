// Web 端 ↔ 插件 的握手协议。
//
// **本文件是 ../../lib/extensionProtocol.ts 的逐字副本**,由
// protocol.spec.ts 比对钉死。改一边不改另一边的后果是「按钮点了没反应、
// 两边都不报错」—— 扩展里最难查的一类故障。
// (做法借鉴 aisee 的 src/shared/extension/brand.ts。)

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

// --- 队列端点的载荷形状(服务端 lib/xQueueRoute.ts 的镜像) --------------

export interface QueuedPost {
  id: number;
  kind: string;
  text: string;
  /** weekly 帖的图卡地址;其余 kind 为 null。 */
  imageUrl: string | null;
}

export interface QueueResponse {
  posts: QueuedPost[];
  serverTime: number;
}

/** 四种结局,与插件对页面的观察一一对应(见设计文档 §8 错误分类表)。 */
export type AckResult = "posted" | "unconfirmed" | "failed" | "channel_error";

export interface AckBody {
  id: number;
  result: AckResult;
  xPostId?: string;
  error?: string;
}
