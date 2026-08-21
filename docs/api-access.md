# WhaleWatch 信号 API — 接入文档

> 面向持有 API key 的订阅方。key 由运营者签发，明文只显示一次（库中仅存
> sha256），丢失只能重新签发。设计取舍与口径修订史见内部契约
> `docs/signals-api.md`，本文只讲怎么用。

**基址**：`https://whalewatch.wired.fund`

| 端点                        | 方法   | 鉴权          | 缓存 | 用途                                       |
| --------------------------- | ------ | ------------- | ---- | ------------------------------------------ |
| `/api/signals`              | `GET`  | API key       | 30s  | 主 feed：信号（事件）+ 视图                |
| `/api/signals/market/{cid}` | `GET`  | API key       | 30s  | 单市场深度卡（`realtime` + `market` 范围） |
| `/api/record`               | `GET`  | 无（公开）    | 60s  | 已公开发布信号的战绩与存证链               |
| `/api/health`               | `GET`  | 无（公开）    | 无   | 引擎存活探针（200 / 503）                  |
| webhook（你的端点）         | `POST` | HMAC 签名验证 | —    | 事件推送（`realtime` tier 专属）           |

两条恒定承诺：

- **零上游调用**：全部字段来自已持久化状态，你的请求不会失败于上游抖动。
  ⚠️ **`/api/signals/market/{cid}` 是唯一例外**——它按需向 Polymarket 取数，
  因此会背压（`429`）、也会受上游波动影响。详见 §14，接入前请读完那一节。
- **字段只增不改**：既有字段名称与语义不变；解析时请忽略未知字段。

---

## 1. 快速开始

```bash
curl -s -H "x-feed-token: $WHALEWATCH_KEY" \
  "https://whalewatch.wired.fund/api/signals?windowHours=24" | jq
```

```javascript
const KEY = process.env.WHALEWATCH_KEY;

async function pull() {
  const res = await fetch(
    "https://whalewatch.wired.fund/api/signals?windowHours=24",
    { headers: { "x-feed-token": KEY }, signal: AbortSignal.timeout(15000) },
  );
  if (res.status === 401) throw new Error("key 无效或已被吊销");
  if (res.status === 403) throw new Error("服务端未开放 feed，联系运营者");
  const feed = await res.json();
  if (!feed.healthy) return null; // 故障 ≠ 没信号，见 §11
  return feed;
}

setInterval(() => void pull(), 60_000); // 推荐节奏：1 次/分钟
```

---

## 2. 鉴权

两种写法等价：

```http
x-feed-token: <YOUR_API_KEY>
```

```http
authorization: Bearer <YOUR_API_KEY>
```

key 形如 `wlk_` + 32 字符 base64url。

| 状态                   | 含义                   | 处理                       |
| ---------------------- | ---------------------- | -------------------------- |
| `401`                  | key 缺失、错误或已吊销 | 核对 header；联系运营者    |
| `403`                  | 服务端尚未开放 feed    | 联系运营者                 |
| `200` + 响应含 `error` | 服务端内部异常         | 见 §11，**不要当成没信号** |

`401`/`403` 的响应体是 `{ "error": "<说明>" }`，没有 feed 结构。
`/api/signals` 不做请求数限流（30s 缓存即保护）；`/api/record` 限流见 §13。

---

## 3. Tier：`realtime` 与 `delayed`

| tier       | 语义                                                         |
| ---------- | ------------------------------------------------------------ |
| `realtime` | 实时；可挂 webhook 推送（§10）                               |
| `delayed`  | 整个 feed 以 `now − delayedMin` 构建（当前部署延迟 30 分钟） |

延迟层**不删减字段**，只是时间平移：晚于基准时刻的事件不可见、晚于基准
时刻的结算仍显示为进行中；`updatedAt` 即数据基准时刻（已时移），展示
「截至 HH:MM」以它为准。唯一例外：`healthy`/`staleLoops` 永远按真实时间
评估。

---

## 4. 订阅范围与当前开放状态

签发 key 时可限定订阅范围，**过滤在服务端执行**：

| 类型        | 对应的信号       | 出现在                                            |
| ----------- | ---------------- | ------------------------------------------------- |
| `strategy`  | ② 策略事件       | `strategies` 段 + webhook                         |
| `large`     | ① 大额成交事件   | `bus[]` + webhook（勾选）                         |
| `consensus` | ① 聪明钱共识事件 | `bus[]` + webhook（勾选）                         |
| `discovery` | ① 钱包发现事件   | `bus[]` + webhook（勾选）                         |
| `market`    | —（非事件）      | `/api/signals/market/{cid}`，仅 `realtime`（§14） |

- 未限定 = 不限，拿全部类型。
- key 不含 `strategy` 时 `strategies` 段是空结构（形状不变，不必判空）。
- 视图字段（`active[]`/`settled[]`/`record30d`，§9）**不受范围约束**，任何
  有效 key 都能拿到。

**当前开放状态**（本页渲染时按运营开关实时生成）：

```status
（此表由 /api-docs 渲染时按当前开关实时生成；直接阅读源文件时此处为空。）
```

标「未开启」的事件类型不会产出任何数据（`bus[]` 中无该类型条目）；
`strategies` 只含已放开推送的档位——**遍历请以 `recordByStrategy` 的键为
准**，不要写死档数。

---

## 5. 请求参数

`GET /api/signals`

| 参数          | 类型   | 取值                     | 默认 | 说明                 |
| ------------- | ------ | ------------------------ | ---- | -------------------- |
| `windowHours` | number | `6` / `12` / `24` / `48` | `24` | 非法值静默回落默认值 |

作用于 `active[]` 与 `bus[]`；不影响 `strategies.active`（固定 48h）、
`settled`（固定 3 天）、`record30d`（固定 30 天）。

---

## 6. 核心概念：信号（事件） vs 视图

**判据：触发后发出的才是信号。** 事件不可变、逐条、有稳定 id——推送与
计数都以它为准。视图是事件的折叠/汇总，回答「现在该看什么」，只用于渲染。

|      | 信号（事件）            | 视图                 |
| ---- | ----------------------- | -------------------- |
| 性质 | 不可变，逐条，有稳定 id | 折叠快照，随事件更新 |
| 用途 | 触发、推送、计数        | 渲染、看战绩         |
| 管线 | TG / webhook / API      | 无（仅拉取展示）     |

响应顶层字段归类：

| 字段           | 归类                                                                | 内容                             | 详见 |
| -------------- | ------------------------------------------------------------------- | -------------------------------- | ---- |
| `bus[]`        | 信号 · ① 原始事件                                                   | 大额成交 / 聪明钱共识 / 钱包发现 | §7   |
| `strategies`   | 信号 · ② 策略事件（`active`/`settled`）+ 视图（`recordByStrategy`） | 19 档买入/结算                   | §8   |
| `active[]`     | 视图                                                                | ① 大额/共识事件按市场×方向折叠   | §9.1 |
| `settled[]`    | 视图                                                                | 已结算折叠条目（与 active 同构） | §9.2 |
| `record30d`    | 视图                                                                | ① 已结算事件的 30 天战绩汇总     | §9.3 |
| `updatedAt` 等 | 元信息                                                              | 见 §6.1                          | —    |

**推荐消费模式：事件做触发，视图做渲染。** webhook 收到事件后，拿
`conditionId` + `outcome` 去视图取当前折叠状态展示。三条纪律：

- 幂等去重键是 `(id, event)`，`event` 值域 `entry` / `settle` / `bus`；
- 同一共识组每次**升级**（2 人 → 3 人）是一条新事件——统计共识个数请按
  `(conditionId, outcome)` 归并，或直接用视图（已折叠）；
- 不要跨形态相加：同一笔市场行为会同时出现在事件与视图里。

### 6.1 元信息与通用格式

```jsonc
{
  "updatedAt": 1755412800, // 数据基准时刻（延迟层已时移）
  "windowHours": 24,
  "heavyMinUsd": 50000, // 视图 heavy 门槛（常量）
  "delayedMin": 0, // 0 = realtime；30 = 延迟 30 分钟
  "healthy": true, // 引擎健康位（永远按真实时间）
  "staleLoops": [], // 停跳循环名；healthy=false 时非空
}
```

| 约定      | 说明                                                               |
| --------- | ------------------------------------------------------------------ |
| 时间戳    | unix **秒**（UTC），不是毫秒                                       |
| 价格      | `0`–`1` 小数 = 隐含概率 = 每份合约 USDC 价                         |
| 金额      | USD 数值                                                           |
| `null`    | 不适用或未知；字段本身恒在（含 §11 失败响应）                      |
| ID        | `conditionId` = `0x…` 市场 ID；`asset` = CLOB token id（十进制串） |
| 数组/排序 | 空为 `[]`；各列表新在前                                            |

三个时刻，务必分清：

| 字段          | 含义                                   |
| ------------- | -------------------------------------- |
| `formationTs` | 信号在客观世界**成立**的时刻           |
| `emittedAt`   | 我们检测到并**发布**的时刻（存证锚点） |
| `updatedAt`   | 本次响应的数据基准时刻                 |

`emittedAt − formationTs` = 检测延迟，公开它让你自己判断来不来得及跟。

---

## 7. 信号 · ① 原始事件（`bus[]`）

全站原始事件的不可变台账。窗口 = `windowHours`，按 `emittedAt` 倒序，
最多 200 条。

```typescript
interface BusSignal {
  id: number; // 幂等键的一半（配合 event="bus"）
  sourceType: "large" | "consensus" | "discovery";
  dedupKey: string;

  // ——— 市场身份（discovery 无市场，一律 null）———
  conditionId: string | null;
  title: string | null;
  slug: string | null; // 单市场页；eventSlug 只能落到事件页
  eventSlug: string | null;
  category: string | null; // 如 "Sports"
  subcategory: string | null; // 如 "NBA"；无/未知 = null

  // ——— 方向 ———
  outcome: string | null; // 如 "Yes"
  outcomeIndex: number | null;
  asset: string | null; // CLOB token id

  // ——— 金额（跨类型同名同义）———
  netUsd: number | null; // large=名义额，consensus=总净买
  avgPrice: number | null; // 成本基准：large=成交价，consensus=组级 USD 加权均价
  walletCount: number | null; // large 恒 1（一笔成交=一个钱包）
  // ——— 谁买的（与 walletCount 同源，数字与列表不打架）———
  wallets: { wallet: string; netUsd: number; avgPrice: number }[] | null;

  payload: Record<string, unknown>; // 原始载荷，形状随 sourceType，见下
  emittedAt: number;
}
```

**这些顶层字段与 `active[]` 的 `Signal`（§9）同名同义** —— 同一套解析器可以
同时吃 `bus[]` 和 `active[]`，不必先 `switch (sourceType)` 再决定读哪个键。

`wallets` 的三种取值，按类型：

| `sourceType` | `wallets`                                                   |
| ------------ | ----------------------------------------------------------- |
| `large`      | 单元素——一笔成交就是一个钱包，金额/价即该笔的名义额与成交价 |
| `consensus`  | 全量参与钱包，**按净买降序**（顺序即信息，勿重排）          |
| `discovery`  | `null`——没有仓位，地址在 `payload.address`                  |

> `null` 而非 `[]`：空数组会把「不知道」谎报成「零个钱包」。2026-08-21 之前
> 入账的 `consensus` 事件载荷里没有这份明细，同样为 `null`——与
> `outcomeIndex`/`asset` 一样，一天之后全量数据都齐。

`payload` 保留原始载荷，字段一个没少（**additive**，既有消费方零改动）：

| `sourceType` | 事件含义                           | `payload` 字段（中文名）                                                                                                                                                                         |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `large`      | 单笔大额成交（含白名单与非白名单） | `usd` 名义额 · `side` 买卖向（`"BUY"\|"SELL"\|null`）· `outcome` 方向 · `outcomeIndex` · `asset` · `price` 成交价 · `wallet` 钱包 · `slug`/`eventSlug`                                           |
| `consensus`  | ≥N 个白名单钱包同向共识            | `outcome` 方向 · `outcomeIndex` · `asset` · `walletCount` 钱包数 · `totalNetUsd` 总净买 · `avgBuyPrice` 组级加权均价 · `wallets` 钱包明细（`wallet`/`netUsd`/`avgBuyPrice`）· `slug`/`eventSlug` |
| `discovery`  | 新钱包通过准入进白名单池           | `address` 地址 · `score` 评分(0-100) · `source` 发现渠道                                                                                                                                         |

> `payload.usd`（large）与 `payload.totalNetUsd`（consensus）是同一语义的两个
> 历史名字，顶层的 `netUsd` 已统一；`payload.price`（large）与
> `payload.avgBuyPrice`（consensus）同理，顶层 `avgPrice` 已统一；
> `payload.wallets[].avgBuyPrice` 同理，顶层 `wallets[].avgPrice` 才是归一后的
> 名字。新接入请读顶层字段。
> `outcomeIndex`/`asset` 自 2026-08-19 起、`wallets` 与 `avgBuyPrice` 自
> 2026-08-21 起写入载荷，此前入账的事件为 `null`；`bus[]` 窗口最长 48h，一天
> 之后全量数据都齐。

> **`consensus` 的 `avgPrice` 请勿自行从 `wallets[]` 重算。** 源侧给的是按份额
> **USD 加权**的组级成本（`totalNetUsd / Σ(netUsd / avgBuyPrice)`），不是各钱包
> 均价的算术平均——两者能差近 1¢，而追高闸门的红线只有 10¢。顶层 `avgPrice`
> 与 `active[]` 的同名字段读的是同一个源字段，口径保证一致。

要点：

- **阈值分档**：运营者可为同一类型配多档定义（如「大额 ≥$50k / 巨额
  ≥$500k」）。`bus[]` 按最低启用档入账；按档过滤请自行筛 payload 数值，
  或让运营者把你的 webhook 配成只订某一档（§10）。
- `large` **不等于聪明钱**：它是流水，不带判断；白名单身份不在 payload 里。
- `discovery.source` 取值：`leaderboard` 全球榜 / `category:<分类>` 分类榜 /
  `discovered:echo|splitter|insider|early_winner` 四条发现渠道。

---

## 8. 信号 · ② 策略事件（`strategies`）

19 档纸面策略的买入/结算事件。需 key 范围含 `strategy`。

```typescript
interface StrategyFeed {
  active: StrategyFeedSignal[]; // 事件：近 48h 触发、未结算
  settled: StrategyFeedSettled[]; // 事件：近 3 天结算，最多 20 条
  recordByStrategy: Record<
    string, // 键 = strategy id 字符串（如 "6"），不是档名
    { name: string; source: string; record: SignalRecord } // 视图：30d 汇总
  >;
}
```

### 8.1 `active[]` 字段

| 字段             | 类型           | 中文名     | 说明                                       |
| ---------------- | -------------- | ---------- | ------------------------------------------ |
| `id`             | number         | 事件 ID    | webhook 去重键的一半                       |
| `strategy`       | object         | 档位       | `{id, name, source}`；分组用 `id` 不用档名 |
| `conditionId`    | string         | 市场 ID    | —                                          |
| `title`          | string         | 市场问题   | 英文原文                                   |
| `slug`           | string         | 市场短名   | 拼**单市场**页链接                         |
| `eventSlug`      | string         | 事件短名   | 拼事件页链接（一个事件下可挂几十个市场）   |
| `category`       | string \| null | 一级分类   | 如 `Sports`                                |
| `subcategory`    | string \| null | 二级分类   | 如 `NBA`；无为 null                        |
| `outcome`        | string         | 买入方向   | 反向档已是翻转后的方向                     |
| `outcomeIndex`   | number \| null | 方向序号   | —                                          |
| `asset`          | string \| null | 代币 ID    | 用它订实时价（§12）                        |
| `formationTs`    | number         | 形成时刻   | 语义随 `source`，见 §8.3                   |
| `referencePrice` | number \| null | 聪明钱成本 | —                                          |
| `walletCount`    | number \| null | 钱包数     | heavy 恒 1                                 |
| `totalNetUsd`    | number \| null | 总净买     | USD                                        |
| `entryPrice`     | number \| null | 纸面进场价 | 我们的模拟买入价                           |
| `sizeUsd`        | number \| null | 纸面额     | 默认 500                                   |
| `emittedAt`      | number         | 发布时刻   | 减 `formationTs` = 检测延迟                |

`entryPrice − referencePrice` = 追价成本（实测红线 10¢）。

### 8.2 `settled[]` 字段

| 字段           | 类型            | 中文名     | 说明                      |
| -------------- | --------------- | ---------- | ------------------------- |
| `id`           | number          | 事件 ID    | 与 active 同一台账        |
| `strategyId`   | number          | 档位 ID    | —                         |
| `strategyName` | string          | 档位名     | —                         |
| `conditionId`  | string          | 市场 ID    | —                         |
| `title`        | string          | 市场问题   | —                         |
| `outcome`      | string          | 买入方向   | —                         |
| `entryPrice`   | number \| null  | 进场价     | 纸面                      |
| `exitPrice`    | number \| null  | 退出价     | 结算价                    |
| `won`          | boolean \| null | 是否盈利   | null = 平局，不进胜率分母 |
| `realizedPnl`  | number \| null  | 已实现盈亏 | USD，纸面                 |
| `settledAt`    | number          | 结算时刻   | —                         |

**纸面口径**：以上是模拟跟单数字（真实数据 · 模拟策略），展示必须携带
「研究用途模拟信号 · 非投资建议 · 只读非托管」。

### 8.3 检测器族与 19 档

`strategy.source` = 档位所属检测器族：

| source         | 中文名     | 在检测什么                  | `formationTs` 语义 |
| -------------- | ---------- | --------------------------- | ------------------ |
| `consensus`    | 多钱包共识 | N 个白名单钱包净买同一结果  | 第 N 人到位时刻    |
| `heavy`        | 单笔巨额   | 单个白名单钱包单笔 BUY 达标 | 那一笔成交时刻     |
| `lopsided`     | 一边倒分歧 | 有分歧但主导边占比 ≥70%     | 倾斜跨线时刻       |
| `resolved`     | 分歧解除   | 少数边开始净卖（认输）      | 识别到认输那一轮   |
| `lone_wolf`    | 高分独狼   | 高评分钱包净买达标          | 净买跨线时刻       |
| `early_winner` | 早期赢家   | 早期赢家渠道钱包净买达标    | 净买跨线时刻       |

| #     | 档名         | source         | 触发条件                               | 反向 |
| ----- | ------------ | -------------- | -------------------------------------- | ---- |
| 1     | 保守         | `consensus`    | ≥3 钱包，每个净买 ≥$10k                | —    |
| 2     | 激进         | `consensus`    | ≥2 钱包，每个净买 ≥$5k                 | —    |
| 3     | 精英共识     | `consensus`    | ≥2 钱包（仅 score≥80 计入），每个 ≥$5k | —    |
| 4     | 重仓共识     | `consensus`    | ≥2 钱包且总净买 ≥$100k                 | —    |
| 5     | 首发共识     | `consensus`    | 同 1 且形成 ≤300 秒                    | —    |
| 6     | 巨鲸         | `heavy`        | 单笔 BUY ≥$50k                         | —    |
| 7     | 超级巨鲸     | `heavy`        | 单笔 BUY ≥$150k                        | —    |
| 8     | 巨鲸精英     | `heavy`        | 单笔 ≥$50k 且 score≥80                 | —    |
| 9     | 一边倒分歧   | `lopsided`     | 主导边 ≥70%，跟主导边                  | —    |
| 10    | 分歧解除     | `resolved`     | 少数边认输，跟主导边                   | —    |
| 11    | 高分独狼     | `lone_wolf`    | score≥90 且净买 ≥$10k                  | —    |
| 12    | 早期赢家跟投 | `early_winner` | 渠道钱包净买 ≥$5k                      | —    |
| 13    | 逆势少数边   | `lopsided`     | 同 9 的市场，跟少数边                  | 对照 |
| 14-19 | 反巨鲸 等    | 同被镜像档     | 同参数买相反边（对照组）               | ✓    |

各档持仓会重叠，**战绩不可跨档相加**。当前对外放开的档见 §4 实时状态表。

---

## 9. 视图（拉取展示，非信号）

对 ① 大额/共识事件的折叠与汇总。规则固定（非配置），数据请求时现算。

### 9.1 `active[]` — 进行中（折叠视图）

按市场×方向折叠：同一仓位多笔成交只出一条；共识升级原地更新金额但
`formationTs` 保持最初形成时刻；两侧都有聪明钱时合并为一条 `split`。

三种 `kind`：

| kind        | 判据（固定）                      | 读法                              |
| ----------- | --------------------------------- | --------------------------------- |
| `consensus` | ≥2 白名单钱包净买同一结果         | 最强方向                          |
| `split`     | 两个对立结果上都有白名单钱包      | 警告，无方向（`outcome` 恒 null） |
| `heavy`     | 单个白名单钱包单笔 ≥`heavyMinUsd` | 单人观点；已有共识时被抑制        |

| 字段           | 类型                         | 中文名   | 说明                                             |
| -------------- | ---------------------------- | -------- | ------------------------------------------------ |
| `key`          | string                       | 去重键   | `<conditionId>\|<outcome>`；split 为 conditionId |
| `kind`         | `SignalKind`                 | 种类     | 见上表                                           |
| `conditionId`  | string                       | 市场 ID  | —                                                |
| `title`        | string                       | 市场问题 | —                                                |
| `slug`         | string                       | 市场短名 | 缺失时空串                                       |
| `eventSlug`    | string                       | 事件短名 | 别拿它当市场链接                                 |
| `category`     | string \| null               | 一级分类 | —                                                |
| `subcategory`  | string \| null               | 二级分类 | —                                                |
| `formationTs`  | number                       | 形成时刻 | 判断新鲜度用它                                   |
| `outcome`      | string \| null               | 方向     | split 恒 null                                    |
| `outcomeIndex` | number \| null               | 方向序号 | —                                                |
| `asset`        | string \| null               | 代币 ID  | —                                                |
| `walletCount`  | number                       | 钱包数   | split 为两侧之和                                 |
| `netUsd`       | number                       | 净买入   | split 为两侧之和                                 |
| `avgPrice`     | number                       | 成本基准 | split 恒 0                                       |
| `wallets`      | `{wallet,netUsd,avgPrice}[]` | 钱包明细 | 按净买降序                                       |
| `sides`        | 数组（仅 split）             | 双边明细 | 每侧同 wallets 外加 outcome/asset                |

### 9.2 `settled[]` — 已结算（认账视图）

近 3 天，同一市场×方向取最新一条，最多 20 条。**与 `active[]` 同构**：
身份/仓位字段同名同义（可用 `key` 对上号、复用同一卡片组件），差别只在
末尾三项：

| 字段         | 类型    | 中文名   | 说明                      |
| ------------ | ------- | -------- | ------------------------- |
| `entryPrice` | number  | 进场价   | 等同 active 的 `avgPrice` |
| `won`        | boolean | 是否命中 | —                         |
| `settledAt`  | number  | 结算时刻 | —                         |

同一条信号可同时出现在 `active[]` 与 `settled[]`（窗口口径不同）——同
`key` 是同一笔仓位的两个阶段。

### 9.3 `record30d` — 30 天战绩（汇总视图）

⚠️ **五个字段全是「条数」量纲，不是百分比。**

| 字段      | 中文名           | 说明                                        |
| --------- | ---------------- | ------------------------------------------- |
| `settled` | 已判定条数       | 分母                                        |
| `wins`    | 命中条数         | 分子                                        |
| `implied` | 市场预期命中条数 | Σ 各信号赢面的隐含概率                      |
| `excess`  | 超额条数         | `wins − implied`                            |
| `sd`      | 噪音标准差       | `√Σ p(1−p)`，判断 excess 是否显著的唯一尺子 |

示例：`{"settled":1799,"wins":1066,"implied":1051.3,"excess":14.7,"sd":19.3}`
——市场预期中 1051.3 条，实际多中 14.7 条，噪音 σ=19.3，**在运气范围内**。

展示要求：命中数旁必印 `implied`；`|excess| < 2×sd` 必须写「仍在运气范围
内」；`settled < 5` 标「样本不足」；禁止单日胜率/连对天数类表述。

`recordByStrategy`（§8）量纲与展示要求同此。两份战绩口径不同
（①动向 vs ②各档纸面），**不可比也不可加**。

---

## 10. Webhook 推送（`realtime` tier 专属）

由运营者代为登记你的端点：接收 URL + ≥16 字符 HMAC secret + 勾选的推送
类型。规则：

- 不勾 = 仅 ② 策略事件（历史默认）；① 各类型须显式勾选；
- ① 类型可**按定义细分**订阅（如只订「巨额 ≥$500k」档），事件体不变、
  只是子集；
- 勾选须在 key 订阅范围内，越界登记当场被拒；
- ① 类型的全局开关（§4）仍是产出前提。

### 请求头

```http
POST <你的 URL>
content-type: application/json
x-signature: sha256=<hex hmac-sha256(secret, 原始 body)>
x-signal-id: <事件 id>
x-signal-event: entry | settle | bus
```

### 事件体

② 策略事件 `SignalEventV1`（`event: "entry" | "settle"`）：

```typescript
interface SignalEventV1 {
  v: 1;
  id: number; // strategy_signals.id
  event: "entry" | "settle";
  emittedAt: number;
  strategy: { id: number; name: string; source: string };
  market: {
    conditionId: string;
    title: string;
    slug: string;
    eventSlug: string;
    category: string | null;
    subcategory: string | null;
    outcome: string;
    outcomeIndex: number | null;
    asset: string | null;
  };
  signal: {
    formationTs: number;
    referencePrice: number | null;
    walletCount: number | null;
    totalNetUsd: number | null;
  };
  paper: {
    entryPrice: number | null;
    sizeUsd: number | null;
    chaseCents: number | null; // (entry − reference) × 100
    latencySec: number; // emittedAt − formationTs
  };
  record: SignalRecord | null; // 量纲见 §9.3
  settle: {
    settledTs: number;
    exitPrice: number | null;
    won: boolean | null;
    realizedPnl: number | null;
  } | null; // entry 时为 null
  notice: string;
}
```

① 原始事件 `BusEventV1`（`event: "bus"`）：

```typescript
interface BusEventV1 {
  v: 1;
  event: "bus";
  id: number; // bus_signals.id
  bus: BusSignal; // 与 §7 的 bus[] 单条完全同形
  notice: string;
}
```

「完全同形」不是承诺而是事实：推拉两条路径嵌的是**同一份** zod schema
（`lib/signalBus.ts` 的 `BusSignalSchema`），并有一条从真实数据现算字段集的
回归测试钉着 —— 给 `bus[]` 加字段而漏掉 webhook 这条路，测试会先红。

幂等去重键 `(id, event)`——两类事件 id 来自不同表，但 `event` 不同，
二元组永不碰撞。

### 验签（Node.js）

```javascript
import { createHmac, timingSafeEqual } from "node:crypto";

// 必须用原始 body 字符串验签，不能 parse 后再 stringify。
function verify(rawBody, header, secret) {
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(header ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

### 投递语义

| 事项       | 行为                                             |
| ---------- | ------------------------------------------------ |
| 交付保证   | at-least-once，按 `(id, event)` 去重             |
| 超时       | 5 秒；请先回 2xx 再做重活                        |
| 成功       | 任意 2xx                                         |
| `4xx`      | 永久拒收，该条不再重试                           |
| `5xx`/网络 | 瞬态，30 秒节奏重试                              |
| 熔断       | 连续失败 10 次停用端点并通知运营者               |
| 补发窗口   | `entry` 6 小时 / `settle` 7 天 / `bus` 1 小时    |
| `bus` 特有 | 不回灌（只投登记后的事件）；每端点每轮最多 10 条 |
| 引擎停跳   | 投递整体冻结                                     |

---

## 11. 失败语义

服务端内部异常时不返回 5xx，而是 `200` + 空 feed + `healthy: false` +
`error` 字段。**字段集合与成功响应一致**，你不需要为失败分支准备另一套
类型。

`healthy === false` 时必须：顶部提示中断；冻结时间戳（「3 分钟前」改
「截至 HH:MM」）；隐藏「去交易」等行动入口。

---

## 12. 频率、拓扑与现价

- 每分钟拉 1 次即可（服务端缓存 30s）。
- 本服务不承接终端 App 直连。正确拓扑：

```
WhaleWatch ──1 次/分钟──▶ 你的后端（缓存+你的鉴权）──▶ 你的客户端
```

- key 放服务端，不下发客户端。
- **现价不从本接口取**：用 `asset` 直连
  `wss://ws-subscriptions-clob.polymarket.com`。本服务只给成本基准
  （`avgPrice` / `referencePrice`）；追高闸门 = 实时价 − 成本，红线 10¢。

---

## 13. 公开端点（无需 key）

### `GET /api/record`

已**公开发布**信号的战绩与存证（分母只含发过的信号，与 §8 的全量纸面
履历口径不同，不可混用）。

```typescript
interface RecordFeed {
  updatedAt: number;
  strategies: {
    id: number;
    name: string;
    source: string;
    pushedCount: number; // 已发布总数（含未结算）
    record: SignalRecord; // 量纲见 §9.3
    settledRecent: {
      id: number;
      conditionId: string;
      title: string;
      outcome: string;
      entryPrice: number | null;
      exitPrice: number | null;
      won: boolean | null;
      realizedPnl: number | null;
      settledAt: number;
    }[]; // 最多 10 条
  }[];
  digest: { day: string | null; tail: string | null }; // 存证链尾
}
```

`digest` 为每 UTC 日的链式 sha256 摘要链尾，可复算验证「先发布后结算、
未删改」。限流：每 IP 60 次/分钟，超限 `429`。

### `GET /api/health`

`200` = 全部引擎循环正常心跳；`503` = 有停跳。适合挂 uptime 监控。
返回 `{ok, nowSec, loops[], staleLoops[], startedAt}`。

---

## 14. 市场深度卡（按需查询）

```
GET /api/signals/market/{conditionId}
```

需 key 范围含 `market`，且 **`realtime` tier 专属**。回答的是「用户正要在这个
市场下单，此刻盘面长什么样」：谁在买、多强、成本多少、有没有分歧、我们历史上
在这里发过什么信号、准不准。

> **一张延迟 30 分钟的盘面回答不了「我现在该不该进」** ——所以延迟档拿不到它，
> 这是范围问题不是字段阉割（`delayed` key 的 `/api/signals` 字段仍一个不少）。

### 与 `/api/signals` 的根本差别（先读这一段）

|            | `/api/signals`                   | 本端点                       |
| ---------- | -------------------------------- | ---------------------------- |
| 数据来源   | 全部已持久化状态，**零上游调用** | **按需打上游**（成交窗口）   |
| 突发流量   | 永远挤不占引擎预算               | 受全局预算约束，会背压       |
| `429`      | 不会                             | **会，且是正常工作状态**     |
| 稳定性依赖 | 只依赖我们自己                   | 额外依赖 Polymarket 公开 API |

### 响应

```typescript
interface MarketCardResponse {
  card: MarketCard; // identity / meta / brief / freshFlow / history / window
  builtAt: number; // 本卡数据的基准时刻（unix 秒）
  staleSec: number; // 响应时刻 − builtAt
  live: boolean; // true = 新鲜期内；false = 预算耗尽，发的是陈旧窗口重算的卡
  healthy: boolean; // 引擎健康位，与 /api/signals 同义
  notice: string; // 研究用途 · 非投资建议 · 只读非托管
}
```

`card.brief` 三段：`classification`（`consensus` / `disagreement` / `none`，与
全站同一套判据与门槛）、`smartFlow`（按结果分组的聪明钱**留存**敞口，逐钱包给
`exposureUsd` / `netShares` / `avgBuyPrice` / `scoreBand` / `winRate` /
`isMarketMaker`）、`accum`（拆单建仓组）。另有 `freshFlow`（≤7 天新钱包的大额
买入）与 `history`（我们在这个市场发过的告警 + 验证结论）。

### 为什么给的是 `scoreBand` 而不是原始分

`scoreBand` 取值 `"high"` / `"mid"` / `"low"` / `null`（未知）。

原始评分是我们内部模型的输出，会随模型迭代漂移。把一个连续值写进对外契约，等于
承诺它的语义永不变——那样我们每调一次模型，对你就是一次无声的破坏性变更。分档是
**稳定语义**：模型怎么调，都不改变「这个钱包算强」这件事。分档边界的改动才算破坏
性变更，而那是件明确、罕见、会公告的事。

`winRate` 照给原值：它是实测统计（逐仓盈亏聚合，已处理持有到归零的幸存者偏差），
不是模型输出，没有随版本漂移的问题。

### 状态判据

| 情形                        | 返回                                      |
| --------------------------- | ----------------------------------------- |
| 数据在新鲜期内              | `200`，`live: true`，`staleSec` 很小      |
| 预算耗尽，但缓存窗口在闸内  | `200`，`live: false` + `staleSec`         |
| 预算耗尽且无缓存 / 超陈旧闸 | `429` + `Retry-After`                     |
| 引擎停跳                    | 预算归零 → 多为上面两行，`healthy: false` |

**`429` 是背压，不是故障。** 它意味着「此刻不能诚实地回答你」，请按
`Retry-After` 退避后重试——立刻重试只会把背压变成雪崩。429 的响应体**不含
`card`**，所以不会被误读成「这个市场没有信号」。

**超过陈旧闸我们宁可拒绝，也不发旧卡。** 卡片说「3 个聪明钱刚买了 YES」，若其中
2 个在这几分钟里已经卖了，那张卡不是「不够新」，是**错的**，而且错在会让人亏钱
的方向上。

### ⚠️ 这条端点的依赖风险，必须知道

`/api/signals` 只读我们自己的库；**本端点按需向 Polymarket 的公开 API 取数**，
而那些接口**无版本、会静默变更**。实测有过：`/activity` 的 `limit` 上限从 1000
悄悄降到 500，没有公告，直接把依赖它的页面全打挂。

所以：本端点的可用性含有一段我们控制不了的部分。把它接进你的关键路径前，请准备
好降级显示（例如仅用 `/api/signals` 的信号做提示），不要让一张卡片拿不到就阻断
用户的操作。

---

## 15. 常见问题

**`bus` 一直是空数组？** 看 §4 实时状态表——类型未开启就是预期行为，
不是故障。

**`active` 是空的？** 先看 `healthy`；为 true 且 `updatedAt` 新鲜就是窗口
内没有达标信号，放大 `windowHours` 再看。

**`implied` 是 1051.3，是百分比吗？** 不是，`record` 五件套全是条数
（§9.3）。

**`recordByStrategy` 用档名取不到？** 键是 strategy id 字符串（`"6"`），
档名在 `.name`。

**想用 webhook 收聪明钱动向？** 订 ① 的 `consensus`/`large` 类型——
`active[]` 是折叠视图，没有稳定逐事件 id，不作为推送对象。

**能拿历史数据吗？** 只有滚动窗口与 30 天汇总；长期记录见公开页
`/record`。

**key 何时失效？** 仅运营者吊销时，立即 401，挂其上的 webhook 同时失效。

---

## 16. 变更记录

| 日期       | 变更                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| 2026-08-21 | 新增 `/api/signals/market/{cid}` 市场深度卡（`realtime` + `market` 范围）——本文首个**会打上游**的端点，含 `429` 背压语义 |
| 2026-08-21 | ① `bus[]` 增 `wallets` 钱包明细（与 `active[]` 同名同义；`discovery` 恒 `null`）——webhook 同步生效                     |
| 2026-08-19 | 文档重写为使用者参考版（理由与修订史移至内部契约）。信号=事件（①原始/②策略）与视图分立为本文骨架                       |
| 2026-08-19 | ① 支持多档信号定义（同类型不同阈值），webhook 可按档订阅；`settled[]` 补齐与 `active[]` 同构字段；`active[]` 增 `slug` |
| 2026-08-18 | webhook 支持 ① 类型；失败响应字段集合与成功一致；`record` 量纲修正（条数）；开放状态改实时生成                         |
| 2026-08-13 | `strategies` 段、`delayed` tier、多租户 key、webhook、`/api/record` 与存证链、`bus[]` 与订阅范围                       |
