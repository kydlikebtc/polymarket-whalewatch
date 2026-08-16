# X 自动播报 Bot 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** worker 信号管线加 X（Twitter）自动播报：大单/共识实时英文帖、赛前聚合帖、周报成绩单图卡，$15/月预算本地熔断。

**Architecture:** `alerts` 表即发帖队列——大单/共识告警已带完整 payload 入库（unique (type, dedup_key)），X 侧做**纯消费者**（独立 60s loop，claim-then-post，镜像 alertEngine 的 Telegram 语义），对 `runAlertCycle`/`runConsensusCycle` **零改动**，X 故障与 TG 主链路物理隔离。赛前聚合与周报是同 loop 上的节流 tick。设计文档：`docs/plans/2026-08-16-x-broadcast-bot-design.md`（注：设计说"alertEngine 后非阻塞调 sink"，实现细化为 DB 队列消费——同样满足"TG 成功后、非阻塞"，耦合更低）。

**Tech Stack:** TypeScript + better-sqlite3 + vitest（既有）；新依赖 `twitter-api-v2`；周报图卡用 Next 内置 `ImageResponse`（next/og）。

**Key existing facts（执行者无需再考古）：**

- `alerts` 表：`(id, type, dedup_key, payload TEXT, created_at)`，type ∈ `large|smart|consensus`（follow 等不入此表）；large/smart payload = `{...Trade, marketCtx?, params}`；consensus payload = `{conditionId, title, outcome, walletCount, totalNetUsd, ..., params}`，dedup_key = `consensus:{cid}:{outcome}:{n}`。
- `Trade`（lib/types.ts）：`side BUY|SELL, size, price, title, outcome, conditionId, timestamp, proxyWallet...`；美元额 = `notionalUsd(t)`（lib/trades.ts）。
- `MarketMeta`（lib/gamma.ts）：`volume24hr, liquidity, endDate(ISO), closed, outcomes, outcomePrices...`；`getMarketMeta(db, cids)` 批量缓存；`tradeMarketContext(usd, meta, nowSec)` 给 `hoursToEnd/pct24h` 等。
- config 模式（lib/config.ts）：zod `.default("")` + warn-and-default 数字解析 + `parseBoolEnv`；`telegramEnabled = 两凭据齐` 同款开关语义。
- engine 模式（worker/embeddedEngine.ts）：`setTimeout` 自循环 + try/catch 全包 + `beat(db, loop)` 心跳 + fire-and-forget 日 gated 任务。
- 每档策略指标：`computeStrategyMetrics`（lib/follow.ts:1013）；19 档种子名在 lib/db.ts ~440 起（`["巨鲸", {...}]` 对）。
- Telegram 错误分类参照：`isPermanentSendError`（lib/telegram.ts）——4xx（除 429）永久、其余瞬态。

**帖文与预算规则（设计定稿）：**

- 无链接帖 $0.015、带链接帖 $0.20（只有周报带链接）；月预算 env `X_MONTHLY_BUDGET_USD` 默认 15，**本地台账 fail-closed**。
- 大单阈值 env `X_MIN_TRADE_USD` 默认 50000；共识/分歧全发；赛前 ≤3/天；周报周一 1 条。
- 每日帖数上限：whale 20、pregame 3（常量）；共识不设（天然稀有）。
- 新鲜度：只发 created_at ≥ now−1800s 的告警（宕机重启不补发陈旧大单）。
- 帖文纯英文、除周报外正文严禁 URL、≤280 字符（超长截断 title 加 `…`）。

---

### Task 1: config —— X 凭据与预算 env

**Files:** Modify `lib/config.ts` / Test `lib/config.test.ts`

1. 失败测试：`parseConfig` 新增字段——`X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRET` 默认 `""`；`xEnabled` 仅当四者全非空；`xMonthlyBudgetUsd` 默认 15（NaN/负数 → warn+默认，沿用 parsePollIntervalMs 风格）；`xMinTradeUsd` 默认 50000（同上）。
2. `npx vitest run lib/config.test.ts` → FAIL。
3. 实现：Env schema 加 6 个键 + `parseUsdEnv(raw, def, label)` 辅助（>0 有限数，否则 warn+default）。
4. 测试过 → `git commit -m "feat: X 播报 config —— 四凭据开关 + 预算/阈值 env（warn-and-default）"`

### Task 2: db —— x_posts 台账表

**Files:** Modify `lib/db.ts` / Test `lib/db.test.ts`

1. 失败测试：openDb 后存在 `x_posts` 表及 unique index `(kind, dedup_key)`。
2. 实现（进既有 CREATE TABLE 块）：

```sql
CREATE TABLE IF NOT EXISTS x_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,            -- 'whale'|'consensus'|'pregame'|'weekly'
  dedup_key TEXT NOT NULL,       -- whale/consensus: alert dedup_key；pregame: cid:utcDay；weekly: utcWeekStart
  alert_id INTEGER,
  text TEXT NOT NULL,
  has_link INTEGER NOT NULL DEFAULT 0,
  est_cost_usd REAL NOT NULL DEFAULT 0,
  x_post_id TEXT,
  status TEXT NOT NULL,          -- 'claimed'|'posted'|'failed'|'skipped'
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_x_posts_kind_dedup ON x_posts(kind, dedup_key);
CREATE INDEX IF NOT EXISTS idx_x_posts_created_at ON x_posts(created_at);
```

3. commit `feat: x_posts 台账表（幂等 claim + 成本记账）`

### Task 3: xComposer —— 四类英文帖纯函数

**Files:** Create `lib/xComposer.ts` / Test `lib/xComposer.test.ts`

纯函数、无 I/O。输入是显式窄接口（不是整个 Trade/payload——由 broadcast 层拆）：

```ts
export interface WhalePostInput {
  usd: number;
  side: "BUY" | "SELL";
  outcome: string;
  title: string;
  priceCents: number;
  pct24h?: number | null;
  liquidityUsd?: number | null;
  hoursToEnd?: number | null;
}
export function composeWhalePost(i: WhalePostInput): string;
// "🐳 $184K YES on \"Chiefs win Super Bowl LX?\" @ 67¢\n12% of 24h vol · liquidity $229K · settles in 5h"
// SELL → "🐳 $184K SOLD YES on ..."；缺失的 ctx 段整段省略；≥$250k 用 🚨 前缀。
export interface ConsensusPostInput {
  walletCount: number;
  outcome: string;
  title: string;
  totalUsd: number;
}
export function composeConsensusPost(i: ConsensusPostInput): string;
// "🔥 CONSENSUS: 3 top-PnL wallets bought the SAME side of \"...\" · combined $92K on Yes"
export interface PregamePostInput {
  title: string;
  hoursToEnd: number;
  alertCount: number;
  totalUsd: number;
  topSide?: string | null;
  yesPriceCents?: number | null;
}
export function composePregamePost(i: PregamePostInput): string;
// "⏰ Settles in 3h: \"...\" · smart money fired 7 alerts / $310K in 24h · leaning Yes @ 61¢"
export interface WeeklyPostInput {
  weekLabel: string;
  settled: number;
  winRatePct: number | null;
  pnlUsd: number;
  bestName: string;
  bestRoiPct: number;
  url: string;
}
export function composeWeeklyPost(i: WeeklyPostInput): string; // 唯一可含 URL
export function usdCompact(n: number): string; // 184000→"$184K", 1_250_000→"$1.25M", 900→"$900"
export const STRATEGY_EN: Record<string, string>; // 19 档中文名→EN（读 lib/db.ts ~440 起种子名逐一映射，如 巨鲸→"Whale Follow"、反巨鲸→"Inverse Whale"；缺失回退原名）
```

不变量测试：全部 ≤280 字符（title 300 字时截断）；除 weekly 外输出不含 `http`；数字格式快照。commit `feat: xComposer —— 四类英文帖模板（280 限长/无链接不变量）`

### Task 4: xQuota —— 预算台账与配额判定

**Files:** Create `lib/xQuota.ts` / Test `lib/xQuota.test.ts`

```ts
export const COST_TEXT_USD = 0.015;
export const COST_LINK_USD = 0.2;
export const DAILY_CAP: Record<string, number> = { whale: 20, pregame: 3 }; // 无键=不限
export function costOf(hasLink: boolean): number;
export function spentUsdInUtcMonth(db: DB, nowSec: number): number; // SUM(est_cost_usd) WHERE status IN ('claimed','posted') AND created_at 在本 UTC 月 —— claimed 计入=向安全侧
export function postedTodayCount(db: DB, kind: string, nowSec: number): number; // 同口径按 UTC 日
export function quotaDecision(
  db: DB,
  i: { kind: string; hasLink: boolean; budgetUsd: number; nowSec: number },
): { ok: true } | { ok: false; reason: string };
```

fail-closed：月花费+本帖成本 > budget → 拒；日 cap 到顶 → 拒。测试：月界（UTC 月末 23:59 vs 次月 00:00）、预算恰好用尽、claimed 行计入、链接帖成本。commit `feat: xQuota —— $15/月本地熔断 + 日 cap（fail-closed）`

### Task 5: xPublisher —— twitter-api-v2 客户端与错误分类

**Files:** Create `lib/xPublisher.ts` / Test `lib/xPublisher.test.ts`；`npm install twitter-api-v2`

```ts
export interface XClient {
  postText(text: string): Promise<string>;
  postWithPng(text: string, png: Buffer): Promise<string>;
} // 返回 x post id
export function createXClient(c: {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}): XClient;
export function isPermanentXError(e: unknown): boolean; // ApiResponseError 4xx 且 ≠429 → true；429/5xx/网络 → false（对齐 isPermanentSendError 语义）
```

`createXClient` 内 `new TwitterApi({appKey,appSecret,accessToken,accessSecret})`；`postText` → `client.v2.tweet(text)`；`postWithPng` → 先传媒体再 `v2.tweet(text, {media:{media_ids:[id]}})`——**装好包后先查该版本 README 的 media 上传 API**（新版有 `client.v2.uploadMedia(buf, { media_type })`，旧版走 `client.v1.uploadMedia`；封装在此一处，坏了只改这里）。单测只测 `isPermanentXError`（构造 `{code: 403}` / `{code: 429}` / `TypeError` 形状）与工厂不抛；真实发帖不进 CI。commit `feat: xPublisher —— XClient 封装 + 永久/瞬态错误分类`

### Task 6: xBroadcast —— alerts 队列消费循环（核心）

**Files:** Create `lib/xBroadcast.ts` / Test `lib/xBroadcast.test.ts`

```ts
export const X_POST_MAX_AGE_SEC = 1800;
export interface XBroadcastDeps {
  db: DB;
  client: XClient;
  budgetUsd: number;
  minTradeUsd: number;
  nowSec?: number;
}
export async function runXBroadcastCycle(d: XBroadcastDeps): Promise<number>; // 返回成功发帖数
```

流程（每步与 alertEngine 注释风格一致，写清 WHY）：

1. `SELECT a.id, a.type, a.dedup_key, a.payload FROM alerts a LEFT JOIN x_posts x ON x.alert_id = a.id WHERE x.id IS NULL AND a.type IN ('large','smart','consensus') AND a.created_at >= ?`（now−1800，走 idx_alerts_created_at，窗口小扫描小）。
2. 容错解析 payload（try/catch，坏行记 `status='skipped'` 防复扫）；large/smart 取 `notionalUsd(trade)` < minTradeUsd → `skipped`；组装 composer 输入（marketCtx 有则带）。
3. 排序：consensus 优先，再按 usd 降序。
4. 逐条：`quotaDecision` 拒 → INSERT `status='skipped'`（reason 进 text 前缀？不——text 存原帖文，reason 记日志）；过 → **claim**（`INSERT OR IGNORE status='claimed'` + est_cost，changes=0 → 他进程持有，跳过）→ `client.postText` → 成功 `UPDATE status='posted', x_post_id`；`isPermanentXError` → `UPDATE status='failed'`（保 claim，毒帖不能堵队列）；瞬态 → `DELETE` claim 行 + `throw`（本轮终止，下轮重试——at-least-once，镜像 TG claim 回滚）。
5. 日志：发帖数/跳过数/预算余额（调试者视角）。

测试（fake XClient 捕获调用）：新告警发帖并记账；同告警二轮不重发；minTradeUsd 过滤；预算耗尽全 skipped；瞬态错误回滚 claim 且中断、下轮重试成功；永久错误标 failed 不重试；1800s 外不发；坏 payload 标 skipped。commit `feat: xBroadcast —— alerts 队列消费（claim-then-post/预算熔断/毒帖隔离）`

### Task 7: xPregame —— 赛前聚合 tick

**Files:** Create `lib/xPregame.ts` / Test `lib/xPregame.test.ts`

```ts
export const PREGAME_MIN_H = 1;
export const PREGAME_MAX_H = 6;
export const PREGAME_LOOKBACK_SEC = 86400;
export async function runPregameCycle(d: {
  db: DB;
  client: XClient;
  getMeta: (cids: string[]) => Promise<Record<string, MarketMeta>>;
  budgetUsd: number;
  nowSec?: number;
}): Promise<number>;
```

1. SQL：近 24h alerts（三类型）按 `json_extract(payload,'$.conditionId')` 分组 → cid/title/count/sumUsd（large/smart 的 usd 用 `json_extract` size*price 不可行——payload 存的是 Trade 原样，故 SELECT payload 到 JS 聚合，量小无所谓）。
2. `getMeta(cids)` → `!closed && endDate` 在 [now+1h, now+6h] 窗口；`outcomePrices[0]` 作 yesPriceCents；topSide = 该市场告警里 BUY 侧金额多数的 outcome（JS 聚合）。
3. 排序 (count, sumUsd) 降序取前 3；dedup_key = `${cid}:${utcDay(nowSec)}`，claim→compose→post→update，配额 kind='pregame'（≤3/天已在 quota）。错误语义同 Task 6。
   测试：窗口内外、closed 排除、同日 dedup、topSide 聚合、配额拒绝。commit `feat: xPregame —— 结算前 1-6h 聪明钱聚合帖（日 dedup ≤3 条）`

### Task 8: xWeekly 数据 + OG 图卡路由

**Files:** Create `lib/xWeekly.ts`, `app/api/og/weekly/route.tsx` / Test `lib/xWeekly.test.ts`

```ts
export interface WeeklyReport {
  weekLabel: string;
  settled: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  pnlUsd: number;
  rows: {
    name: string;
    nameEn: string;
    settled: number;
    pnlUsd: number;
    roiPct: number | null;
  }[];
}
export function buildWeeklyReport(db: DB, nowSec: number): WeeklyReport; // follow_positions status='settled' AND exit_ts ∈ 近7天，JOIN follow_strategies 分组；rows 按 pnl 降序取前 5；nameEn 用 STRATEGY_EN
```

route.tsx：`runtime="nodejs"`, `dynamic="force-dynamic"`；`new ImageResponse(<jsx>, {width:1200, height:675})`——深色底、站名标头、fund 四指标大数、前 5 档表格（EN 名 + PnL + ROI）、footer `whalewatch.wired.fund · paper trading, real data`。样式内联 flex（satori 约束：无 grid）。数据全部来自 `buildWeeklyReport`（route 零逻辑，才可测）。测试只测 buildWeeklyReport（内存 db 造 settled 仓位）。本地验证：`npm run dev` + `curl -o /tmp/w.png localhost:3000/api/og/weekly` 肉眼看图。commit `feat: 周报成绩单 —— buildWeeklyReport + /api/og/weekly ImageResponse 图卡`

### Task 9: xWeekly 发帖 tick

**Files:** Modify `lib/xWeekly.ts` / Test `lib/xWeekly.test.ts`

```ts
export async function maybeWeeklyPost(d: {
  db: DB;
  client: XClient;
  ogOrigin: string;
  publicUrl: string;
  budgetUsd: number;
  nowSec?: number;
  fetchImpl?: typeof fetch;
}): Promise<boolean>;
```

门：UTC 周一且 hour ≥ 13；dedup_key = `weekly:${utcWeekStart}`（x_posts kind='weekly' 已存在 → false）。**先 fetch PNG**（`${ogOrigin}/api/og/weekly`，失败 → log + return false，不 claim——下一 tick 自动重试直到周一结束）；再 claim（has_link=1, est_cost=0.20, quota 判定）→ `composeWeeklyPost`（url=`${publicUrl}/follow?utm_source=x`）→ `postWithPng`。错误语义同 Task 6。测试：非周一 false、13 点前 false、同周 dedup、fetch 失败不 claim、成功记 0.20。commit `feat: 周报周一自动发帖（图卡+唯一带链接帖·fetch 失败零副作用重试）`

### Task 10: 引擎接线 + 心跳

**Files:** Modify `worker/embeddedEngine.ts`, `lib/config.ts`（若 ogOrigin 需 env：`X_OG_ORIGIN` 默认 `http://127.0.0.1:3000`）

`startAlertEngine` 末尾（healthPing 前）加：

```ts
if (cfg.xEnabled) {
  const xClient = createXClient({ apiKey: cfg.xApiKey, ... });
  const X_LOOP_MS = 60_000; const PREGAME_GAP_MS = 10 * 60_000;
  let lastPregame = 0;
  async function xLoop() {
    try {
      await runXBroadcastCycle({ db, client: xClient, budgetUsd: cfg.xMonthlyBudgetUsd, minTradeUsd: cfg.xMinTradeUsd });
      if (Date.now() - lastPregame >= PREGAME_GAP_MS) {
        lastPregame = Date.now();
        await runPregameCycle({ db, client: xClient, getMeta: (c) => getMarketMeta(db, c), budgetUsd: cfg.xMonthlyBudgetUsd });
      }
      await maybeWeeklyPost({ db, client: xClient, ogOrigin: cfg.xOgOrigin, publicUrl: cfg.publicUrl, budgetUsd: cfg.xMonthlyBudgetUsd });
      beat(db, "x_broadcast");
    } catch (e) { console.error("[engine] x broadcast cycle error", e); }
    setTimeout(xLoop, X_LOOP_MS);
  }
  setTimeout(xLoop, 45_000); // 错峰：consensus 30s / backfill 90s 之间
  console.log("[engine] X broadcast enabled (60s cadence, budget $" + cfg.xMonthlyBudgetUsd + "/mo)");
}
```

先查 `lib/health.ts` 的 evaluateHealth 对未知 loop 名的容忍度——若 loops 清单是白名单式，把 `x_broadcast` 注册进去（含合理 stale 阈值 5min）；若自适应则免。commit `feat: 引擎接线 X 播报 loop（60s·xEnabled 门·心跳纳管）`

### Task 11: 收尾 —— README/env 样例 + 全量验证

1. README 新增「𝕏 Auto-broadcast」小节（凭据申请步骤=设计文档 §2、env 清单、预算语义）；`.env.example`（若存在）加 6 变量。
2. `npx vitest run` 全绿（基线 1017+ 新增）；`npx tsc --noEmit` 干净。
3. commit `docs: X 播报 README/env 说明`；不推送（用户 push 前有 Zed review hook）。

**执行纪律：** 每 task 内先测后码；task 间不并行改同文件；全程不碰 `runAlertCycle`/`runConsensusCycle`/`runFollowCycle` 一行。
