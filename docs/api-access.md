# WhaleWatch 信号 API — 接入文档

> 面向持有 API key 的订阅方。key 由运营者在 `/manage → 🔑 接入` 签发，
> 明文只在签发那一刻显示一次（库中仅存 sha256），丢失只能重新签发。

**基址**：`https://whalewatch.wired.fund`

| 端点                | 方法   | 鉴权          | 缓存 | 用途                             |
| ------------------- | ------ | ------------- | ---- | -------------------------------- |
| `/api/signals`      | `GET`  | API key       | 30s  | 主 feed：信号、策略、总线、战绩  |
| `/api/record`       | `GET`  | 无（公开）    | 60s  | 已公开发布信号的战绩与存证链状态 |
| `/api/health`       | `GET`  | 无（公开）    | 无   | 引擎存活探针（200 / 503）        |
| webhook（你的端点） | `POST` | HMAC 签名验证 | —    | 实时推送（`realtime` tier 专属） |

- **零上游调用**：全部字段来自本服务已持久化的状态。你的请求不会挤占监控
  引擎的 Polymarket API 预算，也不会因上游抖动而失败。
- **字段只增不改**：既有字段的名称与语义不会变更，新能力以新字段追加。
  请按「忽略未知字段」的方式解析。

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

  // 故障与「今天没信号」必须分开处理（见 §7）
  if (!feed.healthy) {
    console.error(
      "[whalewatch] 上游不健康，冻结下游动作:",
      feed.staleLoops,
      feed.error,
    );
    return null;
  }
  if (feed.delayedMin > 0) {
    console.log(`[whalewatch] 延迟层：数据为 ${feed.delayedMin} 分钟前的世界`);
  }
  return feed;
}

setInterval(() => void pull(), 60_000); // 推荐节奏：1 次/分钟
```

---

## 2. 鉴权

两种写法等价，任选其一：

```http
x-feed-token: <YOUR_API_KEY>
```

```http
authorization: Bearer <YOUR_API_KEY>
```

key 形如 `wlk_` + 32 字符 base64url。

### 错误响应

| 状态                          | 含义                                                     | 处理建议                                    |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| `401`                         | key 缺失、错误，或已被吊销                               | 检查 header 拼写；确认 key 未被运营者吊销   |
| `403`                         | 服务端尚未开放 feed（既没配 env token 也没签发任何 key） | 联系运营者                                  |
| `200` + 响应体含 `error` 字段 | 服务端内部异常                                           | 见 §7 失败语义 ——**不要当成「今天没信号」** |

`401` / `403` 的响应体是 `{ "error": "<中文说明>" }`，**没有** feed 结构。

`/api/signals` 本身不做请求数限流（30 秒缓存即是保护）。公开端点
`/api/record` 有限流，超限返回 `429`，见 §11。

---

## 3. Tier：`realtime` 与 `delayed`

每个 key 在签发时定 tier，决定你看到的是**哪个时刻的世界**：

| tier       | 语义                                                         |
| ---------- | ------------------------------------------------------------ |
| `realtime` | 实时。信号形成即可见；可挂 webhook 推送（§10）               |
| `delayed`  | 整个 feed 以 `now − delayedMin` 构建（当前部署延迟 30 分钟） |

关键点：**延迟层不阉割任何字段**，只是时间平移——你拿到的是「30 分钟前的
完整世界」，而不是「现在的删减版」。具体表现：

- 晚于基准时刻形成的信号不可见；
- 晚于基准时刻落地的结算**仍显示为进行中**（在 `strategies.active` 里）；
- `updatedAt` 就是**数据基准时刻**（已时移），展示「截至 HH:MM」请以它为准；
- `delayedMin` 明确告诉你延迟了多少分钟（`realtime` 恒为 `0`）。

唯一的例外是健康位：`healthy` / `staleLoops` **始终按真实时间评估**。引擎死
没死是所有订阅方都必须立刻知道的事实，不该被延迟掩盖。

---

## 4. 订阅范围（你的 key 能拿到哪些类型）

签发 key 时可以限定**订阅范围**。范围之外的类型，你在 `/api/signals` 与
webhook 上都拿不到——**过滤在服务端执行**，不需要你自己筛。

| 类型        | 出现在响应的哪里                               |
| ----------- | ---------------------------------------------- |
| `strategy`  | `strategies` 段（19 档策略信号）+ webhook 推送 |
| `large`     | `bus[]` 中 `sourceType: "large"`（大额成交）   |
| `consensus` | `bus[]` 中 `sourceType: "consensus"`           |
| `discovery` | `bus[]` 中 `sourceType: "discovery"`           |

- 未限定范围的 key = **不限**，拿全部类型。
- 若你的 key 不含 `strategy`，`strategies` 段会是**空结构**
  （`{"active":[],"settled":[],"recordByStrategy":{}}`），不是缺字段——形状
  始终一致，你的解析代码不必判空。
- 想调整范围，联系运营者重新签发。

> ⚠️ `active[]` / `settled[]` / `record30d`（§6.2–§6.4，v1 既有字段）**不受
> 订阅范围约束**，任何有效 key 都能拿到。范围只作用于 `strategies` 与 `bus`。

---

## 5. 请求参数

`GET /api/signals`

| 参数          | 类型   | 取值                     | 默认 | 说明                                 |
| ------------- | ------ | ------------------------ | ---- | ------------------------------------ |
| `windowHours` | number | `6` / `12` / `24` / `48` | `24` | 时间窗。非法值静默回落默认值，不报错 |

`windowHours` 作用于 `active[]` 与 `bus[]`。**不影响** `strategies.active`
（固定 48 小时窗）、`settled`（固定 3 天）、`record30d`（固定 30 天）。

---

## 6. 响应结构

### 6.0 通用数据格式约定

| 约定      | 说明                                                                    |
| --------- | ----------------------------------------------------------------------- |
| 时间戳    | **unix 秒**（整数，UTC）。不是毫秒                                      |
| 价格      | `0`–`1` 的小数 = 该结果的市场隐含概率，也是每份合约的 USDC 价格         |
| 金额      | **USD**（数值，非字符串，未做千分位格式化）                             |
| `null`    | 「该字段对这条记录不适用或未知」。字段本身不会消失（§7 的失败响应亦然） |
| 字符串 ID | `conditionId` = `0x…` 市场 ID；`asset` = CLOB token id（十进制字符串）  |
| 数组      | 无数据时是 `[]`，不是 `null`                                            |
| 排序      | 各列表均为**新在前**（按各自的时间字段倒序）                            |

### 6.1 顶层

```jsonc
{
  "updatedAt": 1755412800, // number   本次数据的构建基准时刻（延迟层已时移）
  "windowHours": 24, // number   实际生效的窗口
  "heavyMinUsd": 50000, // number   单钱包「大额」口径阈值，恒 50000
  "delayedMin": 0, // number   0 = realtime；30 = 延迟 30 分钟
  "healthy": true, // boolean  引擎健康位（永远按真实时间评估）
  "staleLoops": [], // string[] 停跳的循环名；healthy=false 时非空

  "active": [/* §6.2 */],
  "settled": [/* §6.3 */],
  "record30d": {/* §6.4 */},
  "strategies": {/* §6.5 */},
  "bus": [/* §6.6 */],
}
```

TypeScript：

```typescript
interface SignalsResponse {
  updatedAt: number;
  windowHours: number;
  heavyMinUsd: number;
  delayedMin: number;
  healthy: boolean;
  staleLoops: string[];
  active: Signal[];
  settled: SettledSignal[];
  record30d: SignalRecord;
  strategies: StrategyFeed;
  bus: BusSignal[];
  /** 仅在服务端内部异常时出现，见 §7。 */
  error?: string;
}
```

`staleLoops` 的取值来自引擎循环名：`alert`、`consensus`、`outcome_backfill`、
`delivery`。

### 6.2 `active[]` — 进行中的聪明钱信号

窗口内、已按「市场 × 方向」折叠的白名单钱包动向。

```typescript
type SignalKind = "consensus" | "split" | "heavy";

interface Signal {
  /** 稳定标识，客户端去重用。`<conditionId>|<outcome>`；split 时为 conditionId。 */
  key: string;
  kind: SignalKind;
  conditionId: string;
  title: string; // 市场问题原文（英文）
  eventSlug: string;
  category: string | null; // 一级分类，如 "Politics" / "Sports"
  subcategory: string | null; // 二级分类，如 "NBA" / "Bitcoin"；无/未知为 null
  formationTs: number; // 信号最初形成时刻（判断新鲜度用它）

  outcome: string | null; // split 恒为 null —— 分歧不给方向
  outcomeIndex: number | null;
  asset: string | null; // CLOB token id；可用它订阅实时价
  walletCount: number;
  netUsd: number; // 净买入额（split 为两侧之和）
  avgPrice: number; // 他们的成本基准；split 恒为 0
  wallets: SignalWallet[];
  /** 仅 split 存在；其余 kind 该字段不出现。 */
  sides?: SignalSide[];
}

interface SignalWallet {
  wallet: string; // 0x… 小写
  netUsd: number;
  avgPrice: number;
}

interface SignalSide {
  outcome: string;
  outcomeIndex: number | null;
  asset: string | null;
  walletCount: number;
  netUsd: number;
  avgPrice: number;
}
```

**三种 kind 的定义与读法：**

| kind        | 规则                               | 交易者怎么读                              |
| ----------- | ---------------------------------- | ----------------------------------------- |
| `consensus` | ≥2 个白名单钱包净买同一结果        | 最强方向信号                              |
| `split`     | 同一市场**两侧**都有白名单钱包     | **警告，不构成方向**；`outcome` 恒为 null |
| `heavy`     | 单个白名单钱包单笔 ≥ `heavyMinUsd` | 单人观点，弱于共识                        |

**已在服务端处理好、客户端不必重做的事：**

- **按市场 × 方向折叠**：同一仓位的多笔成交只出一条（原始告警约 245 条/天 →
  折叠后约 8–24 条）
- **共识升级合并**：保留最新金额，但 `formationTs` 是**最初**形成时刻
- **双边合并**：split 只出一条，`sides` 保留两侧，绝不拆成两条方向相反的卡
- **heavy 抑制**：同一市场 × 方向已有共识时不再出 heavy
- **排序**：按 `formationTs` 倒序。建议按你自己的相关性重排（自己的持仓优先）

### 6.3 `settled[]` — 已结算的聪明钱信号（认账区）

```typescript
interface SettledSignal {
  title: string;
  outcome: string;
  kind: SignalKind; // 这里只会是 "consensus" | "heavy"
  entryPrice: number; // 进场价（成交价或共识加权均价）
  won: boolean;
  settledAt: number;
}
```

近 **3 天**，同一市场 × 方向只取最新一条，**最多 20 条**。

### 6.4 `record30d` — 30 天价格调整战绩

⚠️ **这五个字段全是「条数」量纲，不是百分比。** 把 `implied` 当胜率渲染是
最常见的接入错误。

```typescript
interface SignalRecord {
  settled: number; // 已判定信号条数（分母）
  wins: number; // 命中条数
  implied: number; // 市场在同样价位下预期的命中条数 = Σ 各信号自身赢面的隐含概率
  excess: number; // wins − implied，正数 = 跑赢市场自己的定价
  sd: number; // 市场有效零假设下的标准差 = √Σ p(1−p)
}
```

真实取值示例（注意量纲）：

```jsonc
"record30d": {
  "settled": 1799,
  "wins": 1066,
  "implied": 1051.3,   // 1051.3 条，不是 105.13%
  "excess": 14.7,
  "sd": 19.3
}
```

`implied` 按买卖方向取值：BUY 记 `成交价`，SELL 记 `1 − 成交价`（SELL 的
胜负判据是价格下跌，市场对下跌的隐含概率是 `1 − p`）。同一次共识只计一次
（按「市场 × 方向」折叠，保留形成时刻那一条）。

**展示铁律**（与推送尾行同源，服务端 `gradeRows` 是唯一实现）：

- **命中数旁边必须同时印出 `implied`**，否则 `1066/1799` 无从解读——它的
  基准是 58.4% 而不是 50%
- **`excess` 绝不能脱离噪音判定单独出现**：`|excess| ≥ 2 × sd` 才可以说
  「已超运气范围」，否则必须写「仍在运气范围内」
- **`settled < 5` 必须标「样本不足」**
- **禁止**任何「今日/昨日胜率」「连对 N 天」「分组冠军」——单日样本 95%
  误差带 ±14pp，零技能下 30 天内有 73% 概率打印出一个 ≥65% 的「神日」

数据口径：近 30 天 `consensus` / `smart` 两类告警中**已有结算判定**的那些；
无成交价的行两侧都不计入。

### 6.5 `strategies` — 策略中心 19 档的买入信号

需要 key 的订阅范围包含 `strategy`，否则是空结构。只包含运营者**已放开
推送**的档位。

```typescript
interface StrategyFeed {
  active: StrategyFeedSignal[];
  settled: StrategyFeedSettled[];
  /** 键是 strategy id 的字符串形式（如 "6"），不是档位名。 */
  recordByStrategy: Record<
    string,
    { name: string; source: string; record: SignalRecord }
  >;
}
```

#### `strategies.active[]` — 近 48 小时触发、尚未结算

```typescript
interface StrategyFeedSignal {
  id: number; // strategy_signals.id，稳定引用 + webhook 去重键
  strategy: { id: number; name: string; source: string };
  conditionId: string;
  title: string;
  slug: string;
  eventSlug: string;
  category: string | null;
  subcategory: string | null;
  outcome: string;
  outcomeIndex: number | null;
  asset: string | null; // CLOB token id
  formationTs: number; // 信号成立时刻（detector 语义）
  referencePrice: number | null; // 聪明钱成本基准
  walletCount: number | null;
  totalNetUsd: number | null;
  entryPrice: number | null; // 纸面入场价（信号发出那一刻的现价）
  sizeUsd: number | null; // 纸面下注额
  emittedAt: number; // 发布时刻（先发布后结算的存证锚点）
}
```

```jsonc
{
  "id": 4211,
  "strategy": { "id": 6, "name": "巨鲸", "source": "heavy" },
  "conditionId": "0x…",
  "title": "Chiefs win Super Bowl LX?",
  "slug": "chiefs-sb-lx",
  "eventSlug": "super-bowl-lx",
  "category": "Sports",
  "subcategory": "NFL",
  "outcome": "Yes",
  "outcomeIndex": 0,
  "asset": "7112…",
  "formationTs": 1755410000,
  "referencePrice": 0.61,
  "walletCount": 3,
  "totalNetUsd": 92000,
  "entryPrice": 0.63,
  "sizeUsd": 500,
  "emittedAt": 1755410120,
}
```

**`emittedAt − formationTs` 就是本系统的检测延迟**，公开这个差值是刻意的：
它让你能自己判断「跟这个信号还来不来得及」。
**`entryPrice − referencePrice` 是追价成本**（正数 = 我们比聪明钱买得贵），
本项目实测红线为 10¢。

`strategy.source` = 该档的检测器族：

| source         | 含义           |
| -------------- | -------------- |
| `consensus`    | 多钱包同向共识 |
| `heavy`        | 单笔大额       |
| `lopsided`     | 一边倒分歧     |
| `resolved`     | 分歧解除       |
| `lone_wolf`    | 高分独狼       |
| `early_winner` | 早期赢家跟投   |

19 档中有 6 档是**反向对照档**（档名以「反」开头，如「反巨鲸」）：同一批
候选、买相反的边，用于检验正向档的 edge 是否真实。它们的 `source` 与被镜像
的正向档相同，请按**档名 + `strategy.id`** 区分，不要只看 `source`。

#### `strategies.settled[]` — 近 3 天认账，最多 20 条

```typescript
interface StrategyFeedSettled {
  id: number;
  strategyId: number;
  strategyName: string;
  conditionId: string;
  title: string;
  outcome: string;
  entryPrice: number | null;
  exitPrice: number | null;
  won: boolean | null; // null = 平局（不进任何胜率分母）
  realizedPnl: number | null; // USD
  settledAt: number;
}
```

#### `strategies.recordByStrategy` — 各档 30 天战绩

```jsonc
"recordByStrategy": {
  "6": {
    "name": "巨鲸",
    "source": "heavy",
    "record": { "settled": 41, "wins": 26, "implied": 22.9, "excess": 3.1, "sd": 3.4 }
  },
  "7": { "name": "超级巨鲸", "source": "heavy", "record": { /* … */ } }
}
```

- **键是 strategy id 的字符串**（`"6"`），不是档位名。
- 覆盖所有已放开推送的档位，**包括本窗口没有任何 active 信号的档**。
- `record` 的字段量纲同 §6.4，展示铁律同样适用。
- 口径：该档**全部纸面履历**近 30 天已结算的仓位（不只是公开发布过的那些）。
  只统计已公开发布信号的战绩请用 `/api/record`（§11）。

**纸面口径提醒**：`entryPrice` / `realizedPnl` / `record` 是模拟跟单数字
（真实数据 · 模拟策略）。展示时必须携带
**「研究用途模拟信号 · 非投资建议 · 只读非托管」**。

### 6.6 `bus[]` — 统一信号总线

全站各类原始信号的台账投影。需要 key 的订阅范围包含对应类型。

```typescript
interface BusSignal {
  id: number;
  sourceType: "large" | "consensus" | "discovery";
  dedupKey: string; // 幂等去重键
  conditionId: string | null;
  title: string | null;
  payload: Record<string, unknown>; // 形状随 sourceType 而定，见下表
  emittedAt: number;
}
```

窗口 = `windowHours`，按 `emittedAt` 倒序，**最多 200 条**。

| `sourceType` | `dedupKey`         | `payload` 形状                                                                                                 |
| ------------ | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `large`      | `alert:<id>`       | `{ usd, side: "BUY"\|"SELL"\|null, outcome: string\|null, price, wallet: string\|null, slug, eventSlug }`      |
| `consensus`  | `alert:<id>`       | `{ outcome: string\|null, walletCount: number, totalNetUsd: number\|null, slug, eventSlug }`                   |
| `discovery`  | `wallet:<address>` | `{ address: string, score: number\|null, source: string\|null }`；此类型的 `conditionId` / `title` 恒为 `null` |

> **`bus` 为空不一定是没信号。** 每个类型都有运营者侧的开关与阈值，**默认
> 全关**。开启后只投影此后 1 小时内产生的新事件，**不回灌历史**。如果你订阅
> 了某类型却长期拿到空数组，请联系运营者确认该类型已开启。

---

## 7. 失败语义（重要）

服务端内部异常时**不会返回 5xx**，而是返回 `200` + 一个空 feed，并带上
`healthy: false` 与 `error` 字段：

```jsonc
{
  "updatedAt": 1755412800,
  "windowHours": 24,
  "heavyMinUsd": 50000,
  "active": [],
  "settled": [],
  "record30d": { "settled": 0, "wins": 0, "implied": 0, "excess": 0, "sd": 0 },
  "strategies": { "active": [], "settled": [], "recordByStrategy": {} },
  "bus": [],
  "delayedMin": 0,
  "healthy": false,
  "staleLoops": [],
  "error": "<异常信息>",
}
```

这条失败响应的**字段集合与成功响应完全一致**，只多一个 `error`——`heavyMinUsd`
与 `staleLoops` 同样在。你的解析代码不需要为失败分支准备一套「可选字段」，
§6.1 的类型定义对两条路径都成立。

这样设计是为了让「服务出错」和「今天没有信号」**在你的代码里必须分开处理**
——一个只看 `active.length === 0` 的消费者，绝不该把故障当成平静的一天。

**`healthy === false` 时接入方必须做的事：**

1. 顶部展示中断提示
2. **冻结时间戳**，把「3 分钟前」改成「截至 HH:MM」
3. **隐藏「去交易」等行动入口**——绝不能让用户对着旧价下单

这是「安静」和「死了」不长得一样的唯一保证。

---

## 8. 拉取频率与限流

- **推荐：每分钟 1 次。** 服务端缓存 30 秒，拉得更频繁只会拿到同一份数据。
- 缓存按 `(windowHours, tier, 订阅范围)` 分片——你的 key 不会拿到范围之外
  的数据。
- 本服务是单机 Next + SQLite 的研究服务，**不具备承接终端 App 直连流量的
  能力**。正确的拓扑是：

```
WhaleWatch  ──1 次/分钟──▶  你的后端（缓存 + 你自己的鉴权）  ──▶  你的客户端
```

把 key 放在你的服务端，不要下发到客户端——key 一旦泄露，任何人都能用你的
配额拉数据，而你无法单独吊销某个终端。

---

## 9. 现价从哪来

**不要用本接口取现价。** 用 `asset`（CLOB token id）直连 Polymarket 的
`wss://ws-subscriptions-clob.polymarket.com` 即可拿到实时价。

本服务只提供**成本基准**：

- `active[].avgPrice` = 聪明钱的成本；
- `strategies.active[].referencePrice` = 聪明钱的成本，`entryPrice` = 我们的
  纸面进场价。

追高闸门 = 你的实时价 − 成本基准，红线 10¢（该阈值来自本项目纸面跟单的
实测结论）。

---

## 10. Webhook 推送（`realtime` tier 专属）

由运营者代为登记你的接收端点（不是订户自助，以收窄 SSRF 面）。你需要提供：
接收 URL（http/https）+ 一个 ≥16 字符的 HMAC secret。

当前 webhook **只推送策略信号**（`strategy` 类型）；`bus` 类型仅在拉取 API
提供。

### 请求

```http
POST <你的 URL>
content-type: application/json
x-signature: sha256=<hex hmac-sha256(secret, 原始 body)>
x-signal-id: 4211
x-signal-event: entry
```

### 事件体 `SignalEventV1`

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
    chaseCents: number | null; // (entryPrice − referencePrice) × 100，单位 ¢
    latencySec: number; // emittedAt − formationTs
  };
  record: SignalRecord | null; // 该档 30d 战绩，量纲见 §6.4
  settle: {
    // event === "entry" 时为 null
    settledTs: number;
    exitPrice: number | null;
    won: boolean | null;
    realizedPnl: number | null;
  } | null;
  notice: string; // "研究用途模拟信号 · 非投资建议 · 只读非托管"
}
```

### 验签（Node.js）

```javascript
import { createHmac, timingSafeEqual } from "node:crypto";

// 必须用**原始 body 字符串**验签，不能先 JSON.parse 再 stringify。
function verify(rawBody, header, secret) {
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(header ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

### 投递语义（务必按此实现接收端）

| 事项       | 行为                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| 交付保证   | **at-least-once** —— 你必须按 `(id, event)` **幂等去重**                |
| 超时       | 5 秒。超时按瞬态失败处理                                                |
| 成功       | 任意 `2xx`                                                              |
| `4xx`      | **视为永久拒收，不再重试这一条**（返回 4xx 前请确认你真的不想要它）     |
| `5xx`/网络 | 瞬态失败，按投递循环节奏（30 秒）重试                                   |
| 熔断       | 连续失败 10 次自动停用该端点并通知运营者；恢复需要运营者重新登记        |
| 补发窗口   | `entry` 超过 6 小时未投出即放弃（旧信号推出去是误导）；`settle` 为 7 天 |
| 引擎停跳   | 投递整体冻结，一条不发（宁静默不误导）                                  |

接收端请**先返回 2xx 再做重活**：处理超过 5 秒会被判为瞬态失败并重发。

---

## 11. 公开端点（无需 key）

### `GET /api/record` — 已公开发布信号的战绩与存证

与 `/api/signals` 的 `recordByStrategy` **口径刻意不同**：这里的分母只含
**我们真的公开发布过**的信号（存在 `sent` 的 entry 投递记录），而
`recordByStrategy` 是该档的全量纸面履历。两个都诚实，但不可混用。

```typescript
interface RecordFeed {
  updatedAt: number;
  strategies: {
    id: number;
    name: string;
    source: string;
    pushedCount: number; // 已发布信号总数（含未结算）
    record: SignalRecord; // 已发布且已结算的 30d 战绩，量纲见 §6.4
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
  /** 存证链状态：最近一次日摘要的 UTC 日期与链尾哈希。 */
  digest: { day: string | null; tail: string | null };
}
```

`digest` 是每 UTC 日发布到公开频道的链式 sha256 摘要的**链尾**：昨日全部已
发布信号按 id 升序做 `sha256(前值|id|档位|市场|方向|发布时刻|入场价)`。第三方
可复算验证「先发布后结算、未删改」。

限流：每 IP 60 次/分钟，全站 300 次/分钟。超限返回 `429` +
`{ "strategies": [], "error": "rate limited — retry in a minute" }`。

### `GET /api/health` — 引擎存活探针

`200` = 全部循环在阈值内心跳；`503` = 有循环停跳或数据库打不开。

```typescript
interface HealthReport {
  ok: boolean;
  nowSec: number;
  loops: {
    loop: string;
    lastTs: number | null;
    ageSec: number | null;
    staleAfterSec: number;
    stale: boolean;
    missing?: true;
  }[];
  staleLoops: string[];
  reason?: string;
}
```

适合直接挂到你自己的 uptime 监控上。

---

## 12. 常见问题

**Q：`active` 是空的，是不是接错了？**
先看 `healthy`。为 `true` 且 `updatedAt` 是新鲜的，那就是这个窗口内确实没有
达标信号——把 `windowHours` 放大到 48 再看。

**Q：`strategies` 是空结构？**
两种可能：你的 key 订阅范围不含 `strategy`（§4），或运营者尚未放开任何档位
的推送。联系运营者确认。

**Q：`bus` 一直是空数组？**
总线各类型**默认关闭**，且开启后不回灌历史（§6.6）。联系运营者确认该类型
已开启，且阈值没有把所有事件都滤掉。

**Q：`implied` 是 1051.3，这是百分比吗？**
不是。`record30d` 全部五个字段都是**条数**量纲（§6.4）。`implied` 的意思是
「市场在同样价位下预期能中 1051.3 条」。

**Q：`recordByStrategy` 用档位名取值取不到？**
键是 strategy id 的字符串（`"6"`），档位名在 `.name` 里（§6.5）。

**Q：我的 key 什么时候会失效？**
只有运营者主动吊销时。吊销后立即返回 `401`，没有宽限期。挂在该 key 上的
webhook 端点同时失效。

**Q：能拿到历史数据吗？**
当前端点只提供滚动窗口（`active` / `bus` 最长 48 小时，`strategies.active`
固定 48 小时，`settled` 3 天）与 30 天聚合战绩，不提供任意历史区间查询。
公开战绩页 `/record` 提供人类可读的长期记录。

**Q：字段会变吗？**
只增不改。既有字段的名称与语义不会变更，新能力以新字段追加——你可以安全地
忽略未知字段。

---

## 13. 变更记录

| 日期       | 变更                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-08-18 | 失败响应补齐 `heavyMinUsd` 与 `staleLoops`，字段集合与成功响应完全一致（此前缺这两个字段，§6.1 的类型现在对两条路径都成立）                                                          |
| 2026-08-18 | 校准至当前实现：补 `bus[]` / webhook / 公开端点章节；修正 `record30d` 量纲（条数而非比率）与 `recordByStrategy` 键（strategy id 而非档名）；补齐全部字段的 TypeScript 类型与单位约定 |
| 2026-08-13 | 新增 `bus[]`（统一信号总线）与 key 的订阅范围过滤                                                                                                                                    |
| 2026-08-13 | 新增 webhook 推送、`/api/record` 公开战绩与每日存证链                                                                                                                                |
| 2026-08-13 | 新增 `strategies` 段与 `delayed` tier；`api_keys` 多租户鉴权                                                                                                                         |
