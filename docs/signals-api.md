# `GET /api/signals` — 信号 feed 接口契约

供 **mm-mobile 后端** 定时拉取，再由它缓存 + 鉴权后转给 App。

> **两份文档的分工**：本文是**内部契约**（设计取舍、口径修订史、为什么这样折叠），
> 读者是维护这个接口的人。对外发给订阅方的是 [`docs/api-access.md`](./api-access.md)
> （站内 `/api-docs`）——那份是**面向使用者**的完整字段表与类型定义，逐字段量纲、
> 全部端点、webhook 接收端实现要求都在那里。字段语义以那份为准，两份冲突时先改那份。

## 拓扑（重要）

```
whalewatch  ──1 次/分钟──▶  mm-mobile 后端  ──▶  App 客户端
（本服务）                  （缓存 + JWT）
```

**不要让 App 客户端直连本服务。** 本服务是单机 Next + SQLite 的研究服务，限流是进程内 Map，
不具备承接 App 流量的能力，也不需要——一个消费者每分钟拉一次是它本来就承受得住的负载。
这也是为什么接入这个 tab **不需要改本服务的架构**。

## 鉴权

服务器 `.env` 配置 `SIGNAL_FEED_TOKEN`，请求带其一即可：

```
x-feed-token: <token>
authorization: Bearer <token>
```

- 与 `ADMIN_TOKEN` **分开**：这个是只读的、放在合作方配置里，必须能独立吊销
- 公开部署下未配置 `SIGNAL_FEED_TOKEN` → `403`（fail closed，与写接口同一规则）
- 令牌错误/缺失 → `401`

## 请求

```
GET /api/signals?windowHours=24
```

| 参数          | 取值             | 默认 | 说明                                   |
| ------------- | ---------------- | ---- | -------------------------------------- |
| `windowHours` | 6 / 12 / 24 / 48 | 24   | 「进行中」列表的时间窗，非法值回落默认 |

服务端 30 秒缓存；**全部字段来自已持久化状态，零上游调用**，所以突发流量不会挤占引擎的 data-api 预算。

## 响应

```jsonc
{
  "updatedAt": 1785294147, // 服务端生成时刻（秒）
  "windowHours": 24,
  "heavyMinUsd": 50000, // 重仓门槛，客户端用于文案自解释
  "healthy": true, // false = 引擎有循环停跳，见下
  "staleLoops": [], // 停跳的循环名
  "active": [/* 见下 */],
  "settled": [/* 见下 */],
  "record30d": {
    "settled": 1799,
    "wins": 1066,
    "implied": 1051.3,
    "excess": 14.7,
    "sd": 19.3,
  },
}
```

### `active[]` — 进行中信号（已按「市场 × 方向」折叠）

```jsonc
{
  "key": "0xabc…|Yes", // 稳定标识，客户端去重用；split 时为 conditionId
  "kind": "consensus", // consensus | split | heavy
  "conditionId": "0xabc…",
  "title": "US announces halt in Iran offensive operations?",
  "slug": "us-announces-halt-market…", // 单市场 slug(2026-08-19 起,additive)
  "eventSlug": "us-announces-halt…",
  "category": "Politics", // 可能为 null
  // 二级分类(2026-08-13 起,additive —— 老客户端可安全忽略):体育联盟
  // (NBA/MLB/Soccer…)/加密资产(Bitcoin…)/Geopolitics 等,白名单派生;
  // 无二级或未知为 null。
  "subcategory": null,
  "formationTs": 1785291000,

  "outcome": "Yes", // split 时恒为 null —— 分歧不给方向
  "outcomeIndex": 0,
  "asset": "7201325…", // token id，客户端可用它订阅 CLOB WS 取实时价
  "walletCount": 3,
  "netUsd": 169830,
  "avgPrice": 0.61, // 他们的成本基准 —— 客户端据此算追高闸门
  "wallets": [{ "wallet": "0x…", "netUsd": 121400, "avgPrice": 0.6 }],

  "sides": [
    // 仅 split：两侧都在，一张卡渲染
    {
      "outcome": "Samsonova",
      "outcomeIndex": 0,
      "asset": "…",
      "walletCount": 2,
      "netUsd": 94400,
      "avgPrice": 0.43,
    },
    {
      "outcome": "Keys",
      "outcomeIndex": 1,
      "asset": "…",
      "walletCount": 2,
      "netUsd": 10918,
      "avgPrice": 0.58,
    },
  ],
}
```

**三种 kind 的定义与读法：**

| kind        | 规则                           | 交易者怎么读                              |
| ----------- | ------------------------------ | ----------------------------------------- |
| `consensus` | ≥2 个白名单钱包净买同一结果    | 最强方向信号                              |
| `split`     | 同一市场**两侧**都有白名单钱包 | **警告，不构成方向**；`outcome` 恒为 null |
| `heavy`     | 单个白名单钱包 ≥ `heavyMinUsd` | 单人观点，弱于共识                        |

**已在服务端处理好、客户端不必重做的事：**

- **按市场 × 方向折叠**：同一仓位的多笔成交只出一张卡（原始告警约 245 条/天 → 折叠后约 8–24 张）
- **共识升级合并**：保留最新金额，但 `formationTs` 是**最初**形成时刻（判断新鲜度用它）
- **双边合并**：绝不能拆成两张卡——「聪明钱看好 A」紧接「聪明钱看好 B」会让整页可信度崩塌
- **heavy 抑制**：同一市场 × 方向已有共识时不再出 heavy 卡
- **排序**：按 `formationTs` 倒序。客户端应按自己的相关性重排（自己的持仓优先）

### `settled[]` — 已结算（认账区）

2026-08-19 起**与 `active[]` 同构**：身份与仓位字段同名同义、取值逐字段相等
（有测试直接钉死这条不变量），消费方可用 `key` 把认账记录和自己缓存里的
active 条目对上号，也可复用同一个卡片渲染。差别只在末尾三项。

```jsonc
{
  // ↓ 与 active[] 完全同名同义（12 项，2026-08-19 补齐，全部 additive）
  "key": "0xabc…|Yes",
  "kind": "consensus",
  "conditionId": "0xabc…",
  "title": "…",
  "slug": "…",
  "eventSlug": "…",
  "category": "Sports",
  "subcategory": "NBA",
  "formationTs": 1785190000, // 信号**形成**时刻，不是结算时刻
  "outcome": "Yes",
  "outcomeIndex": 0,
  "asset": "7201…",
  "walletCount": 3,
  "netUsd": 169830,
  "wallets": [{ "wallet": "0x…", "netUsd": 121400, "avgPrice": 0.6 }],

  // ↓ 认账区独有
  "entryPrice": 0.73, // == active 的 avgPrice（同一个数，不放第二份）
  "won": true,
  "settledAt": 1785200000,
}
```

近 3 天，同一市场 × 方向只取最新一条，最多 20 条。

仓位口径按 kind 分流、与 `foldConsensus`/`foldHeavy` **逐字对齐**：两边算出
不同的金额，消费方对上号时就会看到「同一条信号金额变了」——`lib/signalFeed.test.ts`
里那条逐字段比对的测试守的就是这个。

> 同一条信号**可以同时出现在 `active` 与 `settled` 里**：前者按 `windowHours`
> 取窗口、不问是否结算，后者按结算时刻回看 3 天。同 `key` 时是同一笔仓位的
> 两个阶段，不是两条信号。

### `record30d` — 30 天价格调整战绩

| 字段      | 含义                                                              |
| --------- | ----------------------------------------------------------------- |
| `settled` | 已判定信号数（分母）                                              |
| `wins`    | 命中数                                                            |
| `implied` | **市场在同样价位下预期的命中数** = Σ 各信号自身赢面的市场隐含概率 |
| `excess`  | `wins - implied`，正数 = 跑赢市场自己的定价                       |
| `sd`      | 市场有效零假设下的标准差 = √Σp(1−p)                               |

> ⚠️ **口径修订（2026-08-04，同样的原始数据现在会算出不同的数字）**
>
> 1. **`implied` 按买卖方向取值**：BUY 记 `成交价`，SELL 记 `1 − 成交价`。SELL 的胜负判据是
>    「价格下跌」，市场对下跌的隐含概率是 `1 − p`。此前一律累加原始成交价，卖出侧的基准
>    符号是反的——10 笔 SELL@0.20 全归零（市场自己给 80% 概率的零优势结果）会算出
>    超额 +8.0 / 6.3σ 并被判为「已超运气范围」，修正后是 +2.0 / 1.58σ。
> 2. **同一次共识只计一次**：`consensus` 的 `dedup_key` 含钱包数，一个组 2→3→4 人会写三条
>    告警行。此前逐行计入，等于给「升级过的组」（恰恰是更强的组）加权，并破坏 `sd` 依赖的
>    独立性假设。现按 `(市场, 方向)` 折叠、保留形成时刻那一条。
>
> 消费方若缓存过旧值，修订前后的 `record30d` **不可直接比较**。

**展示铁律**（与推送尾行同源，`lib/signalRecord.ts` 的 `gradeRows` 是唯一实现）：

- **命中数旁边必须同时印出 `implied`**，否则 `1066/1799` 无从解读——它的基准是 58.4% 而不是 50%
- **`excess` 绝不能脱离噪音判定单独出现**：`|excess| ≥ 2×sd` 才可以说「已超运气范围」，否则必须写「仍在运气范围内」
- **禁止**任何「今日/昨日胜率」「连对 N 天」「分组冠军」——单日样本 95% 误差带 ±14pp，零技能下 30 天内有 73% 概率打印出一个 ≥65% 的「神日」

## `healthy: false` 时客户端必须做的事

引擎有循环停跳时本字段为 `false`（`staleLoops` 给出是哪个）。此时：

1. 顶部展示中断提示
2. **冻结时间戳**，把「3 分钟前」改成「截至 HH:MM」
3. **隐藏「去交易」等行动入口**——绝不能让用户对着旧价下单

这是「安静」和「死了」不长得一样的唯一保证。

## 现价从哪来

**不要用本接口取现价。** App 已直连 `ws-subscriptions-clob.polymarket.com`，用 `asset`（token id）订阅即可拿到毫秒级实时价。
本服务只提供**成本基准**（`avgPrice`）；追高闸门 = 客户端实时价 − `avgPrice`，红线 10¢（该阈值来自本项目纸面跟单的实测结论）。

## 错误行为

任何内部失败都返回 `200` + 结构完整的空 feed，并带 `healthy: false` 与 `error` 字段——
消费方**绝不会**把「服务挂了」误读成「今天没有信号」。

## 尚未产出的信号类型

- **拆单累计**（同钱包分散建仓）：引擎侧尚未产出告警，需要先做聚合
- **异动**（非白名单大额）：数据有（`large` 类型），但按产品决策默认不进 tab，需要时再开

---

## v2 增量（2026-08-13，对外信号批次 2 — 全部 additive，v1 消费方零感知）

### 鉴权升级：env token ∪ api_keys 多租户

- `SIGNAL_FEED_TOKEN`（env）继续有效，等价 **realtime** tier —— mm-mobile 不用改任何配置。
- 新增 `api_keys` 表签发的多租户 key（`wlk_` 前缀），单 key 可独立吊销：
  - 签发：`POST /api/admin/keys {"label":"订户A","tier":"realtime"|"delayed"}`（`x-admin-token`），明文只回显一次；或容器内 `npx tsx scripts/issue-key.ts <label> [tier]`。
  - 列表 / 吊销：`GET /api/admin/keys` / `DELETE /api/admin/keys?id=N`。
- fail-closed 语义保持：公开部署下 env token 与活跃 key 都不存在 → 403。

### tier 分层：延迟是唯一杠杆，字段不阉割

`tier='delayed'` 的 key 拿到的是「`SIGNAL_PUBLIC_DELAY_MIN`（默认 30）分钟前的世界」——
整个 feed（含下方 strategies 段）以 `now - delay` 为基准时刻构建：更晚出现的信号不可见、
更晚落地的结算仍显示为进行中。响应带 `delayedMin`（realtime 恒 0），`updatedAt` 是
**数据基准时刻**（时移后的），消费方展示"截至 HH:MM"应以它为准。
`healthy`/`staleLoops` 按**真实当下**评估 —— 引擎死没死不属于可延迟的信息。

### 新增 `strategies` 段（策略中心各档的买入/兑现动作）

> 档位数随种子演进：v2 写作时 13 档，`follow_seed_v=4`（2026-08-13 的 6 个反向
> 对照档）后为 19 档。消费方**不应把档位数写死**——`recordByStrategy` 的键就是
> 当前放开推送的全部档位。
>
> **`strategy.id` 同样不能写死**（下面示例里的 `6` 只是占位）。它是
> `follow_strategies` 的自增行号，而种子块按版本门控整体重播、`INSERT OR IGNORE`
> 命中 UNIQUE 时照样消耗自增号——于是每次 bump 都在 id 上打洞，同一档在
> 「全新安装的库」与「从早期版本升上来的库」里是不同数字。
>
> 认档请用 **`strategy.code`**（2026-08-21 新增）：ASCII、snake_case、每档
> 唯一且**冻结**，如 `mega_whale` / `inverse_mega_whale`。它刻意不从英文展示名
> 派生（那是文案，润色会误伤契约），映射表在 `lib/strategyCodes.ts`，golden
> 快照测试钉死。对外口径见
> [`api-access.md` §8.3](./api-access.md#-认档请用-code别用-id)。

```jsonc
"strategies": {
  "active": [
    // 近 48h 内触发、尚未结算的策略买入信号(只含运营已放开推送的档位)
    {
      "id": 123,                      // strategy_signals.id,稳定引用
      // id 是部署本地行号(占位);认档用 code
      "strategy": { "id": 6, "code": "whale_follow", "name": "巨鲸", "source": "heavy" },
      "conditionId": "0x…", "title": "…", "slug": "…", "eventSlug": "…",
      "category": "Sports", "subcategory": "NBA",   // 可 null
      "outcome": "Yes", "outcomeIndex": 0, "asset": "7201…",
      "formationTs": 1789299400,      // 信号成立时刻(detector 语义)
      "referencePrice": 0.61,         // 聪明钱成本基准
      "walletCount": 1, "totalNetUsd": 52000,
      "entryPrice": 0.63,             // 纸面入场价(现价口径)
      "sizeUsd": 500,
      "emittedAt": 1789299447         // 发布时刻(先发布后结算的存证锚点)
    }
  ],
  "settled": [ /* 近 3 天认账,最多 20 条,新在前:
    { id, strategyId, strategyCode, strategyName, conditionId, title, outcome,
      entryPrice, exitPrice, won, realizedPnl, settledAt } */ ],
  "events": [ /* 动作流(2026-08-31):买入(entry)与兑现(settle)一等对称,
    逐条 = webhook 的 SignalEventV1(同一 buildSignalEvent 构造,拉/推同构,
    幂等键同 (id, event))。entry 按 emittedAt、settle 按 settledTs 各 48h 窗,
    事件自身时刻倒序、同刻 settle 在前,无 LIMIT。active[] 在结算后把行撤走
    (状态视图),只轮询的消费方此前因此看不到兑现动作 —— 触发用这里,
    别用视图。对外口径见 api-access.md §8.4 */ ],
  "recordByStrategy": {
    "6": { "name": "巨鲸", "source": "heavy",
           "record": { "settled": 41, "wins": 26, "implied": 22.9,
                        "excess": 3.1, "sd": 3.4 } }
  }
}
```

**读法铁律（与 `record30d` 同源，`gradeRows` 唯一实现）**：`record` 的展示必须同时印
`implied`；`|excess| < 2×sd` 时必须写「仍在运气范围内」；`settled < 5` 标「样本不足」。
纸面口径提醒：`entryPrice`/`realizedPnl` 是模拟跟单数字（真实数据 · 模拟策略），
展示时必须携带「研究用途模拟信号 · 非投资建议」。

### 同一批信号的 TG 通道

同一张 `strategy_signals` 台账还扇出到两个 Telegram 频道（`TELEGRAM_SIGNAL_CHANNEL_ID`
付费实时 / 既有公开频道延迟 `SIGNAL_PUBLIC_DELAY_MIN` 分钟），投递记录在
`signal_deliveries`。API 与 TG 看到的是同一份事实，不存在两套口径。

### webhook 推送（批次 3，realtime tier 专属）

- 登记：`POST /api/admin/webhooks {"apiKeyId":N,"url":"https://…","secret":"≥16字符"}`（`x-admin-token`）；
  列表 `GET`（secret 不回显）；停用 `DELETE ?id=N`。仅 realtime tier 且未吊销的 key 可挂端点。
- 端点运维（同一 `POST`，带 `action` 字段；不带 `action` 即上面的登记，老契约不变）：
  - `{"action":"test","id":N}` —— 向端点投一条**连通性测试事件**：形状是合法 `SignalEventV1`
    （订户按真信号 schema 解析不会 4xx），但 `id` 与 `strategy.id` 为 `0`（真信号 id 自增从 1 起）、
    `strategy.code` 为 `null`（「连通性测试」不在 STRATEGY_CODE 里）、
    价格/金额/钱包数全为 `null`、`notice` 写明这不是信号请勿跟单，并额外带头 `X-Signal-Test: 1`。
    **订户侧建议按 `X-Signal-Test` 头或 `id===0` 直接丢弃。** 响应 `{ok,status,ms,detail}`
    恒为 HTTP 200（`ok` 才是结论）。测试是只读探针，不计入 `consecutive_failures`、不改 `active`。
  - `{"action":"enable","id":N}` —— 恢复投递，**一并清零 `consecutive_failures` 与 `last_error`**
    （熔断判定是 `>= 10`，不清零则下次失败立刻二次熔断）。key 已吊销或非 realtime 时拒绝（400）。
  - `{"action":"disable","id":N}` —— 停用，保留连败计数做投递史（等价于 `DELETE ?id=N`）。
  - `{"action":"delete","id":N}` —— **硬删**，secret 一并销毁不可恢复。
- 投递：每条信号一个 `SignalEventV1` JSON（`{v:1, id, event:"entry"|"settle", strategy, market,
signal, paper, record, settle, notice}`，zod schema 见 `lib/webhookDelivery.ts`），头部
  `X-Signature: sha256=<hex hmac-sha256(secret, body)>` + `X-Signal-Id` + `X-Signal-Event`。
- 语义：at-least-once —— 消费方必须按 `(id, event)` 幂等去重。5s 超时；4xx 视为拒收不再重试；
  网络/5xx 按投递循环节奏（30s）重试；连续失败 10 次自动熔断停用并通知运营者。

### 存证与公开战绩（批次 3）

- 每 UTC 日一条 🔏 存证消息发布到公开频道：昨日全部**已发布**信号按 id 升序的链式
  sha256 摘要（`sha256(前值|id|档位|市场|方向|发布时刻|入场价)`），链尾滚动存储 ——
  第三方可复算验证「先发布后结算、未删改」。
- `GET /api/record`（公开、限流自保）+ `/record` 页：各档**已发布**信号的 30d 价格调整
  战绩（分母只含发过的信号，与 /follow 的全量纸面履历刻意分开）、近期结算明细、存证链
  状态。

---

## v3 增量（2026-08-17 起，仍为 additive）

### 新增 `bus[]` — 统一信号总线

全站各类原始信号（`large` / `consensus` / `discovery`）投影进一张台账后随 feed 一起返回，
窗口跟随 `windowHours`，最多 200 条。**各类型默认全关**，由运营者在 `/manage` 逐类开启并设
阈值；开启后只投影此后 1 小时内的新事件，不回灌历史。v1/v2 消费方忽略该字段即可，行为零变化。

单条形状 = `lib/signalBus.ts` 的 `BusSignalSchema`（**唯一定义**，webhook 的 `BusEventV1.bus`
直接嵌它，有回归测试钉住两条路径同形）：

- 身份：`id` / `sourceType` / `dedupKey` / `conditionId` / `title` / `slug` / `eventSlug` /
  `category` / `subcategory`
- 方向：`outcome` / `outcomeIndex` / `asset`
- 金额：`netUsd` / `avgPrice` / `walletCount`
- 钱包：`wallets`（`{wallet, netUsd, avgPrice}[] | null`）
- `payload`：原始载荷原样保留 + `emittedAt`

2026-08-19 起顶层字段与 `active[]` 的 `Signal` **同名同义**（此前只有 6 个顶层字段 + 一个
形状随 `sourceType` 变的 `payload`：同一个「这笔多少钱」在 large 里叫 `usd`、consensus 里叫
`totalNetUsd`，消费方必须先分支才知道读哪个键；分类字段则完全没有）。归一是 additive ——
`payload` 一字未改，既有消费方零改动。

2026-08-21 补上 `wallets`（上一批停在了「谁买的」前面：视图早有明细，`bus[]` 只有一个
`walletCount` 数字）。`large` 由该笔成交合成单元素、`consensus` 取源告警的全量明细并保持
净买降序、`discovery` 恒 `null`（没有仓位）。同批把 `consensus` 的投影载荷从原样 spread
收成三字段白名单——`ConsensusWallet` 还带着 `score`/`winRate`/`buyCount`/`qualifiedTs`，
原样带走等于把内部类型的未来字段预先许诺给订阅方，而白名单挑选正是投影层存在的理由。

同日补上 `consensus` 的顶层 `avgPrice`。此前读取侧只认 `payload.price`，而 consensus 的
投影载荷从未写过任何价格字段——于是 `sourceType: "consensus"` 的事件 `avgPrice` **恒为
`null`**，`active[]` 那边却一直有值：「同名同义」在最关键的那一格上是断的，而
`avgPrice` 正是追高闸门的分母（见下方 §「不做实时价」）。现在投影带上源侧的组级
`avgBuyPrice`，顶层归一为 `avgPrice`，与 `active[]` 读同一个源字段。

⚠️ 该值是按份额 **USD 加权**（`totalNetUsd / Σ(netUsd / avgBuyPrice)`），不是 `wallets[]`
均价的算术平均——自行重算容易算成后者，两者能差近 1¢，而红线只有 10¢。请直接读顶层字段。
2026-08-21 之前入账的事件仍为 `null`（投影是一次性快照，读取侧补不出来），48h 窗口滚过
之后全量数据都齐。

## v4 增量（2026-08-21）—— 新增「按需查询」类端点

### `GET /api/market-card/{conditionId}` 市场深度卡

范围 `market`，`realtime` 专属。回答「用户正要下单，此刻这个市场长什么样」。

**它自成一类,不属于 `/api/signals` 命名空间。** 首版挂在 `/api/signals/market/` 下,
理由是鉴权可复用 `checkFeedAccess` —— 那是实现便利,不是分类判据。三个症状指向同一个
归类错误:接入文档不得不为它给「零上游调用」开特例(一个成员违反命名空间的定义性属性,
那不是例外,是归错类)、可授予范围清单被迫拆成两份(它塞不进「可推送的事件类型」)、
而按 §6 的判据它既不是信号(没有 id、不可推送)也不是视图(不是任何事件的折叠)。
2026-08-21 迁至 `/api/market-card/{cid}`,文档与 /manage 总览表同步补上第三类。

**它打破了本 API 迄今唯一的架构恒定式**：`/api/signals` 的一切安全性来自「零上游
调用」，突发流量永远挤不占引擎的 data-api 预算。深度卡恰恰相反——按需向 data-api
取成交窗口，且调用方**点名任意 conditionId**。曾考虑让引擎在信号成立时落快照、
API 纯本地读（与既有纪律一致），被否决：快照回答的是存证问题，而交易决策要的是
**此刻**，一张 40 分钟前的盘面回答不了「我现在该不该进」。

三条设计判断（详见 `docs/plans/2026-08-21-market-card-api-design.md`）：

1. **闸门计量「续抓次数」而非「请求次数」。** 既有 `guardExpensive` 限的是请求数
   N，而上游成本取决于去重后的市场数 M——窗口层已把同 cid 的并发合并成一次续抓，
   真正要命的是「三百个人各看一个不同市场」。限错维度的闸门拦得住免费的那种滥用，
   拦不住花钱的那种。
2. **新鲜度与容量不必零和。** 整窗重抓的浪费在于 24h 里只有最近一分钟是新的。
   改增量续抓（记住上次见到的最新成交时刻，`fetchMarketWindow` 会在
   `oldest < sinceSec` 时止页，于是第 0 页即止）后：冷启 1–13 请求、热续恒 1 请求。
   同样预算容量翻 8 倍，且落在更新鲜的档位上。
3. **预算从属引擎健康度。**「服务性能允许的范围」不是拍脑袋的常数：取所有循环里
   最坏的那个（`ageSec / staleAfterSec`），漂移过 60% 降到 25%，`staleLoops` 非空
   直接归零只发降级。引擎断更时继续取令牌是在加深故障——断更的原因很可能正是
   data-api 被挤爆。

落点：L1（窗口新鲜期）30s、硬陈旧闸 90s、预算 100 req/min、工作集 LRU 200 个市场，
稳态可服务约 50 个同时被盯着的市场（随预算线性可调）。

**没有第二层卡片缓存。** 贵的是窗口不是卡片：`composeMarketBrief` 是纯函数、告警
命中史是本地 SQL、钱包账龄永久缓存，拿陈旧窗口重算一张卡几乎不要钱。降级路径就是
「用陈旧窗口重算」，并把元信息抓取顶成只读缓存——一条声称「不再向上游要任何东西」
的路径上藏着网络调用，那个契约就是假的（哪怕 gamma 与 data-api 是不同 host）。

**陈旧闸是硬拒绝而非带标志照给。** 卡片说「3 个聪明钱刚买了 YES」，若其中 2 个已
卖出，那不是不够新，是错的，而且错在会让人亏钱的方向上。让客户端看 `staleSec` 自己
判断是不够的——客户端会为了不显示空白而照渲染。

网页 `/api/market/[cid]` 与 TG bot 走**同一个窗口层与同一个令牌桶**：上游预算本来
就是同一份，分两个桶只是把同一个天花板切成两半；而人在网页上看的热门市场正好也是
订阅方在看的，共享工作集是净收益。该路由自己的 60s promise cache 已删——两层缓存
叠在一起只会让「这张卡到底多新」多一个说不清的来源。

### 批次 2(2026-08-21):可观测、可调、抗重启

四项收尾,都是「上线之后运维要活得下去」而非新能力:

**令牌按实际页数计费(修的是缺陷)。** 令牌近似的是「向上游发了几个请求」,但冷启
和热续原本都只收 1 枚 —— 而冷启翻 1–13 页、热续恒 1 页。后果是进程刚重启、工作集
全空时,预算会被超出十几倍,恰好在最脆弱的时刻。页数由抓回行数反推(`ceil(len/250)`),
闸门先收 1 枚放行、抓完补收差额;补收结果忽略(钱已经花了,记账必须如实)。

**窗口落库(`market_window_cache`)。** 只为一件事:重启后不必把整个工作集重新冷启。
两条让它便宜的设计——存档**不必最新只要够近**(读回 5 分钟前的窗口,续抓下界就是那份
的 `newestTs`,补齐仍是一页),于是落盘可以按市场节流(每 5 分钟最多一次),写放大降
一个数量级;**超窗即失效**(比 24h 老的存档整个窗口都已滚出下界,读回来是骗人)。
清理放在引擎的共识循环里——存档表不受内存 LRU 约束,不清就随访问过的市场数无限涨,
而清理是运维动作,不该让某个倒霉的用户请求付这笔钱。

**四参数改 config 表(预算/新鲜期/陈旧闸/工作集上限)。** 走库而非环境变量:这些数
需要在观察到真实流量后调,每次调都要重新部署会让运营者干脆不调,而一个调不动的旋钮
等于没有旋钮。带夹取,并有一条跨字段不变式:`staleGateSec > windowTtlSec` —— 窗口要到
ttl 秒才触发续抓,届时 staleSec 已 >= ttl;闸门若更小,每次降级都立刻撞闸变 429,
「发一张标注年龄的旧卡」这条路就从来没被走过,是死代码。

**对外每钱包评分改分档(`scoreBand`)。** 理由是契约稳定性不是保密——原始分早已在无 key
的 `/api/market/[cid]` 上公开,只给对外端点打码是安全剧场。真正的问题是 raw score 是
模型输出、会随迭代漂移,写进对外契约等于承诺其语义永不变,于是每次调模型都成了破坏性
变更。内部面保持原始分。`winRate` 照给:它是实测统计不是模型输出。

`/manage` 的「🎯 市场深度卡」面板(下游管线 tab)给出五个计数(冷启/热续/命中/降级/
拒绝)+ 工作集与存档行数 + **此刻生效额度**。最后一项是关键:配置里的额度只是上限,
真正允许的由引擎健康度决定,只显示配置值会让运维在引擎喘不过气时看不懂「为什么
refused 在涨」。

### key 绑定订阅范围

签发 key 时可勾选类型（`strategy` / `large` / `consensus` / `discovery`）。**过滤在服务端
执行**：范围外的类型在 `/api/signals` 与 webhook 上都拿不到。未勾 = 不限（既有 key 与
env token 都是不限，语义不变）。

⚠️ 实现红线：`/api/signals` 的 30s 缓存键**必须**含订阅范围
（`feed:{窗口}:{tier}:{范围}`）。只按窗口 + tier 分片时，全量 key 的缓存会让受限 key 拿到
它无权看到的类型——这是越权泄露，不是少给数据。守卫测试见 `lib/feedScope.test.ts`。

### webhook 的范围分流（2026-08-19 已实现 bus 分流）

端点登记时逐端点勾选推送类型（`webhook_endpoints.bus_types`，NULL = 仅策略
信号的历史默认——与 api_keys 的「NULL = 全部」刻意相反，理由见 lib/db.ts 该列
迁移注释：存量端点突然收到陌生事件类型，消费方 4xx 会累计连败直至熔断）。
生效判定是 `webhookWantsType` = key 授权 ∧ 端点勾选（交集，登记时校验 + 运行时
兜底）。

两条投递轨并行于同一个 delivery 循环（30s）：

- **策略信号**：既有 `runDeliveryCycle`，端点过滤改为
  `webhookWantsType(ep, "strategy")`；
- **bus 事件**：`lib/busWebhook.ts` 的 `runBusWebhookCycle`，台账
  `bus_deliveries`（(bus_signal_id, channel) 主键，claim-then-send 照抄
  signal_deliveries）。三处刻意不同：不回灌（只投端点登记后的事件）、1h
  新鲜窗（对齐总线投影窗）、每端点每轮上限 10 条 + transient 即中断本端点
  本轮（端点不可达时不逐行吃 5s 超时）。事件体 `BusEventV1`
  （`event:"bus"`，`bus` 字段与拉取 API `bus[]` 单条同形），消费方幂等键
  仍是 `(id, event)`。熔断计数与策略投递共用。
