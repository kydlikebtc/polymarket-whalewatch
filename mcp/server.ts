#!/usr/bin/env node
// whalewatch MCP server —— 把只读 API 暴露给任何 MCP 客户端(Claude Code /
// Claude Desktop / 其他 agent)。stdio 传输,跑在使用者机器上:
//
//   已发布包:claude mcp add whalewatch -- npx -y whalewatch-mcp
//   仓库内跑:claude mcp add whalewatch -e WHALEWATCH_API_KEY=<key> -- npx tsx mcp/server.ts
//
// 工具面 = 现有端点 1:1(docs/api-access.md),不发明新语义。公开三件
// (health/continuity/record)无需 key;信号三件走 x-feed-token。
// stdout 是协议通道 —— 人类可读的日志一律走 stderr。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// .js 后缀:npm 包以 NodeNext ESM 发布(tsc 原样保留说明符);仓库内
// tsx/vitest/根 tsc 同样接受该写法,两个世界一份源码。
import {
  authHeaders,
  buildUrl,
  httpGetText,
  NEED_KEY_HINT,
  readEnv,
} from "./lib.js";

const env = readEnv(process.env);

const server = new McpServer({ name: "whalewatch", version: "0.1.0" });

// 刻意不写显式返回类型:SDK 的 CallToolResult 带索引签名,自定义窄接口在
// NodeNext 严格模式下装不进去 —— 让结构推断自己对上。
const textResult = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError ? { isError: true } : {}),
});

async function callApi(
  path: string,
  params?: Record<string, string | number | undefined>,
  needsKey = false,
) {
  if (needsKey && !env.apiKey) return textResult(NEED_KEY_HINT, true);
  const r = await httpGetText(
    buildUrl(env.baseUrl, path, params),
    authHeaders(needsKey ? env.apiKey : null),
  );
  // 非 2xx 也原样透传响应体 —— 上游的错误信息(429 背压/401 指引)本身就是答案。
  return textResult(r.ok ? r.body : `HTTP ${r.status}\n${r.body}`, !r.ok);
}

// ---- 公开工具(无需 key) ----------------------------------------------------

server.registerTool(
  "get_health",
  {
    title: "Engine health",
    description:
      "Liveness of the whalewatch monitoring engine: per-loop heartbeats, stale flags, process start time. HTTP 503 body means a loop stalled.",
    inputSchema: {},
  },
  () => callApi("/api/health"),
);

server.registerTool(
  "get_continuity",
  {
    title: "Data continuity (30-day clock)",
    description:
      "Day-by-day data coverage over the last 60 UTC days, the current uninterrupted streak, its start day, and whether the 30-day re-derivation gate is reached. Verdicts are conservative and share /api/health's stall yardstick.",
    inputSchema: {},
  },
  () => callApi("/api/continuity"),
);

server.registerTool(
  "get_record",
  {
    title: "Public track record",
    description:
      "Published-signal scorecard per strategy (pushed count, 30d price-adjusted record, recent settlements) plus the daily sha256 digest chain tail for tamper-evidence. Denominator = published signals only.",
    inputSchema: {},
  },
  () => callApi("/api/record"),
);

// ---- 信号工具(需 WHALEWATCH_API_KEY) ---------------------------------------

server.registerTool(
  "get_signals",
  {
    title: "Signal feed",
    description:
      "Main machine feed: raw bus[] events, folded active[] view, settled list, per-strategy paper entries and 30d records. Requires an API key; delayed-tier keys see a time-shifted world.",
    inputSchema: {
      windowHours: z
        .number()
        .int()
        .min(1)
        .max(24)
        .optional()
        .describe("Active-window size in hours (default 24)"),
    },
  },
  ({ windowHours }) => callApi("/api/signals", { windowHours }, true),
);

server.registerTool(
  "list_signals",
  {
    title: "Signal catalog",
    description:
      "What THIS key actually receives: enabled raw signal definitions (type + threshold) and strategy tiers (stable ASCII `code` + source family). Use `code` to identify tiers, never numeric ids.",
    inputSchema: {},
  },
  () => callApi("/api/signals/list", undefined, true),
);

server.registerTool(
  "get_market_card",
  {
    title: "Market depth card",
    description:
      "On-demand snapshot for ONE market (conditionId): order-book depth, executable capacity, smart-money exposure summary. This endpoint DOES hit Polymarket upstream and can back-pressure with 429 — treat failures as retryable, not fatal.",
    inputSchema: {
      conditionId: z
        .string()
        .min(1)
        .describe("Market conditionId, e.g. 0x… from any signal payload"),
    },
  },
  ({ conditionId }) =>
    callApi(
      `/api/market-card/${encodeURIComponent(conditionId)}`,
      undefined,
      true,
    ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[whalewatch-mcp] ready — base=${env.baseUrl} key=${env.apiKey ? "set" : "absent (public tools only)"}`,
);
