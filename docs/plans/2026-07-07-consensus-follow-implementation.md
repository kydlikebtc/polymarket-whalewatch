# 共识跟单纸面模拟 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在既有只读的聪明钱共识检测之上,新增一层「纸面跟单」——共识形成时按现价开虚拟仓、持有到结算、聚合成多策略并行的净值曲线与指标。

**Architecture:** 纯函数(P&L/指标)+ 注入式 `runFollowCycle` 挂在 5min 共识循环旁;2 张新 SQLite 表;`/follow` 页 + `/api/follow` 路由。全程复用 `detectConsensus`/`priceHistory`/`gamma`/`outcomeStats`,零真实下单。

**Tech Stack:** TypeScript · Next.js 16 · better-sqlite3 · zod · vitest。设计见 `docs/plans/2026-07-07-consensus-follow-design.md`。

**约定:** 每个纯函数先写失败测试→跑失败→最小实现→跑通→提交。测试命令 `npx vitest run <path>`。分支 `claude/frosty-lalande-fb91e1`,勿动 main。

---

## 阶段 P2a — 数据模型 + P&L 核心 + 循环

### Task 1: 数据库迁移(2 表 + 策略种子)

**Files:**

- Modify: `lib/db.ts`(在 `openDb` 的建表块内追加两表 + 版本门控种子)
- Test: `lib/follow.db.test.ts`(新建)

**Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "./db";

describe("follow tables migration", () => {
  it("creates follow_strategies + follow_positions and seeds two strategies once", () => {
    const db = openDb(":memory:");
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('follow_strategies','follow_positions')",
      )
      .all()
      .map((r: any) => r.name)
      .sort();
    expect(tables).toEqual(["follow_positions", "follow_strategies"]);

    const strats = db
      .prepare("SELECT name FROM follow_strategies ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(strats).toEqual(["保守", "激进"]);

    db.prepare(
      "INSERT INTO follow_positions (strategy_id, condition_id, outcome, status) VALUES (1,'c','Yes','open')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO follow_positions (strategy_id, condition_id, outcome, status) VALUES (1,'c','Yes','open')",
        )
        .run(),
    ).toThrow();
  });
});
```

**Step 2: 跑失败** — `npx vitest run lib/follow.db.test.ts` → FAIL(表不存在)。

**Step 3: 最小实现** — 在 `lib/db.ts` 现有建表 SQL 块(与 `seen_trades`/`smart_wallets` 等并列)追加:

```sql
CREATE TABLE IF NOT EXISTS follow_strategies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, enabled INTEGER DEFAULT 1, params_json TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS follow_positions (id INTEGER PRIMARY KEY AUTOINCREMENT, strategy_id INTEGER, condition_id TEXT, outcome TEXT, asset TEXT, outcome_index INTEGER, title TEXT, event_slug TEXT, entry_ts INTEGER, entry_price REAL, smart_avg_price REAL, size_usd REAL, shares REAL, status TEXT, exit_ts INTEGER, exit_price REAL, realized_pnl REAL, UNIQUE(strategy_id, condition_id, outcome));
```

在 `openDb` 尾部(`return db` 前)加版本门控种子(仿现有 `*_v` config 门控):

```ts
const followVer = db
  .prepare("SELECT value FROM config WHERE key='follow_seed_v'")
  .get() as { value: string | null } | undefined;
if (followVer?.value !== "1") {
  const ins = db.prepare(
    "INSERT OR IGNORE INTO follow_strategies (name, enabled, params_json, created_at) VALUES (?,1,?,?)",
  );
  const now = Math.floor(Date.now() / 1000);
  ins.run(
    "保守",
    JSON.stringify({
      minWallets: 3,
      minPerWalletUsd: 10000,
      sizeUsd: 500,
      exitRule: "settlement",
    }),
    now,
  );
  ins.run(
    "激进",
    JSON.stringify({
      minWallets: 2,
      minPerWalletUsd: 5000,
      sizeUsd: 500,
      exitRule: "settlement",
    }),
    now,
  );
  db.prepare(
    "INSERT OR REPLACE INTO config (key, value) VALUES ('follow_seed_v','1')",
  ).run();
}
```

**Step 4: 跑通** — `npx vitest run lib/follow.db.test.ts` → PASS。

**Step 5: 提交**

```bash
git add lib/db.ts lib/follow.db.test.ts
git commit -m "feat: follow 纸面跟单表结构 + 策略种子迁移"
```

---

### Task 2: 单仓 P&L 纯函数

**Files:**

- Create: `lib/follow.ts`
- Test: `lib/follow.test.ts`

**Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import {
  positionShares,
  positionRealizedPnl,
  positionSlippage,
} from "./follow";

describe("follow single-position P&L", () => {
  it("shares = size / entry", () => {
    expect(positionShares(500, 0.5)).toBeCloseTo(1000);
  });
  it("realized = shares*(exit-entry) — 赢", () => {
    expect(positionRealizedPnl(0.5, 1, 500)).toBeCloseTo(500);
  });
  it("realized — 输(结算 0)= -size", () => {
    expect(positionRealizedPnl(0.5, 0, 500)).toBeCloseTo(-500);
  });
  it("slippage = shares*(entry-smartAvg),现价更贵为正", () => {
    expect(positionSlippage(0.6, 0.57, 500)).toBeCloseTo(25, 0);
  });
  it("entry<=0 时 shares=0(防除零)", () => {
    expect(positionShares(500, 0)).toBe(0);
    expect(positionRealizedPnl(0, 1, 500)).toBe(0);
  });
});
```

**Step 2: 跑失败** — `npx vitest run lib/follow.test.ts` → FAIL。

**Step 3: 最小实现**(`lib/follow.ts` 顶部)

```ts
export function positionShares(sizeUsd: number, entryPrice: number): number {
  return entryPrice > 0 ? sizeUsd / entryPrice : 0;
}
export function positionRealizedPnl(
  entryPrice: number,
  exitPrice: number,
  sizeUsd: number,
): number {
  const shares = positionShares(sizeUsd, entryPrice);
  return shares * (exitPrice - entryPrice);
}
export function positionSlippage(
  entryPrice: number,
  smartAvgPrice: number,
  sizeUsd: number,
): number {
  const shares = positionShares(sizeUsd, entryPrice);
  return shares * (entryPrice - smartAvgPrice);
}
```

**Step 4: 跑通** — PASS。

**Step 5: 提交**

```bash
git add lib/follow.ts lib/follow.test.ts
git commit -m "feat: follow 单仓 P&L 纯函数(shares/realized/slippage)"
```

---

### Task 3: 策略阈值过滤(一次检测服务多策略)

**Files:** Modify `lib/follow.ts` · `lib/follow.test.ts`

**背景:** `detectConsensus` 在「最松阈值」下跑一次,返回的 `ConsensusGroup.wallets[]` 每个带 `netUsd`。`qualifyingGroups` 按某策略的 `minPerWalletUsd`/`minWallets` 二次筛。

**Step 1: 写失败测试**

```ts
import { qualifyingGroups } from "./follow";
const grp = (over: any) => ({
  conditionId: "c",
  outcome: "Yes",
  title: "t",
  eventSlug: "e",
  asset: "a",
  outcomeIndex: 0,
  walletCount: 0,
  totalNetUsd: 0,
  avgBuyPrice: 0.5,
  firstTs: 0,
  lastTs: 0,
  wallets: [],
  ...over,
});

it("按策略阈值二次筛:每人净买>=floor 且 人数>=minWallets", () => {
  const g = grp({
    wallets: [
      { wallet: "w1", netUsd: 12000 },
      { wallet: "w2", netUsd: 11000 },
      { wallet: "w3", netUsd: 6000 },
    ],
  });
  expect(
    qualifyingGroups([g], { minWallets: 3, minPerWalletUsd: 10000 }).length,
  ).toBe(0);
  expect(
    qualifyingGroups([g], { minWallets: 2, minPerWalletUsd: 5000 }).length,
  ).toBe(1);
});
```

**Step 2-4:** 跑失败 → 实现 → 跑通:

```ts
import type { ConsensusGroup } from "./consensus";
export function qualifyingGroups(
  groups: ConsensusGroup[],
  strat: { minWallets: number; minPerWalletUsd: number },
): ConsensusGroup[] {
  return groups.filter(
    (g) =>
      g.wallets.filter((w) => w.netUsd >= strat.minPerWalletUsd).length >=
      strat.minWallets,
  );
}
```

**Step 5: 提交** `git commit -m "feat: follow 策略阈值二次过滤"`

---

### Task 4: 入场价选取(现价优先,窗口最近成交价回退)

**Files:** Modify `lib/follow.ts` · `lib/follow.test.ts`

**Step 1: 失败测试**

```ts
import { latestPriceByAsset } from "./follow";
it("从窗口成交取每个 asset 的最近成交价", () => {
  const trades: any = [
    { asset: "a", price: 0.6, timestamp: 100 },
    { asset: "a", price: 0.63, timestamp: 200 },
    { asset: "b", price: 0.4, timestamp: 150 },
  ];
  const m = latestPriceByAsset(trades);
  expect(m.get("a")).toBe(0.63);
  expect(m.get("b")).toBe(0.4);
});
```

**Step 3: 实现**

```ts
import type { Trade } from "./types";
export function latestPriceByAsset(trades: Trade[]): Map<string, number> {
  const latestTs = new Map<string, number>();
  const price = new Map<string, number>();
  for (const t of trades) {
    const prev = latestTs.get(t.asset);
    if (prev == null || t.timestamp > prev) {
      latestTs.set(t.asset, t.timestamp);
      price.set(t.asset, t.price);
    }
  }
  return price;
}
```

**Step 5: 提交** `git commit -m "feat: follow 窗口最近成交价(入场价回退源)"`

---

### Task 5: runFollowCycle — 开仓 + 结算 + 幂等

**Files:** Modify `lib/follow.ts` · Create `lib/followCycle.test.ts`

**依赖注入接口:**

```ts
export interface FollowCycleDeps {
  db: DB;
  fetchWindow: () => Promise<{ trades: Trade[] }>;
  getSmart: () => Map<string, SmartTag>;
  fetchPrice: (asset: string, tsSec: number) => Promise<number | null>;
  getMeta: (cids: string[]) => Promise<Record<string, MarketMeta>>;
  nowSec?: number;
}
export async function runFollowCycle(
  deps: FollowCycleDeps,
): Promise<{ opened: number; settled: number }>;
```

**逻辑:**

1. 空白名单 → 直接返回 `{opened:0,settled:0}`(同 consensus)。
2. `detectConsensus(trades, smart, 最松阈值)`;最松 = 所有启用策略里 `min(minWallets)`/`min(minPerWalletUsd)`。
3. 对每个启用策略 × `qualifyingGroups`:若 `(strategy_id,condition_id,outcome)` 无行 → 现价开仓。现价 = `fetchPrice(asset, now)` ?? `latestPriceByAsset(trades).get(asset)`;都无则跳过。`INSERT OR IGNORE`(UNIQUE 幂等)。`smart_avg_price` 取 `group.avgBuyPrice`;`shares=positionShares(size, entry)`。
4. 结算:取所有 `status='open'` 仓位的 conditionId → `getMeta` → 若 `closed`:`exit_price=outcomePrices[outcome_index]`,`realized_pnl=positionRealizedPnl(entry,exit,size)`,`status='settled'`,`exit_ts=now`。

**Step 1: 失败测试(三个)**

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { runFollowCycle } from "./follow";

const smart = () =>
  new Map([
    ["w1", { score: 80, winRate: 0.7, netPnl: 1, isWhitelist: true }],
    ["w2", { score: 75, winRate: 0.65, netPnl: 1, isWhitelist: true }],
  ]) as any;
const trade = (o: any) => ({
  proxyWallet: "w1",
  side: "BUY",
  asset: "tok",
  conditionId: "c1",
  size: 100,
  price: 0.6,
  timestamp: 1000,
  title: "T",
  slug: "s",
  eventSlug: "e",
  outcome: "Yes",
  outcomeIndex: 0,
  transactionHash: "h1",
  ...o,
});

it("激进:2 钱包各净买 $6k 同向 → 现价开 1 仓", async () => {
  const db = openDb(":memory:");
  const trades = [
    trade({
      proxyWallet: "w1",
      transactionHash: "h1",
      size: 10000,
      price: 0.6,
    }),
    trade({
      proxyWallet: "w2",
      transactionHash: "h2",
      size: 10000,
      price: 0.6,
    }),
  ];
  const r = await runFollowCycle({
    db,
    fetchWindow: async () => ({ trades }),
    getSmart: smart,
    fetchPrice: async () => 0.63,
    getMeta: async () => ({}),
    nowSec: 2000,
  });
  expect(r.opened).toBeGreaterThanOrEqual(1);
  const pos = db
    .prepare("SELECT entry_price FROM follow_positions WHERE condition_id='c1'")
    .get() as any;
  expect(pos.entry_price).toBe(0.63);
});

it("幂等:同组第二轮不重复开仓", async () => {
  const db = openDb(":memory:");
  const trades = [
    trade({ proxyWallet: "w1", size: 10000 }),
    trade({ proxyWallet: "w2", transactionHash: "h2", size: 10000 }),
  ];
  const deps = {
    db,
    fetchWindow: async () => ({ trades }),
    getSmart: smart,
    fetchPrice: async () => 0.63,
    getMeta: async () => ({}),
    nowSec: 2000,
  } as any;
  const a = await runFollowCycle(deps);
  const b = await runFollowCycle(deps);
  expect(b.opened).toBe(0);
  expect(a.opened).toBeGreaterThanOrEqual(1);
});

it("结算:市场 closed → 回填 realized_pnl 并标 settled", async () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO follow_positions (strategy_id,condition_id,outcome,asset,outcome_index,entry_price,size_usd,shares,status) VALUES (1,'c1','Yes','tok',0,0.5,500,1000,'open')",
  ).run();
  const r = await runFollowCycle({
    db,
    fetchWindow: async () => ({ trades: [] }),
    getSmart: smart,
    fetchPrice: async () => null,
    getMeta: async () => ({
      c1: {
        conditionId: "c1",
        closed: true,
        outcomePrices: [1, 0],
        outcomes: ["Yes", "No"],
        volume24hr: null,
        liquidity: null,
        endDate: null,
        category: null,
      } as any,
    }),
    nowSec: 3000,
  });
  expect(r.settled).toBe(1);
  const pos = db
    .prepare(
      "SELECT status, realized_pnl FROM follow_positions WHERE condition_id='c1'",
    )
    .get() as any;
  expect(pos.status).toBe("settled");
  expect(pos.realized_pnl).toBeCloseTo(500);
});
```

**Step 2: 跑失败** — `npx vitest run lib/followCycle.test.ts` → FAIL。

**Step 3: 实现** `runFollowCycle`(读 `follow_strategies WHERE enabled=1` 解析 `params_json`;逻辑见上)。

**Step 4: 跑通** — PASS。

**Step 5: 提交** `git commit -m "feat: runFollowCycle 开仓/结算/幂等(注入式)"`

---

## 阶段 P2b — 策略级指标

### Task 6: computeStrategyMetrics(净值/回撤/Wilson/持有期/滑点/按赛道)

**Files:** Modify `lib/follow.ts` · `lib/follow.test.ts`

**接口:**

```ts
export interface StrategyMetrics {
  totalRealized: number;
  invested: number;
  roi: number | null;
  wins: number;
  settledCount: number;
  winRate: number | null;
  winRateCI: { lo: number; hi: number };
  openCount: number;
  avgHoldingDays: number | null;
  maxDrawdown: number;
  slippageCost: number;
  equityCurve: { ts: number; cum: number }[];
  byCategory: Record<string, { realized: number; settledCount: number }>;
}
export function computeStrategyMetrics(
  positions: FollowPositionRow[],
  categoryByCid: Record<string, string | null>,
): StrategyMetrics;
```

**关键点:** 净值曲线 = settled 按 `exit_ts` 升序累计 `realized_pnl`;最大回撤 = 该序列 peak-to-trough 最大跌幅;win = `realized_pnl>0`,`realized_pnl===0` 视为 push 不计分母(与 outcomeStats 一致);Wilson 用 `wilsonInterval(wins, settledCount)`。

**Step 1: 失败测试**(至少覆盖:空仓、单 settled、回撤计算、push 不计分母)。示例:

```ts
import { computeStrategyMetrics } from "./follow";
const p = (o: any) => ({
  strategy_id: 1,
  condition_id: "c",
  outcome: "Yes",
  size_usd: 500,
  entry_price: 0.5,
  smart_avg_price: 0.48,
  shares: 1000,
  status: "settled",
  entry_ts: 0,
  exit_ts: 86400,
  realized_pnl: 0,
  ...o,
});

it("净值曲线累计 + 最大回撤", () => {
  const positions = [
    p({ condition_id: "a", exit_ts: 1, realized_pnl: 100 }),
    p({ condition_id: "b", exit_ts: 2, realized_pnl: -500 }),
    p({ condition_id: "c", exit_ts: 3, realized_pnl: 200 }),
  ];
  const m = computeStrategyMetrics(positions as any, {});
  expect(m.equityCurve.map((e) => e.cum)).toEqual([100, -400, -200]);
  expect(m.maxDrawdown).toBeCloseTo(600);
  expect(m.settledCount).toBe(3);
});
```

**Step 3: 实现** `computeStrategyMetrics`(复用 `import { wilsonInterval } from "./outcomeStats"`)。
**Step 5: 提交** `git commit -m "feat: computeStrategyMetrics(净值/回撤/Wilson/滑点/按赛道)"`

---

## 阶段 P2c — 接线 + 前端

### Task 7: 把 followCycle 接入 embeddedEngine

**Files:** Modify `worker/embeddedEngine.ts`(在 `consensusLoop` 旁加 `followLoop`,复用 `getTradesWindowDeep`/`getAllSmartTags`/`fetchPriceAt`/`getMarketMeta`)· Test:扩 `worker/embeddedEngine.test.ts` 断言 followLoop 被调度(注入式,不真抓)。

- `FOLLOW_INTERVAL_MS = 5*60_000`,首跑 `setTimeout(followLoop, 45_000)`。
- `fetchPrice = (asset) => fetchPriceAt(asset, Math.floor(Date.now()/1000))`。

提交 `git commit -m "feat: followCycle 接入 5min 引擎循环"`

### Task 8: /api/follow 路由

**Files:** Create `app/api/follow/route.ts`(`export const dynamic='force-dynamic'`;读两表 + `computeStrategyMetrics`;返回 `{strategies:[{...meta, metrics, open:[], settled:[]}]}`)· Test:把整形逻辑抽到纯函数测(仿现有 route 测法)。

提交 `git commit -m "feat: /api/follow 策略+仓位+指标只读接口"`

### Task 9: /follow 页 + glossary

**Files:** Create `app/follow/page.tsx`(按已确认原型:策略 A/B 卡 + 结算净值阶梯曲线 + 已结算/持有中分区;复用 `app/ui.tsx` 的 `ds-*` 组件)· Modify `app/glossary.ts`(加「纸面跟单/跟单滑点/净值曲线/最大回撤」词条,tooltip 与 /glossary 同源)· Modify 顶部导航加 `/follow` 入口。

**验证(用 preview 工具,不靠人工):** `preview_start` → 打开 /follow → `preview_snapshot` 确认策略卡/曲线/两分区渲染 → `preview_console_logs` 无报错 → `preview_screenshot` 交付截图。

提交 `git commit -m "feat: /follow 纸面跟单看板 + glossary 词条"`

---

## 收尾

- 全量 `npx vitest run` 全绿、`npx tsc --noEmit` 0 错、`next build --webpack` 过。
- 更新 `README.md` Roadmap:勾选「共识跟单纸面模拟」。
- 经 code-reviewer 对抗审查后再考虑合回 main。

## P2d(远期,不在本计划)

策略 P&L 反标定共识阈值 / 0-100 评分权重 —— 待本计划积累真实结算数据后单独立项。
