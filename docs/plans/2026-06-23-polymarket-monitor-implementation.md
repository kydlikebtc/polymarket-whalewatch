# Polymarket 大额成交 & 聪明钱监控 — 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 全程遵循 @superpowers:test-driven-development（红→绿→重构），频繁提交。

**Goal:** 构建一个本地常驻的 TypeScript 系统，轮询 Polymarket 全局成交流，对大额成交即时推送 Telegram，并在此基础上叠加聪明钱（自动筛选+白名单）监控，配 Next.js 看板。

**Architecture:** 单个 Next.js（TypeScript）工程。`lib/` 放共享代码（Polymarket/Telegram 客户端、类型、SQLite 访问层、纯逻辑函数）；`worker/` 是用 `tsx` 运行的常驻轮询进程；`app/` 是只读 SQLite 的看板。worker 与看板通过本地 SQLite 解耦。详见 [设计文档](2026-06-23-polymarket-monitor-design.md)。

**Tech Stack:** Node 20+（全局 fetch）、TypeScript、Next.js(App Router)、better-sqlite3、zod、vitest、tsx。无需任何 Polymarket 鉴权。

---

## 约定与前置

- 包管理器: `npm`（如已装 pnpm 可替换，命令等价）。
- 运行 worker: `npx tsx worker/index.ts`。
- 跑测试: `npx vitest run`（单测）/ `npx vitest`（watch）。
- 每个任务遵循 TDD 五步：写失败测试 → 跑失败 → 最小实现 → 跑通过 → 提交。
- mock fetch 统一用 `vi.stubGlobal('fetch', vi.fn())`。
- 所有金额/时间口径见设计文档 §3.1（`notional=size*price`，timestamp 为 Unix 秒）。

---

# 阶段 P0 — 地基

### Task 0.1: 初始化工程

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`

**Step 1:** 初始化**最小 TS 工程**并装依赖（P1 MVP 是纯 worker，不需要 Next.js；Next.js 推迟到 P4 看板阶段，避免 `create-next-app` 在已有 `docs/` 的非空目录冲突）。手写 `package.json`（`"type":"module"`）与 `tsconfig.json`（`"module":"NodeNext"`, `"target":"ES2022"`, `"strict":true`），然后：

```bash
npm i better-sqlite3 zod dotenv
npm i -D vitest tsx typescript @types/better-sqlite3 @types/node
```

**Step 2:** 加 `vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", include: ["**/*.test.ts"] },
});
```

**Step 3:** 在 `package.json` scripts 加：`"worker": "tsx worker/index.ts"`, `"test": "vitest run"`。

**Step 4:** 写 `.env.example`

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=
LARGE_THRESHOLDS=10000,50000
POLL_INTERVAL_MS=4000
```

**Step 5: Commit** — `chore: scaffold Next.js + vitest project`

---

### Task 0.2: 配置加载（zod 校验）

**Files:** Create `lib/config.ts`, `lib/config.test.ts`

**Step 1: 失败测试**

```ts
import { describe, it, expect } from "vitest";
import { parseConfig } from "./config";
describe("parseConfig", () => {
  it("parses thresholds into a sorted number array", () => {
    const c = parseConfig({
      TELEGRAM_BOT_TOKEN: "x",
      TELEGRAM_CHANNEL_ID: "@c",
      LARGE_THRESHOLDS: "50000,10000",
      POLL_INTERVAL_MS: "4000",
    });
    expect(c.largeThresholds).toEqual([10000, 50000]);
    expect(c.pollIntervalMs).toBe(4000);
  });
  it("defaults pollIntervalMs to 4000", () => {
    const c = parseConfig({
      TELEGRAM_BOT_TOKEN: "x",
      TELEGRAM_CHANNEL_ID: "@c",
      LARGE_THRESHOLDS: "10000",
    });
    expect(c.pollIntervalMs).toBe(4000);
  });
});
```

**Step 2:** 跑 → FAIL（parseConfig 未定义）。

**Step 3: 实现** `lib/config.ts`

```ts
import { z } from "zod";
const Env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHANNEL_ID: z.string().min(1),
  LARGE_THRESHOLDS: z.string().default("10000,50000"),
  POLL_INTERVAL_MS: z.string().default("4000"),
});
export function parseConfig(raw: NodeJS.ProcessEnv) {
  const e = Env.parse(raw);
  return {
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    telegramChannelId: e.TELEGRAM_CHANNEL_ID,
    largeThresholds: e.LARGE_THRESHOLDS.split(",")
      .map(Number)
      .sort((a, b) => a - b),
    pollIntervalMs: Number(e.POLL_INTERVAL_MS),
  };
}
export type AppConfig = ReturnType<typeof parseConfig>;
```

**Step 4:** 跑 → PASS。 **Step 5: Commit** — `feat: env-validated config loader`

---

### Task 0.3: SQLite 访问层 + 迁移

**Files:** Create `lib/db.ts`, `lib/db.test.ts`

**Step 1: 失败测试**（用内存库 `:memory:`）

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "./db";
describe("openDb", () => {
  it("creates the seen_trades table", () => {
    const db = openDb(":memory:");
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='seen_trades'",
      )
      .get();
    expect(row).toBeTruthy();
  });
});
```

**Step 2:** 跑 → FAIL。

**Step 3: 实现** `lib/db.ts`（建全部表，见设计 §8）

```ts
import Database from "better-sqlite3";
export function openDb(path = "data.sqlite") {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_trades (dedup_key TEXT PRIMARY KEY, ts INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS smart_wallets (address TEXT PRIMARY KEY, score REAL, realized_pnl REAL, win_rate REAL, roi REAL, volume REAL, consistency REAL, is_whitelist INTEGER DEFAULT 0, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS token_map (token_id TEXT PRIMARY KEY, condition_id TEXT, question TEXT, outcome TEXT, slug TEXT, event_slug TEXT, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, dedup_key TEXT, payload TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}
export type DB = ReturnType<typeof openDb>;
```

**Step 4:** 跑 → PASS。 **Step 5: Commit** — `feat: sqlite layer with schema migrations`

---

### Task 0.4: Telegram 客户端（含 429 退避）

**Files:** Create `lib/telegram.ts`, `lib/telegram.test.ts`, `scripts/test-telegram.ts`

**Step 1: 失败测试**（mock fetch；验证调用 sendMessage 端点 + HTML parse_mode；429 时按 retry_after 退避后重试）

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendMessage } from "./telegram";
beforeEach(() => vi.restoreAllMocks());
describe("sendMessage", () => {
  it("POSTs to the bot sendMessage endpoint with HTML parse_mode", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    await sendMessage({ botToken: "T", chatId: "@c" }, "hello");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/botT/sendMessage");
    expect(JSON.parse(init.body).parse_mode).toBe("HTML");
    expect(JSON.parse(init.body).chat_id).toBe("@c");
  });
});
```

**Step 2:** 跑 → FAIL。

**Step 3: 实现** `lib/telegram.ts`

```ts
export interface TgCreds {
  botToken: string;
  chatId: string;
}
export async function sendMessage(
  creds: TgCreds,
  html: string,
  attempt = 0,
): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: creds.chatId,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    },
  );
  const data: any = await res.json().catch(() => ({}));
  if (!data.ok) {
    const retryAfter = data?.parameters?.retry_after;
    if (retryAfter && attempt < 5) {
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return sendMessage(creds, html, attempt + 1);
    }
    throw new Error(`telegram sendMessage failed: ${JSON.stringify(data)}`);
  }
}
```

**Step 4:** 跑 → PASS。

**Step 5: 打通真实推送（运行时验证 §13-推送）** 写 `scripts/test-telegram.ts` 读 `.env` 发一条 "monitor online ✅"，手动 `npx tsx scripts/test-telegram.ts` 确认频道收到。确认目标是**频道**而非群。

**Step 6: Commit** — `feat: telegram client with retry_after backoff`

---

# 阶段 P1 — 大额成交监控 MVP（目标1）

### Task 1.1: 交易类型与名义金额/去重键

**Files:** Create `lib/types.ts`, `lib/trades.ts`, `lib/trades.test.ts`

**Step 1: 失败测试**

```ts
import { describe, it, expect } from "vitest";
import { notionalUsd, dedupKey } from "./trades";
const t = {
  transactionHash: "0xabc",
  asset: "123",
  proxyWallet: "0xWALLET",
  side: "BUY",
  size: 43895.83,
  price: 0.999,
} as any;
describe("trades", () => {
  it("computes USD notional as size*price", () => {
    expect(Math.round(notionalUsd(t))).toBe(43852);
  });
  it("builds a composite dedup key", () => {
    expect(dedupKey(t)).toBe("0xabc:123:0xWALLET:BUY:43895.83");
  });
});
```

**Step 2:** 跑 → FAIL。

**Step 3: 实现** `lib/types.ts`

```ts
export interface Trade {
  proxyWallet: string;
  side: "BUY" | "SELL";
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  transactionHash: string;
}
```

`lib/trades.ts`

```ts
import type { Trade } from "./types";
export const notionalUsd = (t: Pick<Trade, "size" | "price">) =>
  t.size * t.price;
export const dedupKey = (
  t: Pick<Trade, "transactionHash" | "asset" | "proxyWallet" | "side" | "size">,
) => `${t.transactionHash}:${t.asset}:${t.proxyWallet}:${t.side}:${t.size}`;
```

**Step 4:** 跑 → PASS。 **Step 5: Commit** — `feat: trade notional + dedup key`

---

### Task 1.2: Polymarket 客户端 — 全局大额成交

**Files:** Create `lib/polymarket.ts`, `lib/polymarket.test.ts`

**Step 1: 失败测试**（mock fetch；断言 URL 带 `filterType=CASH&filterAmount=10000&takerOnly=true`，返回解析后的 Trade[]）

```ts
import { describe, it, expect, vi } from "vitest";
import { getLargeTrades } from "./polymarket";
it("requests the global trades feed with the CASH filter", async () => {
  const sample = [
    {
      proxyWallet: "0x1",
      side: "BUY",
      asset: "9",
      conditionId: "0xc",
      size: 5168.75,
      price: 0.999,
      timestamp: 1700000000,
      title: "M",
      slug: "s",
      eventSlug: "e",
      outcome: "Yes",
      outcomeIndex: 0,
      transactionHash: "0xh",
    },
  ];
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => sample });
  vi.stubGlobal("fetch", fetchMock);
  const trades = await getLargeTrades(10000);
  const url = fetchMock.mock.calls[0][0] as string;
  expect(url).toContain("filterType=CASH");
  expect(url).toContain("filterAmount=10000");
  expect(url).toContain("takerOnly=true");
  expect(trades[0].size).toBe(5168.75);
});
```

**Step 2:** 跑 → FAIL。

**Step 3: 实现** `lib/polymarket.ts`

```ts
import type { Trade } from "./types";
const DATA_API = "https://data-api.polymarket.com";
export async function getLargeTrades(
  minUsd: number,
  limit = 500,
): Promise<Trade[]> {
  const url = `${DATA_API}/trades?filterType=CASH&filterAmount=${minUsd}&takerOnly=true&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`getLargeTrades ${res.status}`);
  return (await res.json()) as Trade[];
}
```

**Step 4:** 跑 → PASS。 **Step 5: Commit** — `feat: polymarket large-trades client`

---

### Task 1.3: 告警格式化（HTML 转义 + 深链 + 分级）

**Files:** Create `lib/alert.ts`, `lib/alert.test.ts`

**Step 1: 失败测试**（必须覆盖标题含 `& < >` 的转义；含金额、方向、Polymarket/Polygonscan 链接）

```ts
import { describe, it, expect } from "vitest";
import { formatLargeTradeAlert } from "./alert";
const t = {
  proxyWallet: "0x1234567890abcdef",
  side: "BUY",
  asset: "9",
  conditionId: "0xc",
  size: 100000,
  price: 0.5,
  timestamp: 1700000000,
  title: "Trump & <Biden>",
  slug: "s",
  eventSlug: "e",
  outcome: "Yes",
  outcomeIndex: 0,
  transactionHash: "0xhash",
} as any;
it("escapes HTML and includes notional + links", () => {
  const html = formatLargeTradeAlert(t, 50000);
  expect(html).toContain("Trump &amp; &lt;Biden&gt;");
  expect(html).toContain("$50,000");
  expect(html).toContain("polygonscan.com/tx/0xhash");
  expect(html).toContain("polymarket.com/event/e");
});
```

**Step 2:** 跑 → FAIL。

**Step 3: 实现** `lib/alert.ts`

```ts
import type { Trade } from "./types";
import { notionalUsd } from "./trades";
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export function formatLargeTradeAlert(
  t: Trade,
  tier: number,
  smart?: { score: number },
): string {
  const n = notionalUsd(t);
  const tag = smart ? `🏆 聪明钱(${smart.score.toFixed(0)}) ` : "";
  const whale = n >= tier && tier >= 50000 ? "🐳 " : "💰 ";
  return [
    `${whale}${tag}<b>${esc(t.title)}</b>`,
    `${esc(t.outcome)} · <b>${t.side}</b> · ${usd(n)} @ ${t.price.toFixed(3)}`,
    `<a href="https://polymarket.com/event/${t.eventSlug}">市场</a> · ` +
      `<a href="https://polymarket.com/profile/${t.proxyWallet}">${short(t.proxyWallet)}</a> · ` +
      `<a href="https://polygonscan.com/tx/${t.transactionHash}">tx</a>`,
  ].join("\n");
}
```

> 运行时验证（§13）：上线时确认 `polymarket.com/profile/<addr>` 仍可解析，否则改用 event 链接。

**Step 4:** 跑 → PASS。 **Step 5: Commit** — `feat: rich large-trade alert formatter`

---

### Task 1.4: 去重存储

**Files:** Create `lib/seen.ts`, `lib/seen.test.ts`

**Step 1: 失败测试**

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { hasSeen, markSeen } from "./seen";
it("marks and detects seen keys", () => {
  const db = openDb(":memory:");
  expect(hasSeen(db, "k1")).toBe(false);
  markSeen(db, "k1", 1700000000);
  expect(hasSeen(db, "k1")).toBe(true);
});
```

**Step 2:** 跑 → FAIL。

**Step 3: 实现** `lib/seen.ts`

```ts
import type { DB } from "./db";
export const hasSeen = (db: DB, key: string) =>
  !!db.prepare("SELECT 1 FROM seen_trades WHERE dedup_key = ?").get(key);
export const markSeen = (db: DB, key: string, ts: number) =>
  db
    .prepare("INSERT OR IGNORE INTO seen_trades (dedup_key, ts) VALUES (?, ?)")
    .run(key, ts);
```

**Step 4:** 跑 → PASS。 **Step 5: Commit** — `feat: sqlite dedup store`

---

### Task 1.5: 轮询核心（纯函数，先过滤再排序）

**Files:** Create `lib/poll.ts`, `lib/poll.test.ts`

**Step 1: 失败测试**（给一批成交 + 已见集合 → 返回未见的、按时间升序，便于按发生顺序推送）

```ts
import { describe, it, expect } from "vitest";
import { selectNewTrades } from "./poll";
const mk = (h: string, ts: number) =>
  ({
    transactionHash: h,
    asset: "a",
    proxyWallet: "w",
    side: "BUY",
    size: 1,
    price: 1,
    timestamp: ts,
  }) as any;
it("returns only unseen trades, oldest first", () => {
  const fetched = [mk("0x3", 30), mk("0x1", 10), mk("0x2", 20)];
  const seen = new Set(["0x2:a:w:BUY:1"]);
  const out = selectNewTrades(fetched, (k) => seen.has(k));
  expect(out.map((t) => t.transactionHash)).toEqual(["0x1", "0x3"]);
});
```

**Step 2:** 跑 → FAIL。

**Step 3: 实现** `lib/poll.ts`

```ts
import type { Trade } from "./types";
import { dedupKey } from "./trades";
export function selectNewTrades(
  fetched: Trade[],
  isSeen: (key: string) => boolean,
): Trade[] {
  return fetched
    .filter((t) => !isSeen(dedupKey(t)))
    .sort((a, b) => a.timestamp - b.timestamp);
}
```

**Step 4:** 跑 → PASS。 **Step 5: Commit** — `feat: pure poll selection logic`

---

### Task 1.6: 组装 worker 循环

**Files:** Create `worker/index.ts`, `worker/runOnce.ts`, `worker/runOnce.test.ts`

**Step 1: 失败测试**（`runOnce` 接收注入的 deps：fetchTrades / send / db；验证仅新成交被推送且被标记已见）

```ts
import { describe, it, expect, vi } from "vitest";
import { openDb } from "../lib/db";
import { runOnce } from "./runOnce";
it("alerts each new trade once and marks it seen", async () => {
  const db = openDb(":memory:");
  const t = {
    transactionHash: "0xh",
    asset: "a",
    proxyWallet: "w",
    side: "BUY",
    size: 100000,
    price: 0.5,
    timestamp: 100,
    title: "M",
    slug: "s",
    eventSlug: "e",
    outcome: "Yes",
    outcomeIndex: 0,
    conditionId: "0xc",
  } as any;
  const send = vi.fn().mockResolvedValue(undefined);
  await runOnce({
    db,
    send,
    fetchTrades: async () => [t],
    thresholds: [10000, 50000],
  });
  expect(send).toHaveBeenCalledTimes(1);
  await runOnce({
    db,
    send,
    fetchTrades: async () => [t],
    thresholds: [10000, 50000],
  }); // 第二轮：已见
  expect(send).toHaveBeenCalledTimes(1);
});
```

**Step 2:** 跑 → FAIL。

**Step 3: 实现** `worker/runOnce.ts`（纯编排，依赖注入便于测试）

```ts
import type { DB } from "../lib/db";
import type { Trade } from "../lib/types";
import { selectNewTrades } from "../lib/poll";
import { dedupKey, notionalUsd } from "../lib/trades";
import { formatLargeTradeAlert } from "../lib/alert";
interface Deps {
  db: DB;
  send: (html: string) => Promise<void>;
  fetchTrades: () => Promise<Trade[]>;
  thresholds: number[];
}
export async function runOnce({ db, send, fetchTrades, thresholds }: Deps) {
  const minTier = thresholds[0];
  const fetched = await fetchTrades();
  const isSeen = (k: string) =>
    !!db.prepare("SELECT 1 FROM seen_trades WHERE dedup_key=?").get(k);
  for (const t of selectNewTrades(fetched, isSeen)) {
    const n = notionalUsd(t);
    if (n < minTier) continue;
    const tier = [...thresholds].reverse().find((x) => n >= x) ?? minTier;
    await send(formatLargeTradeAlert(t, tier));
    const k = dedupKey(t);
    db.prepare(
      "INSERT OR IGNORE INTO seen_trades (dedup_key, ts) VALUES (?, ?)",
    ).run(k, t.timestamp);
    db.prepare(
      "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES (?,?,?,?)",
    ).run("large", k, JSON.stringify(t), t.timestamp);
  }
}
```

`worker/index.ts`（常驻循环，连真接口）

```ts
import "dotenv/config";
import { parseConfig } from "../lib/config";
import { openDb } from "../lib/db";
import { getLargeTrades } from "../lib/polymarket";
import { sendMessage } from "../lib/telegram";
import { runOnce } from "./runOnce";
const cfg = parseConfig(process.env);
const db = openDb();
const creds = { botToken: cfg.telegramBotToken, chatId: cfg.telegramChannelId };
async function loop() {
  try {
    await runOnce({
      db,
      send: (html) => sendMessage(creds, html),
      fetchTrades: () => getLargeTrades(cfg.largeThresholds[0]),
      thresholds: cfg.largeThresholds,
    });
  } catch (e) {
    console.error("[poll] error", e);
  }
  setTimeout(loop, cfg.pollIntervalMs);
}
console.log("[worker] starting, thresholds", cfg.largeThresholds);
loop();
```

**Step 4:** 跑测试 → PASS。

**Step 5: 真机联调（运行时验证 §13-成交流）** 配好 `.env`，`npm run worker`，确认 Telegram 收到真实大单告警。**实测索引延迟**：对比某条告警的 `timestamp` 与收到时间，判断 4 秒轮询是否达 SLA；如延迟过大，记入待办（P5 加 WS）。对账某活跃市场，确认全局流不漏。

**Step 6: Commit** — `feat: large-trade monitor worker (MVP, goal 1 complete)`

---

# 阶段 P2 — 聪明钱白名单监控（目标2 基础）— 任务大纲

> 先用手动白名单打通"监控聪明钱大额成交"，复用 P1 数据流。

- **T2.1** `lib/smart/store.ts`：`upsertWallet/listSmart/isSmart(address)`（读写 `smart_wallets`，TDD）。
- **T2.2** 白名单加载：从 `config` 表或 `.env WHITELIST` 读地址，`upsertWallet(..., is_whitelist=1)`。地址规范化为小写。TDD。
- **T2.3** 在 `runOnce` 增强：对每条成交 `isSmart(proxyWallet)` 命中则用 `formatLargeTradeAlert(t, tier, {score})` 加 🏆 标记；并允许聪明钱用更低阈值 `SMART_WATCH_THRESHOLD`。TDD（命中/未命中两路）。
- **T2.4**（可选）对白名单钱包跑定向轮询 `/trades?user=&filterAmount=<lower>`，覆盖低于全局阈值的成交。
- **运行时验证**：确认白名单输入用 proxy 地址；若需支持 EOA，引入 `deriveSafe`（§13）。
- **Commit 粒度**：每个 T2.x 一次提交。

# 阶段 P3 — 聪明钱自动筛选（目标2 进阶）— 任务大纲

> 依赖运行时验证锁定口径后再细化代码（避免腹想）。

- **T3.0（先行验证）** 实测：leaderboard `pnl/vol` 口径（是否含未实现/窗口类型）、`/positions.realizedPnl` 语义、`/closed-positions` 形态、`/activity` 字段；**锁定胜率定义**。产出"指标口径备忘"。
- **T3.1** `lib/polymarket.ts` 扩展：`getLeaderboard(params)`、`getPositions(user)`、`getActivity(user)`、`getValue(user)`。每个 mock-fetch TDD。
- **T3.2** `lib/smart/metrics.ts`：由 positions+activity 计算 `WalletMetrics`（realizedPnl/winRate/roi/volume/consistency/accountAge/portfolioValue）。TDD 用样本数据。
- **T3.3** `lib/smart/score.ts`：`scoreWallet(metrics, cfg)` 综合评分 + 硬门槛（**此处留给用户定义权重/门槛**，设计 §6.3）。TDD 覆盖门槛淘汰与排序。
- **T3.4** `worker/screen.ts`：种子(leaderboard 矩阵)→去重→富集(限速+缓存)→评分→`upsertWallet`。token bucket 限速 + 429 退避。每日定时（worker 内 `setInterval` 或单独入口）。
- **T3.5** 富集限速实测（§13）后再放开 1000 钱包全量。
- **Commit 粒度**：每个 T3.x 一次提交。

# 阶段 P4 — Next.js 看板 — 任务大纲

- **T4.1** `lib/db.ts` 只读查询函数：`recentAlerts`、`smartLeaderboard`、`getConfig/setConfig`。TDD。
- **T4.2** `app/page.tsx`：实时大单流（轮询 `recentAlerts`）。
- **T4.3** `app/smart/page.tsx`：聪明钱榜（评分+各维度）。
- **T4.4** `app/config/page.tsx` + route handler：阈值/权重/白名单增删（写 `config`/`smart_wallets`）。
- **T4.5** `app/api/*` route handlers 暴露只读数据给前端。
- 看板只读 SQLite，与 worker 解耦。

# 阶段 P5 — 硬化 / 上云 — 任务大纲

- **T5.1** 逐项关闭设计 §13 运行时验证清单。
- **T5.2** 若索引延迟不达标：加 CLOB WS market 频道做低延迟侦测 + 与 `/trades` 做 (token+size+price+时间窗) 归因 join（设计 §14）。
- **T5.3** 链上/子图后备：确认 V2 合约地址/ABI 后接 `OrderFilled`。
- **T5.4** 容器化 + 迁 VPS（worker 常驻 + 看板）。
- **T5.5** 监控告警自身健康（心跳消息、错误率）。

---

## 验收标准（MVP/P1）

- `npx vitest run` 全绿。
- `npm run worker` 连真实 Polymarket 接口，≥$10k 成交在数秒内推达 Telegram 频道，富文本含金额/方向/市场/钱包/tx 深链。
- 重启 worker 不重复推送历史成交（去重持久化生效）。
