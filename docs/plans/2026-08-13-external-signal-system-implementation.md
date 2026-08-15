# 对外信号系统 · 批次 0-3 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把策略中心 13 档买入触发变成持久化信号事实，经投递总线扇出到 TG 付费实时频道 / TG 公开延迟频道 / webhook / 多 key 分层 API。

**Architecture:** 设计已批：`docs/plans/2026-08-13-external-signal-system-design.md`（方案 B「信号台账 + 投递总线」）。信号与投递解耦：`strategy_signals` 只记不可变事实（follow 开仓/结算处接线），`runDeliveryCycle` 作为第七个 worker 循环幂等消费（claim-then-send，照抄 alerts 表模式），通道 = 适配器。多租户 = 轻量 `api_keys` 表（sha256 存储、tier 分层），不建用户体系。

**Tech Stack:** TypeScript · better-sqlite3（唯一存储，零新组件）· vitest（TDD，:memory: 库）· 复用 lib/telegram.ts / lib/signalRecord.ts(gradeRows) / lib/tgFormat.ts / lib/apiGuard.ts。

**纪律（每个任务都适用）：**

- TDD：先写失败测试 → 实现 → 全绿。跑法 `npx vitest run lib/<file>.test.ts`，收尾 `npm run test` + `npm run typecheck`。
- Node 内置模块用裸名（`crypto` 非 `node:crypto`，next.config.mjs 约定）。
- 战绩口径唯一实现：任何战绩数字必须经 `gradeRows`/`formatRecordLine`。
- 归因红线：对外披露的 entry/纸面字段绝不反向影响开仓判定与 realized_pnl。
- fail-closed：未配置通道/token → 该出口静默关闭。
- 每批次一个 commit（`feat: 对外信号批次N …`）。

---

## 批次 0 · 信号台账地基

### Task 0.1 `strategy_signals` 表 + `push_enabled` 列

- Modify: `lib/db.ts`（CREATE TABLE 块 + ALTER 块）
- Test: `lib/strategySignals.test.ts`（新）先断言表存在/列齐全/UNIQUE 生效

表结构见设计文档 §4.2（strategy_signals：UNIQUE(strategy_id, condition_id, outcome)，与 follow_positions 同粒度）。`follow_strategies` 加 `push_enabled INTEGER DEFAULT 0`（ALTER + try/catch 吞 duplicate column）。加索引 `idx_strategy_signals_emitted ON strategy_signals(emitted_at)`。

### Task 0.2 `lib/strategySignals.ts` 纯逻辑

- Create: `lib/strategySignals.ts`
- Test: `lib/strategySignals.test.ts`

```ts
export interface StrategySignalInput {
  /* 由 FollowCandidate + 开仓结果拼出 */
}
export function recordStrategySignal(db, input): number | null; // INSERT OR IGNORE；changes===0 → null
export function backfillSignalSettlement(
  db,
  positionId,
  { exitTs, exitPrice, realizedPnl },
): void;
export function strategyRecord30d(db, strategyId, nowSec): SignalRecord; // follow_positions → GradedRow[] → gradeRows
```

测试：写入幂等（同 (strategy,cid,outcome) 两次只落一行）；字段完整落库；结算回填只改目标行；strategyRecord30d 的 push（realized_pnl=0）不进分母、窗口边界、空样本。

### Task 0.3 `lib/follow.ts` 两处接线

- Modify: `lib/follow.ts`（开仓 `res.changes === 1` 处 + 结算 `upd.run` 处）
- Test: `lib/strategySignals.test.ts`（用最小 FollowCycleDeps 跑 runFollowCycle 断言联动）

开仓成功 → `recordStrategySignal`（position_id = `res.lastInsertRowid`）；结算写入后 → `backfillSignalSettlement`。均包 try/catch：台账失败只 warn，绝不影响开仓/结算主流程。老仓（无 signal 行）结算回填是 no-op。

### Task 0.4 批次收尾

`npm run test` 全绿 + `npm run typecheck` → commit `feat: 对外信号批次0 —— strategy_signals 事实台账 + follow 开仓/结算接线`。

---

## 批次 1 · TG 双频道投递

### Task 1.1 config 扩展

- Modify: `lib/config.ts` + `.env.example`
- Test: `lib/config.test.ts`（若无则在 strategySignals.test 同批断言）

新增 `TELEGRAM_SIGNAL_CHANNEL_ID`（付费频道，空=关）与 `SIGNAL_PUBLIC_DELAY_MIN`（默认 30，NaN/负数回默认）。公开延迟通道复用既有 `TELEGRAM_CHANNEL_ID`。

### Task 1.2 `signal_deliveries` 表

- Modify: `lib/db.ts`

`PRIMARY KEY (signal_id, event, channel)`，status `'sent' | 'failed_permanent' | 'skipped_stale'`。

### Task 1.3 `lib/signalPush.ts` 消息格式化（纯函数）

- Create: `lib/signalPush.ts`
- Test: `lib/signalPush.test.ts`

`formatStrategyEntryTg(rows, opts)`（同市场×方向多档合并为一条，列出全部命中档位；含策略名/标题深链/方向价位/聪明钱成本/追价/该档 `formatRecordLine` 战绩行/分类/免责尾行）与 `formatStrategySettleTg(row, opts)`（认账：entry→exit、模拟盈亏、won）。全部走 `esc/urlSeg/cents/usd`。测试：HTML 转义、免责必带、战绩行缺样本时省略、多档合并列出全部名字。

### Task 1.4 `lib/signalDelivery.ts` 投递循环核心

- Create: `lib/signalDelivery.ts`
- Test: `lib/signalDelivery.test.ts`

```ts
export interface DeliveryChannel {
  key: string; // 'tg_paid' | 'tg_public'
  minEmitAgeSec: number; // tg_public = delayMin*60；tg_paid = 0
  send: (html: string) => Promise<void>;
}
export interface DeliveryDeps {
  db;
  channels: DeliveryChannel[];
  nowSec?: number;
  checkHealth?: () => { ok: boolean };
  strategyNames?: Map<number, string>; // 测试注入；生产从 follow_strategies 读
}
export function runDeliveryCycle(
  deps,
): Promise<{ sent; skippedStale; failedPermanent }>;
```

语义（每条都有测试）：

1. `checkHealth().ok === false` → 整轮跳过（宁静默不误导）。
2. entry 扫描：`strategy_signals JOIN follow_strategies(push_enabled=1)`，每通道找无投递记录的行；`emitted_at > now - minEmitAgeSec` 的行跳过（还没到点，下轮再看）。
3. 新鲜度：`now - emitted_at > ENTRY_MAX_AGE_SEC(6h)+minEmitAgeSec` → 落 `skipped_stale`（不推旧信号）。settle 事件同理上限 7d。
4. 同市场×方向多档合并成一条消息；claim = 组内每行 `INSERT OR IGNORE`，全部 changes===1 才发；部分被抢 → 只发未被抢的行重组的消息。
5. transient 发送失败 → DELETE 本组 claim（下轮重试）；permanent（`isPermanentSendError`）→ UPDATE status='failed_permanent' 保留。
6. 每通道每轮上限 `MAX_SENDS_PER_CYCLE=6`，超额顺延下轮（不折叠不丢失）。
7. settle 扫描：`settled=1` 且该通道无 settle 投递 → 认账推送（won/盈亏）。
8. 组间 `SEND_GAP_MS` 节流（注入 sleep 便于测试）。

### Task 1.5 engine 第七循环 + health 注册

- Modify: `worker/embeddedEngine.ts`（deliveryLoop，间隔 30s，首跑 45s）
- Modify: `lib/health.ts`（`delivery: 5 * 60`）
- Modify: `lib/heartbeat.ts` 不动（beat 直接可用）

fail-closed：两个通道都未配置 → 循环不启动（log 一行）。`beat(db, "delivery")` 每轮成功后打点。

### Task 1.6 批次收尾

全量测试 + typecheck → commit `feat: 对外信号批次1 —— TG 付费实时/公开延迟双频道投递循环`。

---

## 批次 2 · API v2 + 多 key

### Task 2.1 `api_keys` 表 + `lib/apiKeys.ts`

- Modify: `lib/db.ts`；Create: `lib/apiKeys.ts`；Test: `lib/apiKeys.test.ts`

```ts
export function issueApiKey(db, { label, tier }): { id; key }; // 明文仅此一次，"wlk_"+base64url(24B)
export function verifyApiKey(db, token): { id; label; tier } | null; // sha256 查表 + revoked 过滤 + last_used_at
export function revokeApiKey(db, id): boolean;
export function listApiKeys(db): ApiKeyRow[]; // 无明文无 hash
```

测试：签发/校验往返、吊销即失效、错 token null、tier 解析、last_used_at 更新。

### Task 2.2 `lib/strategyFeed.ts` strategies 段

- Create: `lib/strategyFeed.ts`；Test: `lib/strategyFeed.test.ts`

`buildStrategyFeed(db, {nowSec}) → { active, settled, recordByStrategy }`：active = push_enabled 档的未结算台账行（含策略名/market/signal/paper 字段，category 经 event_category join）；settled = 近 3 天；recordByStrategy = 各档 `strategyRecord30d`。时间参数化 → 延迟视图 = 传 `nowSec - delaySec`。

### Task 2.3 `/api/signals` v2

- Modify: `app/api/signals/route.ts`；Test: `lib/feedAuth.test.ts`（鉴权逻辑抽到 `lib/feedAuth.ts`）

鉴权：env `SIGNAL_FEED_TOKEN`（兼容，等价 realtime）∪ `api_keys`。两者都未配置 → 403 fail-closed 不变。tier='delayed' → 整个 feed 用 `nowSec' = now - delaySec` 构建（时移语义：看到 30 分钟前的世界），响应加 `delayedMin`；realtime 加 `strategies` 段。既有字段逐字节不变（向后兼容测试）。

### Task 2.4 admin 路由 + CLI + 契约文档

- Create: `app/api/admin/keys/route.ts`（POST 签发 / GET 列表 / DELETE 吊销；`checkWriteAccess` + `guardExpensive`）
- Create: `scripts/issue-key.ts`
- Modify: `docs/signals-api.md`（v2 增量段）

### Task 2.5 批次收尾

commit `feat: 对外信号批次2 —— api_keys 多租户 + /api/signals v2(strategies 段 + tier 延迟视图)`。

---

## 批次 3 · webhook + 存证 + 公开战绩页

### Task 3.1 `webhook_endpoints` 表 + `lib/webhookDelivery.ts`

- Modify: `lib/db.ts`；Create: `lib/webhookDelivery.ts`；Test: `lib/webhookDelivery.test.ts`

```ts
export function signPayload(secret, body): string; // hex hmac-sha256
export async function deliverWebhook(
  endpoint,
  event,
  { fetchFn },
): Promise<"ok" | "transient" | "permanent">;
export function buildSignalEvent(row, strategyName, record): SignalEventV1; // 设计 §4.1 信封，zod schema
```

5s 超时；2xx=ok；网络/5xx/超时=transient；4xx=permanent。连续失败 `WEBHOOK_DISABLE_AFTER=10` → `active=0`（由投递侧计数）。测试用注入 fetchFn。

### Task 3.2 webhook 通道接入投递循环

- Modify: `lib/signalDelivery.ts`（DeliveryChannel 泛化出 `sendEvent?`——webhook 通道发结构化事件而非 html）与 `worker/embeddedEngine.ts`（每轮从 webhook_endpoints 读活跃端点构造通道）
- Test: `lib/signalDelivery.test.ts` 增补（熔断计数、禁用后不再投递、成功清零）

### Task 3.3 `lib/signalDigest.ts` 每日存证

- Create: `lib/signalDigest.ts`；Test: `lib/signalDigest.test.ts`

`maybeDailySignalDigest(db, send, nowSec)`：day-gate（config `signal_digest_last_day`，claim-first 同 selfcheck）；昨日已投递 entry 信号按 id 升序链式 `sha256(prev|id|strategy|cid|outcome|emitted_at|entry_price)`；`signal_digest_prev` 滚动；无信号日跳过不消耗 day。挂在 deliveryLoop 尾部。测试：确定性、跨日、空日、链推进。

### Task 3.4 admin webhooks 路由

- Create: `app/api/admin/webhooks/route.ts`（POST 登记 / GET 列表 / DELETE 停用；zod 校验 url/secret 长度）

### Task 3.5 `/api/record` + `/record` 公开页

- Create: `app/api/record/route.ts`（无鉴权 + `guardExpensive({perIp:60, global:300})` + 60s 缓存；内容 = buildStrategyFeed 的 recordByStrategy + settled 明细 + 口径声明字段）
- Create: `app/record/page.tsx`（ds-\* 组件；每档卡片：战绩行 + implied vs wins 条 + 近期结算表；页头三声明 + 免责）

### Task 3.6 批次收尾

全量测试 + typecheck + `npx tsx scripts/dry-run.ts` 冒烟 → commit `feat: 对外信号批次3 —— webhook(HMAC+熔断) + 每日存证 digest + /record 公开战绩页`。
