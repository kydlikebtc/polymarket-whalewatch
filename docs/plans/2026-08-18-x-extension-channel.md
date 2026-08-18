# 𝕏 浏览器插件发帖通道 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 新增一条「浏览器插件」发帖通道，用运营者本机 Chrome 里已登录的 X 会话发帖（边际成本为零），与既有 API 通道并存且可一键切换。

**Architecture:** 服务端 `xBroadcast` 在 extension 通道下把「同步发帖」换成「落一行 `status='queued'`」，本机 Chrome 插件用 `alarms` 每 60s 拉取、在后台标签页里驱动 x.com 自己的编辑器发帖、再回调 ack。两条通道共享同一张 `x_posts` 表，所以幂等键、历史、成本台账只有一份真相。插件不含任何业务逻辑，只负责把服务端给的字符串发出去并记得自己发过什么。

**Tech Stack:** 服务端 Next 16 + better-sqlite3 + vitest（现有）；插件 Vite + `@crxjs/vite-plugin` + TypeScript + vitest（新增，独立 `extension/` 子目录与 `node_modules`）。

**设计文档：** `docs/plans/2026-08-18-x-extension-channel-design.md`（读它了解每个决定的理由）

**参考实现：** `aisee-live/aisee-browser-extension` 的 `src/pages/background/x.poster.ts`（私有仓库，用 `gh api /repos/aisee-live/aisee-browser-extension/contents/<path> --jq '.content' | base64 -d` 取文件）

---

## 阶段总览

| 阶段 | 任务  | 产出                                           |
| ---- | ----- | ---------------------------------------------- |
| 1    | 1–2   | `xComposer` 加权长度修复（独立，先合先受益）   |
| 2    | 3–5   | 数据模型 + 两个 config 开关                    |
| 3    | 6–8   | 服务端队列层 + `xBroadcast` 分支 + worker 接线 |
| 4    | 9–12  | API key 能力位 + 两个端点 + `/manage` UI       |
| 5    | 13–19 | 插件本体                                       |
| 6    | 20–21 | 健康探测 + 冒烟清单                            |

**每个任务结束都要跑一次全量测试** `npm test`，保持现有 1017 测试全绿基线。

---

# 阶段 1：`xComposer` 加权长度修复

> 背景：`fitByTruncatingTitle` 用 `[...full].length` 数码点，但 X 用 twitter-text 加权长度——emoji 与制表符号算 2 个字符。截断一旦触发，帖子必然超限 6 个字符。这是线上现存 bug，插件通道会让它从"有日志的失败"变成"静默失败"（Post 按钮永远不亮）。

## Task 1：加权长度纯函数

**Files:**

- Modify: `lib/xComposer.ts`（在 `X_POST_MAX_CHARS` 常量下方新增）
- Test: `lib/xComposer.test.ts`（文件顶部新增一个 describe 块）

**Step 1: 写失败的测试**

在 `lib/xComposer.test.ts` 顶部的 import 里加上 `weightedLength`，然后在文件最前面加一个 describe：

```ts
describe("weightedLength(X 的加权字符口径)", () => {
  it("ASCII 逐字符算 1", () => {
    expect(weightedLength("hello")).toBe(5);
  });
  it("emoji 算 2 —— 这正是码点计数漏掉的那一半", () => {
    expect(weightedLength("🐳")).toBe(2);
    expect(weightedLength("📊💧⏳")).toBe(6);
  });
  it("制表符号与省略号也算 2(模板里真实用到的两个)", () => {
    expect(weightedLength("└")).toBe(2);
    expect(weightedLength("…")).toBe(2);
  });
  it("¢ 在权重 100 段内,算 1(模板里的价格符号不该被误判)", () => {
    expect(weightedLength("67¢")).toBe(3);
  });
});
```

**Step 2: 跑测试确认失败**

```bash
npm test -- lib/xComposer.test.ts
```

预期：`weightedLength is not exported` / `is not a function`。

**Step 3: 写实现**

在 `lib/xComposer.ts` 的 `export const X_POST_MAX_CHARS = 280;` 下方插入：

```ts
// X 的字符计数不是码点数,是 twitter-text 的**加权长度**:defaultWeight=200、
// scale=100、maxWeightedTweetLength=280 —— 只有下面这几段码位权重 100(算 1 个
// 字符),其余一律 200(算 2 个)。emoji、制表符号(└)、省略号(…)全在后者。
//
// 为什么必须较真:模板里固定有 🐳/📊/💧/⏳/└ 五个双宽字符,截断时还会补一个
// …,所以按码点截到 280 的帖子真实是 286 —— X 直接 403。危险带比截断更宽:
// 非截断帖只要码点数 ≥276 就已经超了。
const LIGHT_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
  [0x2043, 0x2043],
];

/** 一段文本在 X 眼里占几个字符。遍历码点(不是 UTF-16 单元)。 */
export function weightedLength(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    w += LIGHT_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return w;
}
```

**Step 4: 跑测试确认通过**

```bash
npm test -- lib/xComposer.test.ts
```

预期：新增 4 条全 PASS，其余不变。

**Step 5: 提交**

```bash
git add lib/xComposer.ts lib/xComposer.test.ts
git commit -m "feat: xComposer 加权长度纯函数 —— X 的字符口径不是码点数"
```

---

## Task 2：截断改用加权口径

**Files:**

- Modify: `lib/xComposer.ts:115-124`（`fitByTruncatingTitle`）
- Modify: `lib/xComposer.test.ts`（把两条 `[...t].length` 断言改成加权口径，并新增边界用例）

**Step 1: 写失败的测试**

把 `lib/xComposer.test.ts` 里现有的两条断言改掉：

```ts
// 原:expect([...t].length).toBeLessThanOrEqual(280);
expect(weightedLength(t)).toBeLessThanOrEqual(280);
```

两处都改（whale 的「含标签时仍守住 ≤280」用例，weekly 的长文用例）。然后新增一条钉死本次修复的用例：

```ts
it("截断触发时守住的是 X 的加权 280,不是码点 280", () => {
  const t = composeWhalePost({
    ...base,
    title: "A".repeat(400),
    pct24h: 12.4,
    liquidityUsd: 229_000,
    hoursToEnd: 5,
    category: "Sports",
  });
  expect(t).toContain("…");
  // 修复前这里是 286(六个双宽字符:🐳 📊 💧 ⏳ └ …)
  expect(weightedLength(t)).toBeLessThanOrEqual(280);
});
```

**Step 2: 跑测试确认失败**

```bash
npm test -- lib/xComposer.test.ts
```

预期：新用例 FAIL，`expected 286 to be less than or equal to 280`。

**Step 3: 写实现**

把 `lib/xComposer.ts` 的 `fitByTruncatingTitle` 整个替换成：

```ts
// 280 限长的唯一实现:超长部分全部从 title 上截。title 是模板里唯一的
// 变长自由文本,数字段截断会造成误读,title 截断只损失可读性。
//
// 为什么是二分而不是"算出超了几个字符就砍几个":加权长度对码点数**不是
// 线性的** —— 砍掉的可能是权重 1 的 ASCII,也可能是权重 2 的 emoji,而补上
// 的 "…" 本身又占 2。二分利用的是唯一可靠的性质:标题前缀越短,帖子越短。
function fitByTruncatingTitle(
  build: (title: string) => string,
  title: string,
): string {
  const full = build(title);
  if (weightedLength(full) <= X_POST_MAX_CHARS) return full;
  const chars = [...title];
  let lo = 0; // 已知能塞下的最长前缀长度
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = build(chars.slice(0, mid).join("") + "…");
    if (weightedLength(candidate) <= X_POST_MAX_CHARS) lo = mid;
    else hi = mid - 1;
  }
  return build(chars.slice(0, lo).join("") + "…");
}
```

同时把文件头注释第 1 条不变量改准：

```ts
//  1. ≤280 **加权**字符(X 的 twitter-text 口径,emoji 算 2):超长一律截 title
//     补 "…",绝不让 publisher 吃 API 400。
```

**Step 4: 跑测试确认通过**

```bash
npm test -- lib/xComposer.test.ts
```

预期：全 PASS。再跑全量确认没有连带破坏：

```bash
npm test
```

**Step 5: 提交**

```bash
git add lib/xComposer.ts lib/xComposer.test.ts
git commit -m "fix: 帖文限长按 X 加权口径 —— 截断后必超限 6 字符被静默丢弃"
```

---

# 阶段 2：数据模型 + 配置开关

## Task 3：数据库迁移

**Files:**

- Modify: `lib/db.ts`（在既有 `ALTER TABLE` 迁移块尾部追加）
- Test: `lib/db.test.ts`

**Step 1: 写失败的测试**

在 `lib/db.test.ts` 追加：

```ts
it("x_posts 有 channel/leased_at,api_keys 有 can_x_queue(插件通道迁移)", () => {
  const db = openDb(":memory:");
  const xCols = (
    db.prepare("PRAGMA table_info(x_posts)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(xCols).toContain("channel");
  expect(xCols).toContain("leased_at");
  const keyCols = (
    db.prepare("PRAGMA table_info(api_keys)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(keyCols).toContain("can_x_queue");
});
```

**Step 2: 跑测试确认失败**

```bash
npm test -- lib/db.test.ts
```

**Step 3: 写实现**

在 `lib/db.ts` 的 `CREATE TABLE IF NOT EXISTS x_posts (...)` 那一行里补进新列（新库直接带上），并在既有 `ALTER TABLE` 迁移块尾部追加老库补列：

```ts
// x_posts 增通道归因(channel)与租约时间戳(leased_at)——插件通道批次。
// channel:'api'(worker 直发)| 'extension'(本机浏览器插件代发)。没有这一列,
// 切换通道后 /manage 的历史就无法回答「这批是哪条通道发的、哪条失败率高」。
// leased_at:插件取走队列条目的时刻,超时未 ack 则退回 queued —— 锁的持有者
// 在网络另一头,所以这把锁必须带 TTL(见设计文档 §4)。
for (const [table, col, type] of [
  ["x_posts", "channel", "TEXT NOT NULL DEFAULT 'api'"],
  ["x_posts", "leased_at", "INTEGER"],
  ["api_keys", "can_x_queue", "INTEGER NOT NULL DEFAULT 0"],
] as const) {
  try {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run();
  } catch {
    // column already present
  }
}
```

同时把 `CREATE TABLE IF NOT EXISTS x_posts (...)` 补成含 `channel TEXT NOT NULL DEFAULT 'api', leased_at INTEGER`，`api_keys` 的 CREATE 补 `can_x_queue INTEGER NOT NULL DEFAULT 0`；再加一条队列扫描索引：

```sql
CREATE INDEX IF NOT EXISTS idx_x_posts_status_channel ON x_posts(status, channel);
```

**Step 4: 跑测试确认通过**

```bash
npm test -- lib/db.test.ts && npm test
```

**Step 5: 提交**

```bash
git add lib/db.ts lib/db.test.ts
git commit -m "feat: x_posts 增 channel/leased_at,api_keys 增 can_x_queue"
```

---

## Task 4：两个 config 开关

**Files:**

- Modify: `lib/xSettings.ts`
- Test: `lib/xSettings.test.ts`

**Step 1: 写失败的测试**

```ts
describe("发帖通道开关", () => {
  it("默认 api —— 升级不改行为", () => {
    const db = openDb(":memory:");
    expect(getXDeliveryChannel(db)).toBe("api");
  });
  it("能设成 extension 并读回", () => {
    const db = openDb(":memory:");
    setXDeliveryChannel(db, "extension");
    expect(getXDeliveryChannel(db)).toBe("extension");
  });
  it("坏值降级回 api,不静默变哑", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "x_delivery_channel",
      "banana",
    );
    expect(getXDeliveryChannel(db)).toBe("api");
  });
  it("真实变更才写 config_history", () => {
    const db = openDb(":memory:");
    setXDeliveryChannel(db, "extension");
    setXDeliveryChannel(db, "extension");
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM config_history WHERE key = ?")
      .get("x_delivery_channel") as { n: number };
    expect(n.n).toBe(1);
  });
});

describe("插件通道日上限", () => {
  it("默认 whale 100 / pregame 6", () => {
    const db = openDb(":memory:");
    expect(getXDailyCaps(db)).toEqual({ whale: 100, pregame: 6 });
  });
  it("非正整数逐键降级默认", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "x_daily_caps",
      JSON.stringify({ whale: -3, pregame: 20 }),
    );
    expect(getXDailyCaps(db)).toEqual({ whale: 100, pregame: 20 });
  });
});
```

**Step 2: 跑测试确认失败**

```bash
npm test -- lib/xSettings.test.ts
```

**Step 3: 写实现**

在 `lib/xSettings.ts` 追加（完全复刻既有 `getXKindSwitches` 的坏值降级 + `config_history` 模式）：

```ts
// --- 发帖通道 -------------------------------------------------------------
//
// 'api'       —— worker 用 X API 直发(首版行为,按量付费,预算硬上限)。
// 'extension' —— 落队列,由本机 Chrome 插件用已登录会话代发(边际成本零)。
// 默认 'api' 是纪律不是偏好:升级到本版本的部署不该因为多了开关而改变行为
// (与 DEFAULT_X_KINDS 全开同源)。

export type XDeliveryChannel = "api" | "extension";

const CHANNEL_KEY = "x_delivery_channel";
const DEFAULT_CHANNEL: XDeliveryChannel = "api";

export function getXDeliveryChannel(db: DB): XDeliveryChannel {
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(CHANNEL_KEY) as { value: string | null } | undefined;
  const v = row?.value;
  if (v === "api" || v === "extension") return v;
  if (v) console.warn(`[xSettings] 未知通道 '${v}',回落 ${DEFAULT_CHANNEL}`);
  return DEFAULT_CHANNEL;
}

export function setXDeliveryChannel(db: DB, c: XDeliveryChannel): void {
  writeConfig(db, CHANNEL_KEY, c);
}

// --- 插件通道日上限 -------------------------------------------------------
//
// api 通道继续用 xQuota 的 DAILY_CAP 常量({whale:20,pregame:3})——那是
// **预算**约束。插件通道边际成本为零,上限的意义变成**防封号 + 防刷屏**,
// 所以是另一套数值、且必须运营者可调(不同账号权重/不同阶段容忍度不同)。

export interface XDailyCaps {
  whale: number;
  pregame: number;
}

const CAPS_KEY = "x_daily_caps";
export const DEFAULT_X_DAILY_CAPS: XDailyCaps = { whale: 100, pregame: 6 };

export function getXDailyCaps(db: DB): XDailyCaps {
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(CAPS_KEY) as { value: string | null } | undefined;
  const out = { ...DEFAULT_X_DAILY_CAPS };
  if (!row?.value) return out;
  try {
    const parsed = JSON.parse(row.value) as Partial<
      Record<keyof XDailyCaps, unknown>
    >;
    for (const k of Object.keys(DEFAULT_X_DAILY_CAPS) as (keyof XDailyCaps)[]) {
      const v = parsed[k];
      // 逐键校验:只接受正整数。0/负数/字符串一律回落默认 —— 一个坏配置
      // 不该把整条通道变哑(与 getXKindSwitches 同一条纪律)。
      if (typeof v === "number" && Number.isInteger(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    console.warn(`[xSettings] corrupt JSON for '${CAPS_KEY}', using defaults`);
    return out;
  }
}

export function setXDailyCaps(db: DB, caps: XDailyCaps): void {
  writeConfig(db, CAPS_KEY, JSON.stringify(caps));
}
```

同时把 `setXKindSwitches` 里那段「比对旧值 → 只在真实变更时写 `config_history` → `INSERT OR REPLACE config`」抽成共用的 `writeConfig(db, key, value)` 私有函数，三处复用（DRY）。

**Step 4: 跑测试确认通过**

```bash
npm test -- lib/xSettings.test.ts && npm test
```

**Step 5: 提交**

```bash
git add lib/xSettings.ts lib/xSettings.test.ts
git commit -m "feat: 发帖通道开关与插件通道日上限(config 表,≤60s 生效)"
```

---

## Task 5：`xQuota` 的 `DAILY_CAP` 支持覆盖

**Files:**

- Modify: `lib/xQuota.ts`
- Test: `lib/xQuota.test.ts`

**Step 1: 写失败的测试**

```ts
it("传入 caps 覆盖时按覆盖值判定(插件通道用)", () => {
  const db = openDb(":memory:");
  const now = 1_700_000_000;
  for (let i = 0; i < 25; i++) {
    db.prepare(
      `INSERT INTO x_posts (kind, dedup_key, text, has_link, est_cost_usd, status, created_at)
       VALUES ('whale', ?, '', 0, 0, 'posted', ?)`,
    ).run(`d${i}`, now);
  }
  // 常量 DAILY_CAP.whale = 20 → 已该拒
  expect(
    quotaDecision(db, {
      kind: "whale",
      hasLink: false,
      budgetUsd: 15,
      nowSec: now,
    }).ok,
  ).toBe(false);
  // 覆盖到 100 → 放行
  expect(
    quotaDecision(db, {
      kind: "whale",
      hasLink: false,
      budgetUsd: 15,
      nowSec: now,
      caps: { whale: 100, pregame: 6 },
    }).ok,
  ).toBe(true);
});
```

**Step 2: 跑测试确认失败**

```bash
npm test -- lib/xQuota.test.ts
```

**Step 3: 写实现**

给 `QuotaInput` 加可选字段并在日上限判定处使用：

```ts
export interface QuotaInput {
  kind: string;
  hasLink: boolean;
  budgetUsd: number;
  nowSec: number;
  /**
   * 日上限覆盖(插件通道用)。省略 = 用 DAILY_CAP 常量,即 api 通道的预算导向
   * 数值 —— 既有调用方零改动。
   */
  caps?: Record<string, number>;
}
```

判定处把 `DAILY_CAP[i.kind]` 换成 `(i.caps ?? DAILY_CAP)[i.kind]`。

**Step 4: 跑测试确认通过**

```bash
npm test -- lib/xQuota.test.ts && npm test
```

**Step 5: 提交**

```bash
git add lib/xQuota.ts lib/xQuota.test.ts
git commit -m "feat: xQuota 日上限支持按通道覆盖"
```

---

# 阶段 3：服务端队列层

## Task 6：`lib/xQueue.ts` —— lease / ack / TTL 回收

**Files:**

- Create: `lib/xQueue.ts`
- Test: `lib/xQueue.test.ts`

**Step 1: 写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { openDb } from "./db";
import { ackQueued, leaseQueued, reclaimStale } from "./xQueue";

const NOW = 1_700_000_000;

function seed(db: ReturnType<typeof openDb>, rows: [string, string, number][]) {
  for (const [kind, dedup, createdAt] of rows) {
    db.prepare(
      `INSERT INTO x_posts (kind, dedup_key, text, has_link, est_cost_usd, status, channel, created_at)
       VALUES (?, ?, ?, 0, 0, 'queued', 'extension', ?)`,
    ).run(kind, dedup, `text-${dedup}`, createdAt);
  }
}

describe("leaseQueued", () => {
  it("取走后置为 leased 并盖 leased_at —— 第二次取不到同一条", () => {
    const db = openDb(":memory:");
    seed(db, [["whale", "a", NOW]]);
    const first = leaseQueued(db, { limit: 5, nowSec: NOW });
    expect(first.map((p) => p.text)).toEqual(["text-a"]);
    expect(leaseQueued(db, { limit: 5, nowSec: NOW })).toEqual([]);
    const row = db.prepare("SELECT status, leased_at FROM x_posts").get() as {
      status: string;
      leased_at: number;
    };
    expect(row.status).toBe("leased");
    expect(row.leased_at).toBe(NOW);
  });

  it("consensus 优先于 whale —— 配额吃紧时大新闻先走", () => {
    const db = openDb(":memory:");
    seed(db, [
      ["whale", "w", NOW],
      ["consensus", "c", NOW + 10],
    ]);
    expect(
      leaseQueued(db, { limit: 5, nowSec: NOW }).map((p) => p.kind),
    ).toEqual(["consensus", "whale"]);
  });

  it("只取 extension 通道的 queued,不碰 api 通道的 claimed", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO x_posts (kind, dedup_key, text, has_link, est_cost_usd, status, channel, created_at)
       VALUES ('whale', 'api1', 't', 0, 0.015, 'claimed', 'api', ?)`,
    ).run(NOW);
    expect(leaseQueued(db, { limit: 5, nowSec: NOW })).toEqual([]);
  });

  it("limit 生效", () => {
    const db = openDb(":memory:");
    seed(db, [
      ["whale", "a", NOW],
      ["whale", "b", NOW],
      ["whale", "c", NOW],
    ]);
    expect(leaseQueued(db, { limit: 2, nowSec: NOW })).toHaveLength(2);
  });
});

describe("ackQueued", () => {
  it("posted 落 x_post_id", () => {
    const db = openDb(":memory:");
    seed(db, [["whale", "a", NOW]]);
    const [p] = leaseQueued(db, { limit: 1, nowSec: NOW });
    expect(
      ackQueued(db, {
        id: p.id,
        result: "posted",
        xPostId: "1234",
        nowSec: NOW,
      }),
    ).toBe(true);
    const row = db.prepare("SELECT status, x_post_id FROM x_posts").get() as {
      status: string;
      x_post_id: string;
    };
    expect(row).toEqual({ status: "posted", x_post_id: "1234" });
  });

  it("unconfirmed 是独立状态 —— 既不是成功也不是失败", () => {
    const db = openDb(":memory:");
    seed(db, [["whale", "a", NOW]]);
    const [p] = leaseQueued(db, { limit: 1, nowSec: NOW });
    ackQueued(db, { id: p.id, result: "unconfirmed", nowSec: NOW });
    expect(
      (db.prepare("SELECT status FROM x_posts").get() as { status: string })
        .status,
    ).toBe("posted_unconfirmed");
  });

  it("channel_error 退回 queued 等下轮重试(不烧掉这条帖)", () => {
    const db = openDb(":memory:");
    seed(db, [["whale", "a", NOW]]);
    const [p] = leaseQueued(db, { limit: 1, nowSec: NOW });
    ackQueued(db, { id: p.id, result: "channel_error", nowSec: NOW });
    const row = db.prepare("SELECT status, leased_at FROM x_posts").get() as {
      status: string;
      leased_at: number | null;
    };
    expect(row).toEqual({ status: "queued", leased_at: null });
  });

  it("重复 ack 幂等 —— 第二次返回 false 且不改已定状态", () => {
    const db = openDb(":memory:");
    seed(db, [["whale", "a", NOW]]);
    const [p] = leaseQueued(db, { limit: 1, nowSec: NOW });
    ackQueued(db, { id: p.id, result: "posted", xPostId: "1", nowSec: NOW });
    expect(ackQueued(db, { id: p.id, result: "failed", nowSec: NOW })).toBe(
      false,
    );
    expect(
      (db.prepare("SELECT status FROM x_posts").get() as { status: string })
        .status,
    ).toBe("posted");
  });
});

describe("reclaimStale", () => {
  it("leased 超租约 → 退回 queued(插件崩了/标签页被关)", () => {
    const db = openDb(":memory:");
    seed(db, [["whale", "a", NOW]]);
    leaseQueued(db, { limit: 1, nowSec: NOW });
    const r = reclaimStale(db, {
      nowSec: NOW + 400,
      queueTtlSec: 7200,
      leaseTtlSec: 300,
    });
    expect(r.reclaimed).toBe(1);
    expect(
      (db.prepare("SELECT status FROM x_posts").get() as { status: string })
        .status,
    ).toBe("queued");
  });

  it("queued 超 TTL → expired(墓碑,不删行)", () => {
    const db = openDb(":memory:");
    seed(db, [["whale", "a", NOW]]);
    const r = reclaimStale(db, {
      nowSec: NOW + 8000,
      queueTtlSec: 7200,
      leaseTtlSec: 300,
    });
    expect(r.expired).toBe(1);
    // 墓碑必须留着:删行会腾空幂等键,下一轮同一条 alert 会被重新入队
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM x_posts").get() as { n: number })
        .n,
    ).toBe(1);
  });

  it("未超时的一条都不动", () => {
    const db = openDb(":memory:");
    seed(db, [["whale", "a", NOW]]);
    expect(
      reclaimStale(db, {
        nowSec: NOW + 60,
        queueTtlSec: 7200,
        leaseTtlSec: 300,
      }),
    ).toEqual({ expired: 0, reclaimed: 0 });
  });
});
```

**Step 2: 跑测试确认失败**

```bash
npm test -- lib/xQueue.test.ts
```

预期：`Cannot find module './xQueue'`。

**Step 3: 写实现**

创建 `lib/xQueue.ts`：

```ts
// 插件通道的队列层 —— x_posts 表既是台账也是队列。
//
// 架构立场:extension 通道下 xBroadcast 只负责把候选落成 'queued',发帖动作
// 发生在网络另一头的浏览器里。于是 claim-then-send 的"锁"从进程内变成跨网络,
// 必须带 TTL —— 这是 leased/leased_at 存在的唯一理由(见设计文档 §4)。
//
// 两条不变量:
//   1. 状态只前进,不回头。唯一的例外是 channel_error 与租约超时 → 退回
//      'queued',因为这两种情况下"这条帖有没有发出去"的答案是确定的"没有"。
//   2. 过期用墓碑('expired')不用删行。删行会腾空 (kind, dedup_key) 唯一索引,
//      下一轮同一条 alert 会被重新入队 —— "开机就喷隔夜旧闻"的 bug 就是这么来的。
import type { DB } from "./db";

export type XAckResult = "posted" | "unconfirmed" | "failed" | "channel_error";

export interface LeasedPost {
  id: number;
  kind: string;
  text: string;
  /** weekly 帖的图卡地址;其余 kind 为 null。 */
  imageUrl: string | null;
}

// 优先级:独家信号先走。weekly 每周一条、pregame 有日上限,都排在量大的
// whale 前面 —— 插件一轮只拉几条,不能让大单流把窗口占满。
const PRIORITY_SQL = `CASE kind
    WHEN 'consensus' THEN 0
    WHEN 'weekly'    THEN 1
    WHEN 'pregame'   THEN 2
    ELSE 3 END`;

/**
 * 原子租借:选中 → 置 leased。事务包裹,所以两个并发请求不会拿到同一条。
 * 不用 `UPDATE ... LIMIT`:better-sqlite3 默认未编译
 * SQLITE_ENABLE_UPDATE_DELETE_LIMIT。
 */
export function leaseQueued(
  db: DB,
  opts: { limit: number; nowSec: number },
): LeasedPost[] {
  const run = db.transaction((limit: number, nowSec: number): LeasedPost[] => {
    const rows = db
      .prepare(
        `SELECT id, kind, text FROM x_posts
          WHERE status = 'queued' AND channel = 'extension'
          ORDER BY ${PRIORITY_SQL}, created_at ASC
          LIMIT ?`,
      )
      .all(limit) as { id: number; kind: string; text: string }[];
    if (rows.length === 0) return [];
    const mark = db.prepare(
      "UPDATE x_posts SET status = 'leased', leased_at = ? WHERE id = ? AND status = 'queued'",
    );
    const out: LeasedPost[] = [];
    for (const r of rows) {
      if (mark.run(nowSec, r.id).changes === 1) {
        out.push({ id: r.id, kind: r.kind, text: r.text, imageUrl: null });
      }
    }
    return out;
  });
  return run(opts.limit, opts.nowSec);
}

const TERMINAL: Record<Exclude<XAckResult, "channel_error">, string> = {
  posted: "posted",
  unconfirmed: "posted_unconfirmed",
  failed: "failed",
};

/**
 * 结算一条。返回 false = 这条不在 leased 态(重复 ack / 已被回收),调用方
 * 应当把它当成"已处理"而不是错误 —— at-least-once 下重复 ack 是正常流量。
 */
export function ackQueued(
  db: DB,
  opts: {
    id: number;
    result: XAckResult;
    xPostId?: string | null;
    nowSec: number;
  },
): boolean {
  if (opts.result === "channel_error") {
    // 通道级故障:这条帖本身没问题,退回队列等通道恢复。清掉 leased_at,
    // 否则下一次租约超时判定会读到陈旧时间戳。
    return (
      db
        .prepare(
          "UPDATE x_posts SET status = 'queued', leased_at = NULL WHERE id = ? AND status = 'leased'",
        )
        .run(opts.id).changes === 1
    );
  }
  return (
    db
      .prepare(
        "UPDATE x_posts SET status = ?, x_post_id = ?, leased_at = NULL WHERE id = ? AND status = 'leased'",
      )
      .run(TERMINAL[opts.result], opts.xPostId ?? null, opts.id).changes === 1
  );
}

/** 每轮由 worker 调用的双回收。返回各自条数(进日志)。 */
export function reclaimStale(
  db: DB,
  opts: { nowSec: number; queueTtlSec: number; leaseTtlSec: number },
): { expired: number; reclaimed: number } {
  const reclaimed = db
    .prepare(
      `UPDATE x_posts SET status = 'queued', leased_at = NULL
        WHERE status = 'leased' AND leased_at IS NOT NULL AND leased_at < ?`,
    )
    .run(opts.nowSec - opts.leaseTtlSec).changes;
  const expired = db
    .prepare(
      `UPDATE x_posts SET status = 'expired'
        WHERE status = 'queued' AND channel = 'extension' AND created_at < ?`,
    )
    .run(opts.nowSec - opts.queueTtlSec).changes;
  return { expired, reclaimed };
}

/** 队列深度(健康探测与 popup 都用)。 */
export function queueDepth(db: DB): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM x_posts WHERE status = 'queued' AND channel = 'extension'",
      )
      .get() as { n: number }
  ).n;
}
```

**Step 4: 跑测试确认通过**

```bash
npm test -- lib/xQueue.test.ts && npm test
```

**Step 5: 提交**

```bash
git add lib/xQueue.ts lib/xQueue.test.ts
git commit -m "feat: 插件通道队列层 —— 原子租借/四态结算/双 TTL 回收"
```

---

## Task 7：`xBroadcast` 通道分支

**Files:**

- Modify: `lib/xBroadcast.ts`
- Test: `lib/xBroadcast.test.ts`

**Step 1: 写失败的测试**

```ts
it("extension 通道下不发帖,只落 queued(client 都不该被调用)", async () => {
  const db = openDb(":memory:");
  seedLargeAlert(db); // 复用文件里已有的建告警辅助函数
  const client = { postText: vi.fn(), postWithPng: vi.fn() };
  const posted = await runXBroadcastCycle({
    db,
    client,
    channel: "extension",
    budgetUsd: 15,
    minTradeUsd: 50_000,
    nowSec: NOW,
  });
  expect(posted).toBe(0);
  expect(client.postText).not.toHaveBeenCalled();
  const row = db
    .prepare("SELECT status, channel, est_cost_usd, text FROM x_posts")
    .get() as {
    status: string;
    channel: string;
    est_cost_usd: number;
    text: string;
  };
  expect(row.status).toBe("queued");
  expect(row.channel).toBe("extension");
  // 插件通道零边际成本 —— 台账不该虚记开销,否则预算熔断会误伤 api 通道
  expect(row.est_cost_usd).toBe(0);
  expect(row.text).toContain("WHALE");
});

it("api 通道行为一字不变(回归)", async () => {
  const db = openDb(":memory:");
  seedLargeAlert(db);
  const client = {
    postText: vi.fn().mockResolvedValue("999"),
    postWithPng: vi.fn(),
  };
  const posted = await runXBroadcastCycle({
    db,
    client,
    budgetUsd: 15,
    minTradeUsd: 50_000,
    nowSec: NOW,
  });
  expect(posted).toBe(1);
  const row = db.prepare("SELECT status, channel FROM x_posts").get() as {
    status: string;
    channel: string;
  };
  expect(row).toEqual({ status: "posted", channel: "api" });
});
```

**Step 2: 跑测试确认失败**

```bash
npm test -- lib/xBroadcast.test.ts
```

**Step 3: 写实现**

给 `XBroadcastDeps` 加两个可选字段：

```ts
  /**
   * 投递通道。省略 = 'api'(首版行为)。'extension' 下本函数不发任何帖,
   * 只把候选落成 'queued' 交给插件 —— client 在该模式下不会被触碰。
   */
  channel?: "api" | "extension";
  /** 日上限覆盖(仅 extension 通道传;api 通道用 xQuota 的常量)。 */
  caps?: Record<string, number>;
```

在 `runXBroadcastCycle` 里：

1. 顶部 `const channel = d.channel ?? "api";`
2. 新增一条 prepared statement：

```ts
// 插件通道的入队:成本记 0(边际成本为零),channel 记 'extension'。
// 用同一个 (kind, dedup_key) 唯一索引做幂等 —— 与 api 通道共享一份
// "这条 alert 处理过没有"的真相,所以切换通道不会重发。
const enqueue = d.db.prepare(
  `INSERT OR IGNORE INTO x_posts (kind, dedup_key, alert_id, text, has_link, est_cost_usd, status, channel, created_at)
     VALUES (?, ?, ?, ?, 0, 0, 'queued', 'extension', ?)`,
);
```

3. 配额判定传 caps：`quotaDecision(d.db, { ..., caps: d.caps })`
4. 配额通过后按通道分叉：

```ts
if (channel === "extension") {
  if (enqueue.run(c.kind, dedup, c.alertId, c.text, nowSec).changes === 0) {
    console.log(`[xBroadcast] skip alert=${c.alertId}: already in queue`);
  }
  continue; // 发帖动作在插件侧,本轮到此为止
}
```

5. `claim` 语句显式写入 `channel` 列的 `'api'`（可读性；DEFAULT 已保证正确）。

注意：extension 通道下 `posted` 返回值仍是 0（本轮没有真的发出去任何帖），这是正确语义——worker 用它决定要不要 `markPosted`，而插件发的帖由 ack 路由负责打点。

**Step 4: 跑测试确认通过**

```bash
npm test -- lib/xBroadcast.test.ts && npm test
```

**Step 5: 提交**

```bash
git add lib/xBroadcast.ts lib/xBroadcast.test.ts
git commit -m "feat: xBroadcast 按通道分叉 —— extension 下只入队不发帖"
```

---

## Task 8：worker 接线 + TTL 回收 tick

**Files:**

- Modify: `lib/config.ts`（两个 TTL env）
- Modify: `worker/embeddedEngine.ts:539-621`（X loop）
- Test: `lib/config.test.ts`

**Step 1: 写失败的测试**

```ts
it("插件通道两个 TTL 有默认值", () => {
  const c = parseConfig({});
  expect(c.xQueueTtlSec).toBe(7200);
  expect(c.xLeaseTtlSec).toBe(300);
});
it("TTL 可被 env 覆盖,坏值回落默认", () => {
  expect(parseConfig({ X_QUEUE_TTL_SEC: "600" }).xQueueTtlSec).toBe(600);
  expect(parseConfig({ X_QUEUE_TTL_SEC: "abc" }).xQueueTtlSec).toBe(7200);
});
```

**Step 2: 跑测试确认失败**

```bash
npm test -- lib/config.test.ts
```

**Step 3: 写实现**

`lib/config.ts` schema 加两项并解析（复用文件里既有的数值 env 解析辅助函数）：

```ts
  X_QUEUE_TTL_SEC: z.string().default(""),
  X_LEASE_TTL_SEC: z.string().default(""),
```

```ts
    // 插件通道:queued 无人认领多久算过期。浏览器是常挂机的,所以这个 TTL
    // 只在异常(Chrome 崩溃/断网/掉登录)时起作用 —— 2h 覆盖绝大多数临时
    // 故障,又不至于恢复后喷出半天的旧闻。
    xQueueTtlSec: parseIntEnv(e.X_QUEUE_TTL_SEC, 7200, "X_QUEUE_TTL_SEC"),
    // 插件取走后多久没 ack 就退回队列(浏览器崩溃/标签页被手动关掉)。
    xLeaseTtlSec: parseIntEnv(e.X_LEASE_TTL_SEC, 300, "X_LEASE_TTL_SEC"),
```

`worker/embeddedEngine.ts` 的 X loop 改造，关键三点：

```ts
  // 启动门槛从 `cfg.xAppConfigured` 放宽:extension 通道**完全不需要 X App
  // 凭据**(发帖用的是插件那头浏览器里的会话)。所以循环无条件启动,由每轮
  // 内部按通道决定做什么 —— 否则在没配过 X App 的部署上切到 extension
  // 需要重启,违背"切换 ≤60s 生效"的承诺。
  {
    const X_LOOP_MS = 60_000;
    ...
    async function xLoop() {
      try {
        const channel = getXDeliveryChannel(db);
        const kinds = getXKindSwitches(db);

        // 两个 TTL 回收每轮都跑(与通道无关):切回 api 后,队列里的残留
        // 也要按 TTL 收敛成 expired,不能永远挂着。
        const stale = reclaimStale(db, {
          nowSec: Math.floor(Date.now() / 1000),
          queueTtlSec: cfg.xQueueTtlSec,
          leaseTtlSec: cfg.xLeaseTtlSec,
        });
        if (stale.expired > 0 || stale.reclaimed > 0) {
          console.log(
            `[engine] x queue reclaim: ${stale.expired} expired, ${stale.reclaimed} lease-timeout`,
          );
        }

        if (channel === "extension") {
          await runXBroadcastCycle({
            db,
            channel: "extension",
            budgetUsd: cfg.xMonthlyBudgetUsd,
            minTradeUsd: cfg.xMinTradeUsd,
            kinds,
            caps: getXDailyCaps(db),
          });
          // pregame / weekly 同样落队列(它们内部也走 quotaDecision + x_posts)
          // —— 这两个 cycle 的通道改造在 Task 8b。
          beat(db, "x_broadcast");
          setTimeout(xLoop, X_LOOP_MS);
          return;
        }

        // ---- 以下是 api 通道,与首版一字不变 ----
        if (!cfg.xAppConfigured) { beat(db, "x_broadcast"); setTimeout(xLoop, X_LOOP_MS); return; }
        const creds = resolveXCreds(db, cfg);
        ...
```

**Task 8b（同一任务内）**：`lib/xPregame.ts` 与 `lib/xWeekly.ts` 也要支持 extension 通道。两者结构与 `xBroadcast` 同源（`quotaDecision` → claim → `client.postText`/`postWithPng`），照抄 Task 7 的分叉写法：extension 下落 `queued`，`weekly` 额外把图卡地址存进新列。

> 实现者注意：`weekly` 需要把 `imageUrl` 传给插件。用 `x_posts.text` 存正文、
> 新增一列存图卡 URL 太重；改为约定 `kind='weekly'` 时由 `/api/x-queue`
> 路由现算 `${publicUrl}/api/og/weekly`，插件侧无需知情。`LeasedPost.imageUrl`
> 在 `leaseQueued` 里保持 `null`，由路由层填充。

**Step 4: 跑测试确认通过**

```bash
npm test
```

**Step 5: 提交**

```bash
git add lib/config.ts lib/config.test.ts worker/embeddedEngine.ts lib/xPregame.ts lib/xWeekly.ts
git commit -m "feat: worker 按通道分发 + 队列 TTL 双回收 tick"
```

---

# 阶段 4：端点与 `/manage`

## Task 9：API key `can_x_queue` 能力位

**Files:**

- Modify: `lib/apiKeys.ts`（`issueApiKey` opts、`verifyApiKey` 返回、`ApiKeyInfo`）
- Modify: `lib/feedAuth.ts`（新增 `checkXQueueAccess`）
- Test: `lib/apiKeys.test.ts`、`lib/feedAuth.test.ts`

**Step 1: 写失败的测试**

```ts
// apiKeys.test.ts
it("签发时可勾选 𝕏 队列能力,默认不给", () => {
  const db = openDb(":memory:");
  const plain = issueApiKey(db, { label: "ext", tier: "realtime" });
  expect(verifyApiKey(db, plain.key)!.canXQueue).toBe(false);
  const withCap = issueApiKey(db, {
    label: "ext2",
    tier: "realtime",
    canXQueue: true,
  });
  expect(verifyApiKey(db, withCap.key)!.canXQueue).toBe(true);
});

// feedAuth.test.ts
it("没有 can_x_queue 的 key 拿不到队列(403),无效 key 401", () => {
  const db = openDb(":memory:");
  const env = { NODE_ENV: "production" };
  const plain = issueApiKey(db, { label: "no-cap", tier: "realtime" });
  const mk = (t: string) =>
    new Request("http://x/", { headers: { "x-feed-token": t } });
  expect(checkXQueueAccess(mk(plain.key), db, env)).toMatchObject({
    ok: false,
    status: 403,
  });
  expect(checkXQueueAccess(mk("garbage"), db, env)).toMatchObject({
    ok: false,
    status: 401,
  });
  const good = issueApiKey(db, {
    label: "cap",
    tier: "realtime",
    canXQueue: true,
  });
  expect(checkXQueueAccess(mk(good.key), db, env)).toMatchObject({ ok: true });
});
```

**Step 2/3/4:** 按测试实现 —— `issueApiKey` 的 `INSERT` 补 `can_x_queue`；`verifyApiKey` 的 `SELECT` 补该列并映射成 `canXQueue: row.can_x_queue === 1`；`lib/feedAuth.ts` 新增：

```ts
export type XQueueAccess =
  { ok: true; keyId: number } | { ok: false; status: 401 | 403; error: string };

/**
 * 队列端点专用鉴权。**刻意不接受 ADMIN_TOKEN** —— 那是全站可写的最高权限,
 * 而这把 key 要长期躺在浏览器扩展的 storage 里。最小权限 + 可单独吊销,
 * 且 api_keys.last_used_at 顺带就是插件心跳。
 */
export function checkXQueueAccess(
  req: Request,
  db: DB,
  env: EnvLike = process.env,
): XQueueAccess {
  if (!isPublicDeployment(env)) return { ok: true, keyId: 0 };
  const provided =
    req.headers.get("x-feed-token") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const info = provided ? verifyApiKey(db, provided) : null;
  if (!info)
    return {
      ok: false,
      status: 401,
      error: "需要有效的 API key（x-feed-token）",
    };
  if (!info.canXQueue) {
    return {
      ok: false,
      status: 403,
      error: "该 key 没有「𝕏 发帖队列」能力，请在 /manage 重新签发",
    };
  }
  return { ok: true, keyId: info.id };
}
```

**Step 5: 提交**

```bash
git add lib/apiKeys.ts lib/apiKeys.test.ts lib/feedAuth.ts lib/feedAuth.test.ts
git commit -m "feat: API key 增「𝕏 发帖队列」能力位与端点鉴权"
```

---

## Task 10–11：两个端点

**Files:**

- Create: `app/api/x-queue/route.ts`（GET 租借）
- Create: `app/api/x-queue/ack/route.ts`（POST 结算）
- Test: `lib/xQueueRoute.test.ts`（把 handler 逻辑抽成可测纯函数，路由只做壳；参考 `lib/feedAuth.ts` 从 route 抽出的既有做法）

要点：

- `runtime = "nodejs"`、`dynamic = "force-dynamic"`（与既有 route 一致）
- GET：`limit` 用 `Math.min(Math.max(1, n), 10)` 夹紧；`kind==='weekly'` 时把 `imageUrl` 填成 `${cfg.publicUrl}/api/og/weekly`
- POST：body 用 zod 校验（`id: number`、`result: enum`、`xPostId?: string`、`error?: string`）；`result==='channel_error'` 时**额外发一条 TG 告警**（复用 `lib/telegram.ts`），因为这是通道级故障，运营者必须立刻知道
- 两个端点都用 `checkXQueueAccess`
- `ackQueued` 返回 `false`（重复 ack）时仍回 `{ ok: true, duplicate: true }` —— at-least-once 下重复 ack 是正常流量，不是错误

提交：

```bash
git commit -m "feat: /api/x-queue 租借与 ack 端点"
```

---

## Task 12：`/manage` UI

**Files:**

- Modify: `app/manage/page.tsx`（或 X 播报区块所在组件）
- Modify: `app/api/admin/keys/route.ts`（签发时透传 `canXQueue`）
- Create: `lib/extensionProtocol.ts`

**内容：**

1. 「𝕏 播报」区块新增**发帖通道**单选（API 直发 / 浏览器插件），切到 API 时确认框提示「将作废 N 条待发」（N 取自 `queueDepth`）
2. 插件通道日上限两个输入框（whale / pregame）
3. 「推送配置到插件」按钮 —— 发 `window.postMessage`：

```ts
// lib/extensionProtocol.ts —— 协议常量单一来源。
// extension/src/shared/protocol.ts 从本文件复制,两边必须逐字一致,
// 否则握手会静默失败(aisee 的 brand.ts 同款做法)。
export const WW_EXTENSION_MESSAGE = {
  source: "whalewatch-web",
  configure: "whalewatch:configure",
  ack: "whalewatch:configured",
} as const;

export interface WwExtensionConfig {
  baseUrl: string;
  apiKey: string;
}
```

4. 签发 API key 的界面加一个「𝕏 发帖队列」勾选框
5. 发帖历史列表加 `channel` 列，`posted_unconfirmed` 状态**高亮**（黄底 + 「待人工核对」文案）

提交：

```bash
git commit -m "feat: /manage 通道切换、日上限、配置推送与 unconfirmed 高亮"
```

---

# 阶段 5：插件本体

## Task 13：`extension/` 脚手架

**Files:**

- Create: `extension/package.json`、`extension/tsconfig.json`、`extension/vite.config.ts`、`extension/manifest.json`、`extension/vitest.config.ts`
- Modify: `.gitignore`（加 `extension/node_modules`、`extension/dist`）

**要点：**

- 依赖：`vite`、`@crxjs/vite-plugin`、`typescript`、`vitest`、`jsdom`、`@types/chrome`。**装包时核实实际解析到的版本并写进 `package.json`**（与 `lib/xPublisher.ts` 文件头「库版本事实，装包时核实」同一条纪律）
- `manifest.json` 权限**只要六项**：`storage`、`alarms`、`tabs`、`scripting`、`notifications` + `host_permissions`。**明确不要 `debugger`/`cookies`/`activeTab`**（aisee 有，我们用不上；`debugger` 尤其扎眼）
- `host_permissions` 与 content script 的 `matches` 由 `vite.config.ts` 在构建期从 `WW_BASE_URL` 环境变量注入（aisee 的 `FRONTEND_URL` 同款）。**绝不能写 `<all_urls>`** —— 那意味着任何网站都能给插件推配置
- `npm run build` 产出 `extension/dist/`，`chrome://extensions` → Load unpacked

```bash
cd extension && npm install && npm run build
git add extension .gitignore
git commit -m "feat: 插件脚手架(Vite + crxjs + MV3,权限最小集)"
```

---

## Task 14：`shared/protocol.ts`

从 `lib/extensionProtocol.ts` 复制常量与类型，加一条测试断言两边逐字一致（读两个文件比对字符串字面量），防漂移。

```bash
git commit -m "feat: 插件与 Web 端的协议常量单一来源"
```

---

## Task 15：content bridge

**Files:** `extension/src/content/bridge.ts` + spec

监听 `window.message`，**必须校验三件事**才接受：`event.source === window`、`event.origin` 在白名单内、`data.source === WW_EXTENSION_MESSAGE.source`。通过后 `chrome.runtime.sendMessage` 转给 background，并回一条 ack 让页面能显示"已连接"。

```bash
git commit -m "feat: 配置桥接 content script(三重来源校验)"
```

---

## Task 16：`queue.client.ts` + pending-ack（TDD 重点）

**Files:** `extension/src/background/queue.client.ts` + `queue.client.spec.ts`

**核心测试（必须有）：**

```ts
it("已发过的 id 再次被租借到 → 只补 ack,绝不重发", async () => {
  // 场景:上次发帖成功但 ack 因断网没送达,服务端 lease 超时把它退回 queued。
  // 这是 at-least-once 的经典裂缝,唯一能堵住它的信息只有插件自己有。
  await store.rememberPosted(42, "tweet-1");
  const post = vi.fn();
  const acked = await consumeOne({ id: 42, kind: "whale", text: "t", imageUrl: null }, { post, ... });
  expect(post).not.toHaveBeenCalled();
  expect(acked).toEqual({ id: 42, result: "posted", xPostId: "tweet-1" });
});

it("ack 成功后才从本地表删除", async () => { ... });
it("ack 失败则保留本地记录,下次继续补", async () => { ... });
it("服务器 401 → 清空本地配置并返回 unauthorized", async () => { ... });
```

```bash
git commit -m "feat: 插件队列客户端与 pending-ack 去重"
```

---

## Task 17：`x.poster.ts` 移植（TDD 重点）

**Files:** `extension/src/background/x.poster.ts` + `x.poster.spec.ts`

从 aisee 移植 `fillXReplyInPage`（改名 `fillComposerInPage`）、`installCreateTweetInterceptor`、`readCapturedTweet`、`attachXImagesInPage`、`fetchImageForPage`、`postXCompose`。**丢掉 `postXReply` 与 `buildXStatusUrl`**（YAGNI，我们只发新帖）。全局变量 `__aiseeCreatedTweet` → `__wwCreatedTweet`。

**核心测试（jsdom，必须有）：**

```ts
// @vitest-environment jsdom
it("多行帖文走 paste 路径后每一行都在 —— Draft.js 会吞掉 insertText 的前几行", async () => {
  // 这是 aisee 流过血的坑:X 的编辑器是 Draft.js,execCommand('insertText')
  // 传多行时,Draft 从光标所在 block 重建 ContentState,**静默丢掉前面所有
  // 段落**,最后只发出去最后一行。我们的模板全是多行结构化布局,正中此坑。
  const el = document.createElement("div");
  el.setAttribute("data-testid", "tweetTextarea_0");
  el.setAttribute("contenteditable", "true");
  // 模拟 Draft 的粘贴处理器:整段吃进去
  el.addEventListener("paste", (e) => {
    el.textContent = (e as ClipboardEvent).clipboardData!.getData("text/plain");
  });
  document.body.appendChild(el);

  const text =
    "🐳 WHALE BUY · $184K\n\nChiefs win?\n└ YES @ 67¢\n\n#Polymarket";
  await fillComposerInPage(text, false);
  expect(el.textContent).toBe(text);
  expect(el.textContent).toContain("WHALE BUY"); // 首行没被吞
});
```

> jsdom 对 `DataTransfer` 构造函数的支持不稳。测试文件顶部按需打一个最小
> polyfill（`setData`/`getData` 两个方法即可），并在注释里说明为什么。

```bash
git commit -m "feat: 移植 aisee 的 X 发帖注入(paste 填字 + CreateTweet 拦截)"
```

---

## Task 18：background 消费循环 + 熔断

**Files:** `extension/src/background/index.ts` + spec

- `chrome.alarms` 60s
- 每轮：拉配置 → `GET /api/x-queue?limit=3` → 逐条 `postXCompose` → ack
- **熔断**：连续 3 次 `channel_error` → 停止消费、`chrome.notifications` 弹窗、每 10 分钟探活一次；任意一次成功清零计数
- **dry-run 开关**：从 storage 读，为真时 `autoSubmit=false`（只填不发，X 改版后先跑这个验 DOM）

测试覆盖熔断计数器的三条路径（累加 / 清零 / 触发后停止消费）。

```bash
git commit -m "feat: 插件消费循环、通道熔断与 dry-run 模式"
```

---

## Task 19：popup

**Files:** `extension/src/popup/{index.html,index.ts}`

一屏：连接状态（服务器 + key 是否就绪）、队列深度、最近 10 条发帖结果、dry-run 开关、「立即拉取」按钮、熔断时的红色横幅。原生 DOM，不引框架。

```bash
git commit -m "feat: 插件 popup 面板"
```

---

# 阶段 6：健康探测与文档

## Task 20：队列积压告警

**Files:** `lib/health.ts` + test、`worker/embeddedEngine.ts`

extension 通道下，`queueDepth(db) > 20` 且持续 > 15 分钟 → 走既有断更报警通道发 TG。覆盖「插件死了但没报错」（Chrome 杀掉 service worker 未重启）这种最难发现的情况。

```bash
git commit -m "feat: 插件通道队列积压告警"
```

## Task 21：`extension/README.md` + 主 README 一节

安装步骤（build → Load unpacked → 在 `/manage` 点推送配置）、四类帖手工冒烟清单、X 改版后的排查路径（先跑 dry-run 看 DOM 适配）、权限逐条说明。

```bash
git commit -m "docs: 插件安装、冒烟清单与排查路径"
```

---

## 完工验收

```bash
npm test          # 服务端全绿(基线 1017 + 新增)
npm run typecheck
cd extension && npm test && npm run typecheck && npm run build
```

手工：`/manage` 切到插件通道 → popup 显示队列 → dry-run 验 DOM → 关掉 dry-run 发一条真帖 → `/manage` 历史里出现 `channel=extension` 的 `posted` 行且带 `x_post_id`。
