# `GET /api/signals` — 信号 feed 接口契约

供 **mm-mobile 后端** 定时拉取，再由它缓存 + 鉴权后转给 App。

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

```jsonc
{
  "title": "…",
  "outcome": "Yes",
  "kind": "consensus",
  "entryPrice": 0.73,
  "won": true,
  "settledAt": 1785200000,
}
```

近 3 天，同一市场 × 方向只取最新一条，最多 20 条。

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

### 新增 `strategies` 段（策略中心 13 档的买入触发）

```jsonc
"strategies": {
  "active": [
    // 近 48h 内触发、尚未结算的策略买入信号(只含运营已放开推送的档位)
    {
      "id": 123,                      // strategy_signals.id,稳定引用
      "strategy": { "id": 6, "name": "巨鲸", "source": "heavy" },
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
    { id, strategyId, strategyName, conditionId, title, outcome,
      entryPrice, exitPrice, won, realizedPnl, settledAt } */ ],
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
