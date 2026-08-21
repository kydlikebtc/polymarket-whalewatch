# 市场深度卡对外 API 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让订阅方在用户下单前，用一个带 key 的端点拿到某个市场的实时深度分析卡，而这件事永远挤不占引擎的 data-api 预算。

**Architecture:** 进程内窗口层保留每个热门市场的 24h 成交窗口，刷新时只增量续抓新成交（冷启 1–13 请求、热续恒 1 请求）；一个全局令牌桶计量**续抓次数**而非请求次数，其额度从属引擎健康度（`staleLoops` 非空即归零）；预算耗尽时用陈旧窗口重算卡片并标注 `staleSec`，超过 90 秒硬闸则 429。

**Tech Stack:** TypeScript / Next.js App Router / better-sqlite3 / zod / vitest

**设计文档：** `docs/plans/2026-08-21-market-card-api-design.md`

**与设计文档的一处偏离：** 设计 §3.3 的 L2（`market_card_cache` 表）**砍掉**。
贵的是窗口不是卡片——`composeMarketBrief` 是纯函数、告警命中史是本地 SQL、钱包
账龄永久缓存，拿陈旧窗口重算一张卡几乎不要钱。降级路径直接是「用陈旧窗口重算」。
L2 唯一还能救的是「重启 + 立刻突发」，而重启后令牌桶恰好是空的、冷取预算充足。
按 YAGNI 砍掉。Task 7 会把设计文档订正到与实现一致。

---

## 关键既有契约（动手前先读）

| 需要的东西   | 在哪                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `Trade` 类型 | `lib/types.ts:2`（zod schema，含 `timestamp` / `conditionId`）                                                             |
| 成交去重键   | `lib/trades.ts` 的 `dedupKey(t)`                                                                                           |
| 窗口抓取     | `lib/marketBrief.ts:182` `fetchMarketWindow(cid, {sinceSec})`                                                              |
| 卡片组装     | `lib/marketCard.ts:65` `buildMarketCard(db, cid, deps)`，`deps.fetchWindow` 可注入                                         |
| 限流/令牌    | `lib/apiGuard.ts:117` `rateLimit(key, limit, windowMs, nowMs, cost)`                                                       |
| 鉴权         | `lib/feedAuth.ts:22` `checkFeedAccess(req, db)` → `FeedAccess`                                                             |
| 订阅范围     | `lib/apiKeys.ts:114` `busTypeAllowed(busTypes, type)`                                                                      |
| 引擎健康     | `lib/health.ts:72` `evaluateHealth(beats, nowSec, startedAt)` → `HealthReport`；`LoopStatus` 带 `ageSec` / `staleAfterSec` |
| 在途合并     | `lib/promiseCache.ts` `createPromiseCache<T>(ttlMs)`                                                                       |

**关键发现：增量续抓不需要新的抓取函数。** `fetchMarketWindow` 已经在
`oldest < sinceSec` 时停止翻页——传一个较晚的 `sinceSec`（上次见到的最新成交
时刻）就是增量抓取，抓第 0 页即止。

---

### Task 1: 窗口合并纯函数

**Files:**

- Create: `lib/marketWindow.ts`
- Test: `lib/marketWindow.test.ts`

**Step 1: 写失败测试**

```typescript
import { describe, it, expect } from "vitest";
import { mergeWindow } from "./marketWindow";
import type { Trade } from "./types";

const trade = (ts: number, hash: string): Trade => ({
  proxyWallet: "0xa",
  side: "BUY",
  asset: "1",
  conditionId: "0xc1",
  size: 100,
  price: 0.5,
  timestamp: ts,
  title: "t",
  slug: "s",
  eventSlug: "e",
  outcome: "Yes",
  outcomeIndex: 0,
  transactionHash: hash,
});

describe("mergeWindow", () => {
  it("新成交并入既有窗口,结果按时间倒序", () => {
    const prev = [trade(200, "0xb"), trade(100, "0xa")];
    const out = mergeWindow(prev, [trade(300, "0xc")], 0);
    expect(out.map((t) => t.timestamp)).toEqual([300, 200, 100]);
  });

  it("重叠的成交只留一份 —— 续抓必然重复覆盖锚点那一笔", () => {
    const prev = [trade(200, "0xb")];
    // 续抓从 newestTs 起,那一笔会被再抓一次。
    const out = mergeWindow(prev, [trade(300, "0xc"), trade(200, "0xb")], 0);
    expect(out).toHaveLength(2);
  });

  it("滚动裁剪:超出窗口下界的尾部丢弃(窗口是滑动的,不是累积的)", () => {
    const prev = [trade(200, "0xb"), trade(100, "0xa")];
    const out = mergeWindow(prev, [], 150);
    expect(out.map((t) => t.timestamp)).toEqual([200]);
  });

  it("空续抓只做裁剪,不动既有内容", () => {
    const prev = [trade(200, "0xb")];
    expect(mergeWindow(prev, [], 0)).toHaveLength(1);
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/marketWindow.test.ts`
Expected: FAIL — `mergeWindow` is not exported / 模块不存在

**Step 3: 最小实现**

```typescript
import type { Trade } from "./types";
import { dedupKey } from "./trades";

// 市场深度卡的窗口层。贵的是**窗口**不是卡片:composeMarketBrief 是纯函数、
// 告警命中史是本地 SQL、钱包账龄永久缓存 —— 拿一份窗口重算一张卡几乎不要钱。
// 所以缓存与预算都围着窗口转,卡片每次现合成。
//
// 增量续抓:24h 窗口里只有最近这一分钟是新的,整窗重抓是在重付已付过的钱。
// 记住上次见到的最新成交时刻,续抓时 fetchMarketWindow 会在第 0 页就
// `oldest < sinceSec` 而停 —— 与引擎告警循环 hasSeenAny 的止页是同一招。

/**
 * 把续抓到的成交并入既有窗口。
 * 去重按 dedupKey(续抓必然重复覆盖锚点那一笔);结果 newest-first;
 * 早于 cutoffSec 的尾部丢弃 —— 窗口是滑动的,不是累积的。
 */
export function mergeWindow(
  prev: Trade[],
  incoming: Trade[],
  cutoffSec: number,
): Trade[] {
  const seen = new Set<string>();
  const out: Trade[] = [];
  for (const t of [...incoming, ...prev]) {
    if (t.timestamp < cutoffSec) continue;
    const k = dedupKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out;
}
```

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/marketWindow.test.ts`
Expected: PASS (4 tests)

**Step 5: 提交**

```bash
git add lib/marketWindow.ts lib/marketWindow.test.ts
git commit -m "feat: 市场窗口合并纯函数 —— 增量续抓的去重与滚动裁剪"
```

---

### Task 2: 预算档位从引擎健康度推导

**Files:**

- Create: `lib/cardBudget.ts`
- Test: `lib/cardBudget.test.ts`

**为什么先做这个：** 窗口层要向它取令牌，先把被依赖的一侧钉死。

**Step 1: 写失败测试**

```typescript
import { describe, it, expect } from "vitest";
import { budgetFor, CARD_BUDGET_PER_MIN } from "./cardBudget";

const loop = (loopName: string, ageSec: number, staleAfterSec: number) => ({
  loop: loopName,
  lastTs: 1,
  ageSec,
  staleAfterSec,
  stale: ageSec > staleAfterSec,
  cycles: 1,
});

describe("budgetFor", () => {
  it("循环全部准时 —— 满额", () => {
    const b = budgetFor({ staleLoops: [], loops: [loop("alert", 4, 60)] });
    expect(b).toBe(CARD_BUDGET_PER_MIN);
  });

  it("有循环断更 —— 归零,只发降级", () => {
    // 引擎断更时继续取令牌是在加深故障:断更的原因很可能正是 data-api 被挤爆。
    const b = budgetFor({
      staleLoops: ["consensus"],
      loops: [loop("consensus", 900, 600)],
    });
    expect(b).toBe(0);
  });

  it("循环开始漂移(超过 staleAfter 的 60%)—— 降到 25%", () => {
    const b = budgetFor({ staleLoops: [], loops: [loop("alert", 40, 60)] });
    expect(b).toBe(Math.floor(CARD_BUDGET_PER_MIN * 0.25));
  });

  it("取所有循环里最坏的那个,不是平均 —— 一个循环喘不过气就够了", () => {
    const b = budgetFor({
      staleLoops: [],
      loops: [loop("alert", 4, 60), loop("consensus", 500, 600)],
    });
    expect(b).toBe(Math.floor(CARD_BUDGET_PER_MIN * 0.25));
  });

  it("ageSec 未知的循环不参与判定(没数据不等于在漂移)", () => {
    const b = budgetFor({
      staleLoops: [],
      loops: [{ ...loop("x", 0, 60), ageSec: null }],
    });
    expect(b).toBe(CARD_BUDGET_PER_MIN);
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/cardBudget.test.ts`
Expected: FAIL — 模块不存在

**Step 3: 最小实现**

```typescript
import { rateLimit } from "./apiGuard";

// 市场深度卡的上游预算。
//
// 两条判断,顺序不能反:
//  1. **闸门计量的是「续抓次数」而非「请求次数」** —— 现有 guardExpensive 限的是
//     请求数 N,而上游成本取决于去重后的市场数 M。promise cache 早把同 cid 的
//     并发合并成免费,真正要命的是「三百个人各看一个不同市场」。
//  2. **额度从属引擎健康度** ——「服务性能允许的范围」不该是拍脑袋的常数。
//     引擎断更时继续取令牌是在加深故障:断更的原因很可能正是 data-api 被挤爆。

/** 满额:引擎稳态(~20-25 req/min)的 4 倍。热续恒 1 请求,故这也是刷新次数。 */
export const CARD_BUDGET_PER_MIN = 100;

/** 漂移线:循环年龄超过它自己 staleAfter 的这个比例,就算开始喘。 */
const DRIFT_RATIO = 0.6;
const DRIFT_BUDGET_FACTOR = 0.25;

export interface BudgetHealth {
  staleLoops: string[];
  loops: { ageSec: number | null; staleAfterSec: number }[];
}

/** 本刻允许的每分钟续抓次数。0 = 只发降级。 */
export function budgetFor(health: BudgetHealth): number {
  if (health.staleLoops.length > 0) return 0;
  // 最坏的那个循环说了算,不是平均 —— 一个循环喘不过气就够了。
  const worst = health.loops.reduce((m, l) => {
    if (l.ageSec == null || l.staleAfterSec <= 0) return m;
    return Math.max(m, l.ageSec / l.staleAfterSec);
  }, 0);
  if (worst >= DRIFT_RATIO) {
    return Math.floor(CARD_BUDGET_PER_MIN * DRIFT_BUDGET_FACTOR);
  }
  return CARD_BUDGET_PER_MIN;
}

/**
 * 取一枚续抓令牌。复用 apiGuard 的滑窗计数器(同一进程、同一姿态)。
 * 注意其语义:被拒的调用同样计数 —— 那正是「压力下自我收敛」想要的。
 */
export function takeCardToken(limit: number, nowMs = Date.now()): boolean {
  if (limit <= 0) return false;
  return rateLimit("market-card:__upstream__", limit, 60_000, nowMs, 1);
}
```

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/cardBudget.test.ts`
Expected: PASS (5 tests)

**Step 5: 提交**

```bash
git add lib/cardBudget.ts lib/cardBudget.test.ts
git commit -m "feat: 卡片上游预算 —— 计量续抓次数,额度从属引擎健康度"
```

---

### Task 3: 窗口层（LRU + 增量续抓 + 在途合并）

**Files:**

- Modify: `lib/marketWindow.ts`
- Modify: `lib/marketWindow.test.ts`

**Step 1: 写失败测试**（追加到既有文件末尾）

```typescript
import { getMarketWindow, __resetWindows } from "./marketWindow";

describe("getMarketWindow", () => {
  const NOW = 1_700_000_000;

  it("首次是冷启:按整窗抓,sinceSec = now − 24h", async () => {
    __resetWindows();
    const calls: number[] = [];
    const r = await getMarketWindow("0xc1", {
      nowSec: NOW,
      takeToken: () => true,
      fetchWindow: async (_cid, o) => {
        calls.push(o.sinceSec);
        return { trades: [trade(NOW - 10, "0xa")], truncated: false };
      },
    });
    expect(calls).toEqual([NOW - 24 * 3600]);
    expect(r.degraded).toBe(false);
    expect(r.trades).toHaveLength(1);
  });

  it("TTL 内不再抓 —— 零上游", async () => {
    __resetWindows();
    let n = 0;
    const deps = {
      takeToken: () => true,
      fetchWindow: async () => {
        n++;
        return { trades: [trade(NOW - 10, "0xa")], truncated: false };
      },
    };
    await getMarketWindow("0xc1", { ...deps, nowSec: NOW });
    await getMarketWindow("0xc1", { ...deps, nowSec: NOW + 10 });
    expect(n).toBe(1);
  });

  it("TTL 过后是增量续抓:sinceSec = 上次见到的最新成交时刻", async () => {
    __resetWindows();
    const calls: number[] = [];
    const deps = {
      takeToken: () => true,
      fetchWindow: async (_cid: string, o: { sinceSec: number }) => {
        calls.push(o.sinceSec);
        return { trades: [trade(NOW - 10, "0xa")], truncated: false };
      },
    };
    await getMarketWindow("0xc1", { ...deps, nowSec: NOW });
    await getMarketWindow("0xc1", { ...deps, nowSec: NOW + 60 });
    // 第二次的下界是第一次抓到的最新成交 —— 这就是「只续新的」。
    expect(calls[1]).toBe(NOW - 10);
  });

  it("没有令牌但有陈旧窗口 —— 降级返回,不发上游请求", async () => {
    __resetWindows();
    let n = 0;
    await getMarketWindow("0xc1", {
      nowSec: NOW,
      takeToken: () => true,
      fetchWindow: async () => {
        n++;
        return { trades: [trade(NOW - 10, "0xa")], truncated: false };
      },
    });
    const r = await getMarketWindow("0xc1", {
      nowSec: NOW + 60,
      takeToken: () => false,
      fetchWindow: async () => {
        n++;
        return { trades: [], truncated: false };
      },
    });
    expect(n).toBe(1);
    expect(r.degraded).toBe(true);
    expect(r.builtAt).toBe(NOW);
  });

  it("没有令牌也没有窗口 —— 抛 NoBudgetError,由调用方转 429", async () => {
    __resetWindows();
    await expect(
      getMarketWindow("0xcold", {
        nowSec: NOW,
        takeToken: () => false,
        fetchWindow: async () => ({ trades: [], truncated: false }),
      }),
    ).rejects.toThrow(NoBudgetError);
  });

  it("LRU 上限:超出后淘汰最久未用的市场", async () => {
    __resetWindows();
    const deps = {
      takeToken: () => true,
      fetchWindow: async () => ({
        trades: [trade(NOW - 10, "0xa")],
        truncated: false,
      }),
    };
    for (let i = 0; i <= WINDOW_LRU_MAX; i++) {
      await getMarketWindow(`0x${i}`, { ...deps, nowSec: NOW + i });
    }
    expect(windowCount()).toBe(WINDOW_LRU_MAX);
  });
});
```

（记得把 `NoBudgetError` / `WINDOW_LRU_MAX` / `windowCount` 加进顶部 import。）

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/marketWindow.test.ts`
Expected: FAIL — `getMarketWindow` 不存在（Task 1 的 4 条仍 PASS）

**Step 3: 最小实现**（追加到 `lib/marketWindow.ts`）

```typescript
import { createPromiseCache } from "./promiseCache";
import { fetchMarketWindow } from "./marketBrief";
import { CARD_WINDOW_SEC } from "./marketCard";

/** 窗口新鲜期。也是卡片的年龄上限 —— 两者是同一个数。 */
export const WINDOW_TTL_SEC = 30;
/** 工作集上限(市场数)。单市场 24h/$500 约 ~200KB,200 个约 40MB。 */
export const WINDOW_LRU_MAX = 200;

/** 既没令牌又没窗口 —— 没有任何诚实的东西可返回。 */
export class NoBudgetError extends Error {
  constructor() {
    super("upstream budget exhausted and no cached window");
    this.name = "NoBudgetError";
  }
}

interface WindowEntry {
  trades: Trade[];
  truncated: boolean;
  /** 续抓锚点:上次见到的最新成交时刻。 */
  newestTs: number;
  /** 本窗口最后一次成功续抓的时刻。 */
  builtAt: number;
  /** LRU 用。 */
  touchedAt: number;
}

const windows = new Map<string, WindowEntry>();
// 在途合并:同一 cid 的并发请求共用一次续抓,而不是各发各的。
const inFlight = createPromiseCache<WindowEntry>(WINDOW_TTL_SEC * 1000);

export function windowCount(): number {
  return windows.size;
}

/** 仅供测试:清空工作集与在途表。 */
export function __resetWindows(): void {
  windows.clear();
}

export interface MarketWindowResult {
  trades: Trade[];
  truncated: boolean;
  builtAt: number;
  /** true = 本次没拿到令牌,返回的是陈旧窗口。 */
  degraded: boolean;
}

export interface MarketWindowDeps {
  nowSec: number;
  takeToken: () => boolean;
  fetchWindow?: typeof fetchMarketWindow;
}

export async function getMarketWindow(
  conditionId: string,
  deps: MarketWindowDeps,
): Promise<MarketWindowResult> {
  const { nowSec, takeToken, fetchWindow = fetchMarketWindow } = deps;
  const cid = conditionId.toLowerCase();
  const prev = windows.get(cid);

  if (prev && nowSec - prev.builtAt < WINDOW_TTL_SEC) {
    prev.touchedAt = nowSec;
    return { ...toResult(prev), degraded: false };
  }
  if (!takeToken()) {
    // 预算耗尽:有陈旧窗口就降级,没有就诚实拒绝。
    if (prev) {
      prev.touchedAt = nowSec;
      return { ...toResult(prev), degraded: true };
    }
    throw new NoBudgetError();
  }

  const entry = await inFlight(cid, async () => {
    // 冷启抓整窗;热续只抓 newestTs 之后 —— fetchMarketWindow 会在
    // `oldest < sinceSec` 时停止翻页,于是第 0 页就止,恒 1 个请求。
    const sinceSec = prev ? prev.newestTs : nowSec - CARD_WINDOW_SEC;
    const got = await fetchWindow(conditionId, { sinceSec });
    const merged = mergeWindow(
      prev?.trades ?? [],
      got.trades,
      nowSec - CARD_WINDOW_SEC,
    );
    const next: WindowEntry = {
      trades: merged,
      truncated: got.truncated,
      newestTs: merged[0]?.timestamp ?? sinceSec,
      builtAt: nowSec,
      touchedAt: nowSec,
    };
    windows.set(cid, next);
    evictLru();
    return next;
  });
  return { ...toResult(entry), degraded: false };
}

function toResult(e: WindowEntry) {
  return { trades: e.trades, truncated: e.truncated, builtAt: e.builtAt };
}

function evictLru(): void {
  while (windows.size > WINDOW_LRU_MAX) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, v] of windows) {
      if (v.touchedAt < oldest) {
        oldest = v.touchedAt;
        oldestKey = k;
      }
    }
    if (oldestKey === null) return;
    windows.delete(oldestKey);
  }
}
```

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/marketWindow.test.ts`
Expected: PASS (10 tests)

**Step 5: 提交**

```bash
git add lib/marketWindow.ts lib/marketWindow.test.ts
git commit -m "feat: 窗口层 —— 增量续抓 + LRU 工作集 + 无预算时降级"
```

---

### Task 4: 卡片服务编排（陈旧闸）

**Files:**

- Create: `lib/marketCardService.ts`
- Test: `lib/marketCardService.test.ts`

**Step 1: 写失败测试**

```typescript
import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { serveMarketCard, STALE_GATE_SEC } from "./marketCardService";
import { __resetWindows } from "./marketWindow";

const NOW = 1_700_000_000;

describe("serveMarketCard", () => {
  it("窗口新鲜 —— live:true,staleSec 为 0", async () => {
    __resetWindows();
    const db = openDb(":memory:");
    const r = await serveMarketCard(db, "0xc1", {
      nowSec: NOW,
      takeToken: () => true,
      fetchWindow: async () => ({ trades: [], truncated: false }),
      agesFetcher: async () => ({}),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.live).toBe(true);
      expect(r.staleSec).toBe(0);
    }
    db.close();
  });

  it("预算耗尽但窗口在闸内 —— live:false 且带 staleSec", async () => {
    __resetWindows();
    const db = openDb(":memory:");
    const deps = {
      fetchWindow: async () => ({ trades: [], truncated: false }),
      agesFetcher: async () => ({}),
    };
    await serveMarketCard(db, "0xc1", {
      ...deps,
      nowSec: NOW,
      takeToken: () => true,
    });
    const r = await serveMarketCard(db, "0xc1", {
      ...deps,
      nowSec: NOW + 60,
      takeToken: () => false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.live).toBe(false);
      expect(r.staleSec).toBe(60);
    }
    db.close();
  });

  it("超过陈旧闸 —— 拒绝而非给出会误导的旧卡", async () => {
    __resetWindows();
    const db = openDb(":memory:");
    const deps = {
      fetchWindow: async () => ({ trades: [], truncated: false }),
      agesFetcher: async () => ({}),
    };
    await serveMarketCard(db, "0xc1", {
      ...deps,
      nowSec: NOW,
      takeToken: () => true,
    });
    // 卡片说「3 个聪明钱刚买入」而其中 2 个已卖出,那不是不够新,是错的。
    const r = await serveMarketCard(db, "0xc1", {
      ...deps,
      nowSec: NOW + STALE_GATE_SEC + 1,
      takeToken: () => false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(429);
    db.close();
  });

  it("从未抓过的市场 + 预算耗尽 —— 同样 429,不给空壳卡", async () => {
    __resetWindows();
    const db = openDb(":memory:");
    const r = await serveMarketCard(db, "0xcold", {
      nowSec: NOW,
      takeToken: () => false,
      fetchWindow: async () => ({ trades: [], truncated: false }),
      agesFetcher: async () => ({}),
    });
    expect(r.ok).toBe(false);
    db.close();
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/marketCardService.test.ts`
Expected: FAIL — 模块不存在

**Step 3: 最小实现**

```typescript
import type { DB } from "./db";
import { buildMarketCard, type MarketCard } from "./marketCard";
import { getMarketWindow, NoBudgetError } from "./marketWindow";
import type { fetchMarketWindow } from "./marketBrief";
import type { getWalletAges } from "./walletAge";

// 卡片服务:窗口层之上的编排。窗口负责「贵不贵」,这里负责「给不给」。

/**
 * 硬陈旧闸。超过它宁可 429 也不发卡 —— 带 staleSec 让客户端自己判断是不够的,
 * 客户端会为了不显示空白而照渲染。契约层面拒绝,才是真的拒绝。
 */
export const STALE_GATE_SEC = 90;

export type CardOutcome =
  | {
      ok: true;
      card: MarketCard;
      builtAt: number;
      staleSec: number;
      live: boolean;
    }
  | { ok: false; status: 429; retryAfterSec: number };

export interface CardServiceDeps {
  nowSec: number;
  takeToken: () => boolean;
  fetchWindow?: typeof fetchMarketWindow;
  agesFetcher?: typeof getWalletAges;
}

export async function serveMarketCard(
  db: DB,
  conditionId: string,
  deps: CardServiceDeps,
): Promise<CardOutcome> {
  const { nowSec, takeToken, fetchWindow, agesFetcher } = deps;
  let win;
  try {
    win = await getMarketWindow(conditionId, {
      nowSec,
      takeToken,
      fetchWindow,
    });
  } catch (e) {
    if (e instanceof NoBudgetError) {
      return { ok: false, status: 429, retryAfterSec: 30 };
    }
    throw e;
  }
  const staleSec = Math.max(0, nowSec - win.builtAt);
  if (staleSec > STALE_GATE_SEC) {
    return { ok: false, status: 429, retryAfterSec: 30 };
  }
  // 卡片每次现合成 —— 纯 CPU + 本地 SQL + 永久缓存的账龄,几乎不要钱。
  // 这正是不必再存一份「卡片缓存」的理由:贵的是窗口。
  const card = await buildMarketCard(db, conditionId, {
    nowSec,
    fetchWindow: async () => ({
      trades: win.trades,
      truncated: win.truncated,
    }),
    agesFetcher,
  });
  return {
    ok: true,
    card,
    builtAt: win.builtAt,
    staleSec,
    live: !win.degraded,
  };
}
```

**Step 4: 跑测试确认通过**

Run: `npx vitest run lib/marketCardService.test.ts`
Expected: PASS (4 tests)

**Step 5: 提交**

```bash
git add lib/marketCardService.ts lib/marketCardService.test.ts
git commit -m "feat: 卡片服务编排 —— 陈旧闸超限即拒,不给会误导的旧卡"
```

---

### Task 5: 对外端点 + `market` 订阅范围

**Files:**

- Create: `app/api/signals/market/[conditionId]/route.ts`
- Test: `app/api/signals/market/route.test.ts`

**为什么是新端点：** `/api/market/[cid]` 服务网页与 bot（无 key）。把「强制鉴权 +
范围 + 令牌桶 + 陈旧闸」和「本地免鉴权」两套策略塞进一个路由会很脏，而且对外
契约一旦定了就不该随网页需求自由改。两条路由共用 `buildMarketCard`——与
「bot 和 dashboard 共用一份实现」是同一个模式。

**Step 1: 写失败测试**

```typescript
import { describe, it, expect } from "vitest";
import { GET } from "../../../../app/api/signals/market/[conditionId]/route";
// 路径按实际相对位置调整;本仓既有路由测试见 app/api/signals/route.test.ts

describe("GET /api/signals/market/[conditionId]", () => {
  it("非法 conditionId → 400", async () => {
    const res = await GET(new Request("http://x/api/signals/market/nope"), {
      params: Promise.resolve({ conditionId: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("响应带 builtAt / staleSec / live / healthy / notice", async () => {
    const res = await GET(
      new Request(`http://x/api/signals/market/0x${"a".repeat(64)}`),
      { params: Promise.resolve({ conditionId: `0x${"a".repeat(64)}` }) },
    );
    const body = await res.json();
    for (const k of [
      "card",
      "builtAt",
      "staleSec",
      "live",
      "healthy",
      "notice",
    ]) {
      expect(body).toHaveProperty(k);
    }
  });
});
```

> 本仓路由测试的既有姿态见 `app/api/signals/route.test.ts`——照它组织
> `DASH_DB` 与 env，本任务不要自创第二套。

**Step 2: 跑测试确认失败**

Run: `npx vitest run app/api/signals/market/route.test.ts`
Expected: FAIL — 路由不存在

**Step 3: 最小实现**

```typescript
import { openDb } from "../../../../../lib/db";
import { checkFeedAccess } from "../../../../../lib/feedAuth";
import { busTypeAllowed } from "../../../../../lib/apiKeys";
import { getEngineStart, getHeartbeats } from "../../../../../lib/heartbeat";
import { evaluateHealth } from "../../../../../lib/health";
import { budgetFor, takeCardToken } from "../../../../../lib/cardBudget";
import { serveMarketCard } from "../../../../../lib/marketCardService";
import { SIGNAL_DISCLAIMER } from "../../../../../lib/signalDelivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 对外的市场深度卡。与 /api/market/[cid](网页 + TG bot,无 key)刻意分立:
// 那条是内部面,可随网页需求自由改;这条是对外契约,要鉴权/范围/预算/陈旧闸。
// 二者共用 buildMarketCard 与同一个窗口层、同一个令牌桶 —— 上游预算本来就是
// 同一份,且热门市场高度重合,共享工作集是净收益(互相预热)。
//
// 范围 `market` 是 realtime 专属。这不违反「延迟是唯一杠杆、字段不阉割」:
// 那条管的是同一端点内不同 tier 的字段集;范围机制本来就是「没订阅就拿不到」。

const CID_RE = /^0x[0-9a-fA-F]{64}$/;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ conditionId: string }> },
) {
  const { conditionId } = await params;
  if (!CID_RE.test(conditionId)) {
    return Response.json({ error: "invalid conditionId" }, { status: 400 });
  }
  const dbPath = process.env.DASH_DB ?? "data.sqlite";
  const db = openDb(dbPath);
  try {
    const access = checkFeedAccess(req, db);
    if (!access.ok) {
      return Response.json({ error: access.error }, { status: access.status });
    }
    if (!busTypeAllowed(access.busTypes, "market")) {
      return Response.json(
        { error: "scope 'market' not granted" },
        { status: 403 },
      );
    }
    if (access.tier !== "realtime") {
      // 深度决策卡是实时能力 —— 一张延迟 30 分钟的盘面回答不了「我现在该不该进」。
      return Response.json(
        { error: "market cards require the realtime tier" },
        { status: 403 },
      );
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const health = evaluateHealth(
      getHeartbeats(db),
      nowSec,
      getEngineStart(db),
    );
    const limit = budgetFor(health);
    const out = await serveMarketCard(db, conditionId, {
      nowSec,
      takeToken: () => takeCardToken(limit),
    });
    if (!out.ok) {
      return Response.json(
        {
          error: "upstream budget exhausted — retry shortly",
          healthy: health.ok,
        },
        { status: 429, headers: { "retry-after": String(out.retryAfterSec) } },
      );
    }
    return Response.json({
      card: out.card,
      builtAt: out.builtAt,
      staleSec: out.staleSec,
      live: out.live,
      healthy: health.ok,
      notice: SIGNAL_DISCLAIMER,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/signals/market] failed:", message);
    return Response.json({ error: message }, { status: 500 });
  } finally {
    db.close();
  }
}
```

> 确认 `SIGNAL_DISCLAIMER` 的实际导出位置（`grep -rn "SIGNAL_DISCLAIMER" lib/`），
> 用真实路径，不要照抄这里的猜测。

**Step 4: 跑测试确认通过**

Run: `npx vitest run app/api/signals/market/route.test.ts`
Expected: PASS

**Step 5: 提交**

```bash
git add app/api/signals/market lib
git commit -m "feat: GET /api/signals/market/[cid] —— 对外市场深度卡(realtime + market 范围)"
```

---

### Task 6: 内部路由接入同一窗口层与令牌桶

**Files:**

- Modify: `app/api/market/[conditionId]/route.ts`

**为什么：** 上游预算本来就是同一份，分两个桶只是把同一个天花板切成两半；而
网页在看的热门市场正好也是订阅方在看的，**共享工作集是净收益**。内部路由保留
现有的 `guardExpensive`（防单 IP 滥用），叠加在桶之上。

**Step 1: 写失败测试**

```typescript
it("网页路由与对外路由共用同一个窗口 —— 一边预热,另一边直接命中", async () => {
  __resetWindows();
  const db = openDb(":memory:");
  let fetches = 0;
  const deps = {
    fetchWindow: async () => {
      fetches++;
      return { trades: [], truncated: false };
    },
    agesFetcher: async () => ({}),
  };
  await serveMarketCard(db, "0xc1", {
    ...deps,
    nowSec: NOW,
    takeToken: () => true,
  });
  await serveMarketCard(db, "0xc1", {
    ...deps,
    nowSec: NOW + 5,
    takeToken: () => true,
  });
  expect(fetches).toBe(1);
  db.close();
});
```

（放进 `lib/marketCardService.test.ts`——它测的是「共用」这个性质，不是某条路由。）

**Step 2: 跑测试确认失败**

Run: `npx vitest run lib/marketCardService.test.ts`
Expected: 这条可能直接 PASS（窗口层本就共享）。**若 PASS，说明它测的是既有行为**——
按 TDD 纪律，改成一条真正会红的测试：断言 `/api/market/[cid]` 走的是
`serveMarketCard` 而非 `buildMarketCard`（例如注入 `takeToken: () => false`
且无窗口时该路由返回 429 而不是 200）。

**Step 3: 改内部路由**

把 `app/api/market/[conditionId]/route.ts` 里的 `cardCache(... buildMarketCard ...)`
换成 `serveMarketCard(db, conditionId, { nowSec, takeToken })`，并删掉它自己的
`createPromiseCache`——在途合并现在归窗口层管，两层缓存叠在一起只会让「卡片
到底多新」这个问题多一个说不清的来源。

保留 `guardExpensive`。响应体**追加** `builtAt` / `staleSec` / `live`（additive，
网页与 bot 可忽略）。

**Step 4: 跑全量**

Run: `npx vitest run`
Expected: 全绿。特别检查 `lib/botCommands.test.ts`——bot 的 🎯 回复也走这条路。

**Step 5: 提交**

```bash
git add app/api/market lib
git commit -m "refactor: 网页/bot 卡片路由接入同一窗口层 —— 上游预算是同一份"
```

---

### Task 7: 文档

**Files:**

- Modify: `docs/api-access.md`（新增一章「市场深度卡」）
- Modify: `docs/signals-api.md`（v4 段）
- Modify: `docs/plans/2026-08-21-market-card-api-design.md`（订正 L2 已砍）
- Modify: `CHANGELOG.md`（新批次）

**必须写进 `api-access.md` 的四件事：**

1. 端点、鉴权、`market` 范围、realtime 专属；
2. 响应形状与 `builtAt` / `staleSec` / `live` 的确切语义；
3. **降级与 429 的判据表**——订阅方必须知道 429 不是错误而是背压，且要按
   `Retry-After` 退避；
4. **红线四**：上游是无版本的公开 API，`/activity` 的 limit 曾从 1000 静默降到
   500 并直接把钱包档案页全挂。`/api/signals` 没有这个暴露面，这条端点有。
   不写等于把一个我们控制不了的依赖偷偷接进订阅方的 SLA。

**Step: 提交**

```bash
git add docs CHANGELOG.md
git commit -m "docs: 市场深度卡对外契约 —— 含背压语义与上游依赖风险告知"
```

---

## 验收

```bash
npx tsc --noEmit && npx vitest run
```

全绿，且新增测试覆盖：合并去重/裁剪、预算三档、冷启 vs 续抓的 `sinceSec`、
LRU 淘汰、降级、陈旧闸、429 两条路径。

## 不在本批次

- `/manage` 可观测面板（预算用量、工作集大小、命中率、降级次数）
- 参数 UI 可调（当前只走常量/环境变量）
- 窗口层落库（重启保工作集）
- 每钱包 `score` / `winRate` 的对外分档（设计 §9 暂定照给）
