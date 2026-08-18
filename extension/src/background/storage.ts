// chrome.storage.local 封装。
//
// 三类数据:
//   config   —— 服务器地址 + API key(由 /manage 的配置桥推过来)
//   posted   —— 「已发过但 ack 未确认」的记忆(防重发的关键,见 queue.client)
//   settings —— dry-run 开关
//   recent   —— 最近结果,只给 popup 看
//
// 用 local 不用 sync:sync 有 8KB/项、100KB 总量的配额,而且把 API key
// 同步到用户所有设备上不是我们想要的(这把 key 是给这一台机器的)。
import type { WwExtensionConfig } from "../shared/protocol";
import type { QueueStore } from "./queue.client";

const K_CONFIG = "ww:config";
const K_POSTED = "ww:posted";
const K_SETTINGS = "ww:settings";
const K_RECENT = "ww:recent";

export interface Settings {
  /** true = 只填不发。X 改版后先用它验 DOM 适配,零发帖风险。 */
  dryRun: boolean;
  /** false = 暂停消费(运营者手动)。 */
  enabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = { dryRun: false, enabled: true };

export interface RecentEntry {
  id: number;
  kind: string;
  result: string;
  at: number;
  detail?: string;
}

const RECENT_LIMIT = 20;

async function get<T>(key: string): Promise<T | undefined> {
  const o = await chrome.storage.local.get(key);
  return o[key] as T | undefined;
}

export async function getConfig(): Promise<WwExtensionConfig | null> {
  const c = await get<WwExtensionConfig>(K_CONFIG);
  return c && c.baseUrl && c.apiKey ? c : null;
}

export async function setConfig(c: WwExtensionConfig): Promise<void> {
  // 统一去掉尾斜杠,后面所有拼接都假设没有它。
  await chrome.storage.local.set({
    [K_CONFIG]: { baseUrl: c.baseUrl.replace(/\/+$/, ""), apiKey: c.apiKey },
  });
}

export async function clearConfig(): Promise<void> {
  await chrome.storage.local.remove(K_CONFIG);
}

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await get<Partial<Settings>>(K_SETTINGS)) };
}

export async function setSettings(s: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...s };
  await chrome.storage.local.set({ [K_SETTINGS]: next });
  return next;
}

export async function pushRecent(e: RecentEntry): Promise<void> {
  const list = (await get<RecentEntry[]>(K_RECENT)) ?? [];
  await chrome.storage.local.set({
    [K_RECENT]: [e, ...list].slice(0, RECENT_LIMIT),
  });
}

export async function getRecent(): Promise<RecentEntry[]> {
  return (await get<RecentEntry[]>(K_RECENT)) ?? [];
}

/**
 * 防重发记忆的 chrome.storage 实现。
 *
 * 存成一个对象而不是每条一个 key:条目寿命很短(ack 成功即删),数量以个位数
 * 计,一次读写整个对象比维护一堆 key 简单;而且「读-改-写」在 service worker
 * 单线程里没有并发问题(消费循环本身是串行的)。
 */
export const chromeQueueStore: QueueStore = {
  async getPosted(id) {
    const m = (await get<Record<string, string>>(K_POSTED)) ?? {};
    return Object.prototype.hasOwnProperty.call(m, String(id))
      ? (m[String(id)] as string)
      : null;
  },
  async rememberPosted(id, xPostId) {
    const m = (await get<Record<string, string>>(K_POSTED)) ?? {};
    m[String(id)] = xPostId;
    await chrome.storage.local.set({ [K_POSTED]: m });
  },
  async forgetPosted(id) {
    const m = (await get<Record<string, string>>(K_POSTED)) ?? {};
    delete m[String(id)];
    await chrome.storage.local.set({ [K_POSTED]: m });
  },
  async listPending() {
    const m = (await get<Record<string, string>>(K_POSTED)) ?? {};
    return Object.entries(m).map(([id, xPostId]) => ({
      id: Number(id),
      xPostId,
    }));
  },
};
