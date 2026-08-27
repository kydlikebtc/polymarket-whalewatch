// whalewatch MCP server 的纯函数层 —— URL 构造 / 鉴权头 / HTTP 包装。
// 与 server.ts 分开是为了可测:协议接线没什么好测的,这里的每个决定都有。
//
// 设计裁决(docs/plans/2026-08-27-outlet-trio-design.md):stdio 进程走公开
// HTTPS API,与监控部署完全解耦 —— 本文件严禁 import 站内任何 lib/(它跑在
// 用户机器上,那些模块假定同机 SQLite)。

export const DEFAULT_BASE_URL = "https://whalewatch.wired.fund";

export interface McpEnv {
  baseUrl: string;
  apiKey: string | null;
}

/** 环境解析:尾斜杠归一,空串视同未配置。 */
export function readEnv(env: Record<string, string | undefined>): McpEnv {
  const rawBase = (env.WHALEWATCH_BASE_URL ?? "").trim();
  const baseUrl = (rawBase || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const rawKey = (env.WHALEWATCH_API_KEY ?? "").trim();
  return { baseUrl, apiKey: rawKey || null };
}

/** 拼查询串,undefined 参数直接跳过(不产生 `?a=undefined` 这种脏 URL)。 */
export function buildUrl(
  baseUrl: string,
  path: string,
  params?: Record<string, string | number | undefined>,
): string {
  const url = new URL(baseUrl + path);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined) continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** 鉴权头。服务端认 `x-feed-token`(lib/feedAuth.ts),无 key 给空对象。 */
export function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { "x-feed-token": apiKey } : {};
}

// 「有这个能力但你没配钥匙」≠「没有这个能力」:keyed 工具在无 key 时保留在
// 工具列表里,调用时返回这段指引 —— agent 能把缺什么转告用户。
export const NEED_KEY_HINT =
  "This tool requires an API key. Set the WHALEWATCH_API_KEY environment " +
  "variable when registering this MCP server. Keys are issued by the " +
  "whalewatch operator — see https://whalewatch.wired.fund/api-docs " +
  "(docs/api-access.md) for tiers and scopes. Public tools (get_health, " +
  "get_continuity, get_record) work without a key.";

export interface HttpResult {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * GET 并返回原文(JSON 原样透传 —— agent 自己解析,比这里二次整形保真)。
 * 网络层错误不抛:MCP 工具的失败应该是「一段能读的话」,不是栈轨迹。
 */
export async function httpGetText(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<HttpResult> {
  try {
    const res = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, body: `request failed: ${msg} (${url})` };
  }
}
