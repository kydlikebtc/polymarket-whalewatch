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

| 类型        | 出现在响应的哪里                     | 当前状态          |
| ----------- | ------------------------------------ | ----------------- |
| `strategy`  | `strategies` 段 + webhook 推送       | ✅ 运行中（1 档） |
| `large`     | `bus[]` 中 `sourceType: "large"`     | ⛔ 未开启         |
| `consensus` | `bus[]` 中 `sourceType: "consensus"` | ⛔ 未开启         |
| `discovery` | `bus[]` 中 `sourceType: "discovery"` | ⛔ 未开启         |

- 未限定范围的 key = **不限**，拿全部类型。
- 若你的 key 不含 `strategy`，`strategies` 段会是**空结构**
  （`{"active":[],"settled":[],"recordByStrategy":{}}`），不是缺字段——形状
  始终一致，你的解析代码不必判空。
- 想调整范围，联系运营者重新签发。

> ⚠️ `active[]` / `settled[]` / `record30d`（§6.4–§6.6，v1 既有字段）**不受
> 订阅范围约束**，任何有效 key 都能拿到。范围只作用于 `strategies` 与 `bus`。

### 4.1 当前开放状态（截至 2026-08-19）

「你的 key 允许拿什么」和「服务端此刻真的在产出什么」是两件事。本节是后者的
**快照**——它会随运营者的开关变动，本文其余部分描述的是系统能力的全集。

| 能力                               | 当前状态                       | 你会看到                                     |
| ---------------------------------- | ------------------------------ | -------------------------------------------- |
| `active` / `settled` / `record30d` | ✅ 运行中                      | 正常数据                                     |
| `strategies`                       | ✅ 运行中，**仅 1 档对外发布** | 只有「激进」（`id=2`）的信号与战绩           |
| `bus[]`（三类）                    | ⛔ **均未开启**                | **恒为空数组 `[]`**                          |
| webhook                            | ✅ 可用                        | 需运营者为你的 key 登记端点（`realtime` 档） |
| 存证链                             | ✅ 运行中                      | `/api/record` 的 `digest` 每 UTC 日更新      |

**这意味着：**

- **`bus[]` 现在拿不到任何数据。** 三个类型在本部署里都没开启，`bus` 会
  一直是 `[]`。§6.8 描述的是它开启后的形态——现在不要为它写业务逻辑，也不要
  把空数组当成故障。想启用请联系运营者。
- **`strategies` 目前只有一档。** §6.7.2 列出的 19 档是**系统支持的全集**
  （它们都在跑纸面仓），但对外发布的档位由运营者逐档放开，当前只放开了
  「激进」。**请始终以 `recordByStrategy` 的键为准**遍历档位，不要按名录
  写死 19 档——放开更多档时你的代码应自动适配，不需要改。

---

## 5. 请求参数

`GET /api/signals`

| 参数          | 类型   | 取值                     | 默认 | 说明                                 |
| ------------- | ------ | ------------------------ | ---- | ------------------------------------ |
| `windowHours` | number | `6` / `12` / `24` / `48` | `24` | 时间窗。非法值静默回落默认值，不报错 |

`windowHours` 作用于 `active[]` 与 `bus[]`。**不影响** `strategies.active`
（固定 48 小时窗）、`settled`（固定 3 天）、`record30d`（固定 30 天）。

---

## 6. 信号体系与响应结构

### 6.1 信号体系总览

本服务对外输出**三条互不相同的信号线**。它们回答的问题不同、可信度不同、
在响应里的位置也不同——混着读是接入方最容易犯的错。

| 信号线           | 回答什么问题                               | 谁产生的                   | 在响应的哪里             | 订阅范围     |
| ---------------- | ------------------------------------------ | -------------------------- | ------------------------ | ------------ |
| **聪明钱动向**   | 「被我们盯上的那批钱包，此刻在买什么」     | 白名单钱包的真实成交       | `active[]` / `settled[]` | 任何有效 key |
| **策略买入信号** | 「我们的 19 档纸面策略，此刻触发了哪一笔」 | 我们的 detector + 纸面开仓 | `strategies` 段          | `strategy`   |
| **原始信号总线** | 「全站各类原始事件的流水」                 | 告警表 / 白名单池的投影    | `bus[]`                  | 逐类型       |

三者的关系：

- **聪明钱动向是原料，策略买入是成品。** `active[]` 告诉你「有 3 个聪明钱买了
  Yes」；`strategies` 告诉你「基于这件事，『保守』档在 0.63 建了一笔 $500 的
  纸面仓」。前者是观察，后者是**带纸面执行记录的决策**——因此只有后者有战绩。
- **总线是流水账，不是判断。** `bus[]` 里的 `large` 只说「有人砸了一笔大单」，
  不含任何「值得跟」的意思——大额成交里绝大多数是噪音（实测 notional < $25k
  占全部告警的 69%）。
- **不要把三条线的数字相加。** 同一笔市场行为可能同时出现在 `active[]`、
  多个档位的 `strategies.active[]` 和 `bus[]` 里。它们是同一件事的三种视角，
  不是三件事。

> ⚠️ **战绩只属于策略线。** `record30d` 是聪明钱动向的战绩，
> `recordByStrategy` 是各档策略的战绩，两者口径不同、**不可比也不可加**。
> 详见 §6.6 与 §6.7.4。

### 6.2 通用数据格式约定

| 约定      | 说明                                                                      |
| --------- | ------------------------------------------------------------------------- |
| 时间戳    | **unix 秒**（整数，UTC）。不是毫秒                                        |
| 价格      | `0`–`1` 的小数 = 该结果的市场隐含概率，也是每份合约的 USDC 价格           |
| 金额      | **USD**（数值，非字符串，未做千分位格式化）                               |
| 百分比    | 除非字段名带 `Pct`，否则一律不是百分比。`record` 五件套是**条数**（§6.6） |
| `null`    | 「该字段对这条记录不适用或未知」。字段本身不会消失（§7 的失败响应亦然）   |
| 字符串 ID | `conditionId` = `0x…` 市场 ID；`asset` = CLOB token id（十进制字符串）    |
| 数组      | 无数据时是 `[]`，不是 `null`                                              |
| 排序      | 各列表均为**新在前**（按各自的时间字段倒序）                              |
| 未知字段  | 只增不改，遇到不认识的字段请忽略，不要报错                                |

**贯穿全文的三个时刻**，务必分清——它们经常相差几十秒到几分钟：

| 字段          | 中文名   | 是什么时刻                                                        |
| ------------- | -------- | ----------------------------------------------------------------- |
| `formationTs` | 形成时刻 | **信号在客观世界成立**的那一刻（第 N 个钱包到位／那一笔成交发生） |
| `emittedAt`   | 发布时刻 | **我们检测到并发布**的那一刻。存证锚点（先发布后结算）            |
| `updatedAt`   | 构建时刻 | 本次响应的数据基准时刻（延迟档已时移）                            |

`emittedAt − formationTs` = **本系统的检测延迟**。公开这个差值是刻意的：
它让你自己判断「跟这个信号还来不来得及」，而不是听我们说来得及。

### 6.3 顶层字段

```jsonc
{
  "updatedAt": 1755412800, // number   本次数据的构建基准时刻（延迟层已时移）
  "windowHours": 24, // number   实际生效的窗口
  "heavyMinUsd": 50000, // number   单钱包「大额」口径阈值，恒 50000
  "delayedMin": 0, // number   0 = realtime；30 = 延迟 30 分钟
  "healthy": true, // boolean  引擎健康位（永远按真实时间评估）
  "staleLoops": [], // string[] 停跳的循环名；healthy=false 时非空

  "active": [/* §6.4 */],
  "settled": [/* §6.5 */],
  "record30d": {/* §6.6 */},
  "strategies": {/* §6.7 */},
  "bus": [/* §6.8 */],
}
```

| 字段          | 类型              | 中文名       | 含义                                                                   |
| ------------- | ----------------- | ------------ | ---------------------------------------------------------------------- |
| `updatedAt`   | number            | 数据基准时刻 | 本次响应对应的世界时刻。延迟档是**已时移**的值，展示「截至 HH:MM」用它 |
| `windowHours` | number            | 生效窗口     | 实际采用的小时数（非法入参已回落为 24）                                |
| `heavyMinUsd` | number            | 大额门槛     | 单钱包单笔达到多少算 `heavy`，恒为 `50000`。给你做文案自解释用         |
| `delayedMin`  | number            | 延迟分钟数   | `0` = 实时档；`30` = 你看到的是 30 分钟前的世界                        |
| `healthy`     | boolean           | 引擎健康位   | `false` = 有循环停跳。**永远按真实时间评估**，不受延迟档影响           |
| `staleLoops`  | string[]          | 停跳循环名   | `healthy=false` 时非空。取值见下表                                     |
| `active`      | `Signal[]`        | 进行中动向   | 窗口内的聪明钱动向，§6.4                                               |
| `settled`     | `SettledSignal[]` | 已结算动向   | 近 3 天已出结果的动向，§6.5                                            |
| `record30d`   | `SignalRecord`    | 30 天战绩    | 聪明钱动向的价格调整战绩，§6.6                                         |
| `strategies`  | `StrategyFeed`    | 策略段       | 19 档策略的买入信号与战绩，§6.7                                        |
| `bus`         | `BusSignal[]`     | 信号总线     | 原始事件流水，§6.8                                                     |
| `error`       | string（可选）    | 异常信息     | **仅**服务端内部异常时出现，§7                                         |

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

`staleLoops` 的可能取值（引擎的四个循环）：

| 循环名             | 中文名          | 正常节奏   | 停跳意味着                                 |
| ------------------ | --------------- | ---------- | ------------------------------------------ |
| `alert`            | 大额成交告警    | 每 4 秒    | 新成交不再进入系统，整个 feed 会冻住       |
| `consensus`        | 共识检测 + 跟单 | 每 5 分钟  | 共识信号与策略买入停止产生                 |
| `outcome_backfill` | 结算回填        | 每 10 分钟 | 战绩停在旧数字（`settled` 不再增长）       |
| `delivery`         | 对外投递        | 每 30 秒   | webhook / 频道收不到新信号（拉取不受影响） |

### 6.4 `active[]` — 聪明钱动向

窗口内、已按「市场 × 方向」折叠的白名单钱包动向。原始告警约 245 条/天，
折叠后约 8–24 条——**折叠已在服务端做完，你不必再做**。

#### 什么是「白名单钱包」

不是「交易额大的钱包」，而是通过**准入闸**的钱包。两条路任选其一：

| 准入路径     | 判据                                               |
| ------------ | -------------------------------------------------- |
| 胜率路径     | 已结算 ≥ 10 笔 **且** 胜率 ≥ 55% **且** 净盈利 > 0 |
| 资金效率路径 | 已结算 ≥ 5 笔 **且** ROI ≥ 5% **且** 净盈利 > 0    |
| 直接豁免     | 官方全球盈利榜 top-100（榜单本身即门槛）           |

被判定为做市机器人的钱包一律拒入。「高胜率但账面亏损」会被挡住——那是
「小赢多次、大亏一次」的典型形态（实测抓到过：胜率 58%、净 −$87k）。

#### 三种 `kind` 的完整判据

| kind        | 中文名     | 判据                                                            | 方向性     | 交易者怎么读               |
| ----------- | ---------- | --------------------------------------------------------------- | ---------- | -------------------------- |
| `consensus` | 聪明钱共识 | ≥2 个白名单钱包在窗口内**净买同一个结果**，且每个的净买额都达标 | 有方向     | 本 feed 里最强的方向信号   |
| `split`     | 聪明钱分歧 | 同一市场的**两个对立结果上都有**白名单钱包                      | **无方向** | **警告**：聪明钱内部没谈拢 |
| `heavy`     | 单笔巨额   | **单个**白名单钱包**单笔** BUY 名义额 ≥ `heavyMinUsd`（$50k）   | 有方向     | 一个人的观点，弱于共识     |

关于 `split` 的说明值得单独读一遍：它**故意不被拆成两条 consensus**。
「聪明钱看好 A」紧接着「聪明钱看好 B」会让整页可信度瞬间崩塌，而这不是
假设——线上真实样本里出现过一场 WTA 比赛一边 $94,400、另一边 $10,918。
所以 `split` 的 `outcome` 恒为 `null`，两侧数据放在 `sides` 里，**请渲染成
一张卡**。

#### 服务端已经做完的事

- **按市场 × 方向折叠**：同一仓位的多笔成交只出一条
- **共识升级合并**：3 人变 4 人时保留最新金额，但 `formationTs` 仍是**最初**
  形成时刻——判断新鲜度必须用它，不能用「最后一笔成交时间」（后者会被组内
  任何一笔白名单成交刷新，能把 5 小时前的老共识「续命」成新鲜的）
- **双边合并**：`split` 只出一条
- **heavy 抑制**：同一市场 × 方向已有 `consensus` 时不再出 `heavy`（一个市场
  不占两张卡）
- **排序**：按 `formationTs` 倒序

#### 字段详解

| 字段           | 类型                   | 中文名   | 含义                                                                        |
| -------------- | ---------------------- | -------- | --------------------------------------------------------------------------- |
| `key`          | string                 | 去重键   | 稳定标识。有方向时 `<conditionId>\|<outcome>`；`split` 时就是 `conditionId` |
| `kind`         | `SignalKind`           | 信号种类 | `consensus` / `split` / `heavy`，见上表                                     |
| `conditionId`  | string                 | 市场 ID  | Polymarket 的 `0x…` 市场标识                                                |
| `title`        | string                 | 市场问题 | 原文（英文），如 `Chiefs win Super Bowl LX?`                                |
| `eventSlug`    | string                 | 事件短名 | 拼 Polymarket 事件页 URL 用                                                 |
| `category`     | string \| null         | 一级分类 | 如 `Politics` / `Sports` / `Crypto`；未知为 `null`                          |
| `subcategory`  | string \| null         | 二级分类 | 体育联盟或加密资产，如 `NBA` / `Bitcoin`；无或未知为 `null`                 |
| `formationTs`  | number                 | 形成时刻 | 共识：第 N 个合格钱包到位那一刻；heavy：那一笔成交的时间                    |
| `outcome`      | string \| null         | 方向     | 买的是哪个结果，如 `Yes`。**`split` 恒为 `null`**                           |
| `outcomeIndex` | number \| null         | 方向序号 | 该结果在市场里的下标（0 / 1 …）                                             |
| `asset`        | string \| null         | 代币 ID  | CLOB token id。**用它订阅实时价**（§9）                                     |
| `walletCount`  | number                 | 钱包数   | 参与的白名单钱包个数。`split` 时是两侧之和                                  |
| `netUsd`       | number                 | 净买入额 | USD。净额口径（买减卖），非成交总额。`split` 时是两侧之和                   |
| `avgPrice`     | number                 | 成本基准 | 他们的加权买入均价。**`split` 恒为 `0`**（无方向即无单一成本）              |
| `wallets`      | `SignalWallet[]`       | 钱包明细 | 按 `netUsd` 降序                                                            |
| `sides`        | `SignalSide[]`（可选） | 双边明细 | **仅 `split` 存在**，其余 kind 该字段不出现                                 |

`wallets[]` 单条：

| 字段       | 类型   | 中文名     | 含义                     |
| ---------- | ------ | ---------- | ------------------------ |
| `wallet`   | string | 钱包地址   | `0x…` 小写               |
| `netUsd`   | number | 该钱包净买 | USD                      |
| `avgPrice` | number | 该钱包成本 | 该钱包自己的加权买入均价 |

`sides[]` 单条（仅 `split`）：

| 字段           | 类型           | 中文名     | 含义             |
| -------------- | -------------- | ---------- | ---------------- |
| `outcome`      | string         | 该侧方向   | 如 `Samsonova`   |
| `outcomeIndex` | number \| null | 该侧序号   | —                |
| `asset`        | string \| null | 该侧代币   | CLOB token id    |
| `walletCount`  | number         | 该侧钱包数 | —                |
| `netUsd`       | number         | 该侧净买   | USD              |
| `avgPrice`     | number         | 该侧成本   | 该侧加权买入均价 |

```typescript
type SignalKind = "consensus" | "split" | "heavy";

interface Signal {
  key: string;
  kind: SignalKind;
  conditionId: string;
  title: string;
  eventSlug: string;
  category: string | null;
  subcategory: string | null;
  formationTs: number;
  outcome: string | null;
  outcomeIndex: number | null;
  asset: string | null;
  walletCount: number;
  netUsd: number;
  avgPrice: number;
  wallets: SignalWallet[];
  sides?: SignalSide[];
}

interface SignalWallet {
  wallet: string;
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

### 6.5 `settled[]` — 已结算的聪明钱动向（认账区）

近 **3 天**，同一市场 × 方向只取最新一条，**最多 20 条**。

| 字段         | 类型         | 中文名   | 含义                                                            |
| ------------ | ------------ | -------- | --------------------------------------------------------------- |
| `title`      | string       | 市场问题 | —                                                               |
| `outcome`    | string       | 方向     | 当初看好的那个结果                                              |
| `kind`       | `SignalKind` | 信号种类 | 这里只会是 `consensus` 或 `heavy`（`split` 无方向，无从判对错） |
| `entryPrice` | number       | 进场价   | 当初的成交价或共识加权均价（`0`–`1`）                           |
| `won`        | boolean      | 是否命中 | 该方向最终是否成真                                              |
| `settledAt`  | number       | 结算时刻 | unix 秒                                                         |

```typescript
interface SettledSignal {
  title: string;
  outcome: string;
  kind: SignalKind;
  entryPrice: number;
  won: boolean;
  settledAt: number;
}
```

### 6.6 `record30d` — 30 天价格调整战绩

⚠️ **这五个字段全是「条数」量纲，不是百分比。** 把 `implied` 当胜率渲染是
最常见的接入错误。

| 字段      | 类型   | 中文名           | 含义                                                          |
| --------- | ------ | ---------------- | ------------------------------------------------------------- |
| `settled` | number | 已判定条数       | 分母。已出结果的信号条数                                      |
| `wins`    | number | 命中条数         | 分子                                                          |
| `implied` | number | 市场预期命中条数 | **市场在同样价位下预期能中几条** = Σ 各信号自身赢面的隐含概率 |
| `excess`  | number | 超额条数         | `wins − implied`。正数 = 跑赢了市场自己的定价                 |
| `sd`      | number | 噪音标准差       | `√Σ p(1−p)`。判断 `excess` 是否显著的唯一尺子                 |

```typescript
interface SignalRecord {
  settled: number;
  wins: number;
  implied: number;
  excess: number;
  sd: number;
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

**为什么不用胜率？** 因为 1066/1799（59.3%）本身说明不了任何事——如果这些
信号的平均进场价就是 0.584，那么市场自己也预期能中 58.4%，我们只多中了
14.7 条，而噪音的标准差是 19.3 条。**这个战绩落在运气范围内**。只印
「胜率 59.3%」会让读者以为看到了 edge。

`implied` 按买卖方向取值：BUY 记 `成交价`，SELL 记 `1 − 成交价`（SELL 的
胜负判据是价格下跌，市场对下跌的隐含概率是 `1 − p`）。同一次共识只计一次
（按「市场 × 方向」折叠，保留形成时刻那一条）。

**展示铁律**（与推送尾行同源，服务端 `gradeRows` 是唯一实现）：

- **命中数旁边必须同时印出 `implied`**，否则 `1066/1799` 无从解读
- **`excess` 绝不能脱离噪音判定单独出现**：`|excess| ≥ 2 × sd` 才可以说
  「已超运气范围」，否则必须写「仍在运气范围内」
- **`settled < 5` 必须标「样本不足」**
- **禁止**任何「今日/昨日胜率」「连对 N 天」「分组冠军」——单日样本 95%
  误差带 ±14pp，零技能下 30 天内有 73% 概率打印出一个 ≥65% 的「神日」

数据口径：近 30 天 `consensus` / `smart` 两类告警中**已有结算判定**的那些；
无成交价的行两侧都不计入。

### 6.7 `strategies` — 策略中心的买入信号

需要 key 的订阅范围包含 `strategy`，否则是空结构。

**只包含运营者已放开推送的档位** —— 截至 2026-08-19 只有「激进」（`id=2`）
一档，见 §4.1。**遍历档位请用 `recordByStrategy` 的键**，不要按 §6.7.2 的
名录写死档数：放开更多档时你的代码应当自动适配。

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

#### 6.7.1 六个检测器族（`strategy.source`）

每档策略属于一个检测器族。族决定了**在看什么现象**，档位参数决定了**门槛
多高**。

| `source`       | 中文名     | 在检测什么                                                       | `formationTs` 的语义          | `referencePrice` 的语义 |
| -------------- | ---------- | ---------------------------------------------------------------- | ----------------------------- | ----------------------- |
| `consensus`    | 多钱包共识 | N 个白名单钱包在窗口内净买同一结果                               | 第 N 个合格钱包跨过门槛那一刻 | 多钱包加权买入均价      |
| `heavy`        | 单笔巨额   | 单个白名单钱包单笔 BUY 名义额达标——**这一笔本身就是信号**        | 那一笔成交的时间              | 那一笔的成交价          |
| `lopsided`     | 一边倒分歧 | 市场有分歧，但主导边质量加权占比 ≥ 70%（分歧里混进了零星反对票） | 倾斜首次跨过 70% 那一刻       | 所跟那一边的加权均价    |
| `resolved`     | 分歧解除   | 原本两边都有聪明钱，**少数边开始净卖**——有人认输了               | 认输被识别的那一轮            | 主导边加权均价          |
| `lone_wolf`    | 高分独狼   | 单个**高评分**钱包对某方向的净买达标                             | 净买跨过门槛那一刻            | 该钱包加权买入均价      |
| `early_winner` | 早期赢家   | 单个**早期赢家渠道**钱包的净买达标                               | 净买跨过门槛那一刻            | 该钱包加权买入均价      |

三条容易踩的关系：

- **`consensus` 与 `lopsided` 互补不重叠。** 有分歧的市场会被整体剔出
  `consensus`；其中一边倒的那些再由 `lopsided` 捞回来跟主导边。真正势均力敌
  的市场两族都不跟——那种市场本身就没有「聪明钱赢下了这场分歧」的答案。
- **`heavy` 与 `lone_wolf` 看的不是一回事。** `heavy` 看**单笔金额**（一笔
  巨额本身即信号，不问钱包是谁）；`lone_wolf` 看**钱包质量**（同样的净买额，
  出自 score 90 的钱包才算数）。
- **`resolved` 的「认输」有严格判据**，不是简单的「在卖」：必须净回收资金
  （卖出额 > 买入额），**并且**要么窗口内零买入的全清仓，要么卖均价 < 买均价。
  第二个条件专门把「赚钱止盈」挡在外面——止盈不是认输。

#### 6.7.2 19 档名录

「反向档」= 检测参数与被镜像的正向档**逐字节相同**，只在开仓时买**相反**
的边。它们是对照组：如果正向档真有 edge，反向档就该系统性地亏。

| #   | 档名         | `source`       | 触发条件                                                   | 反向 | 当前对外 |
| --- | ------------ | -------------- | ---------------------------------------------------------- | ---- | -------- |
| 1   | 保守         | `consensus`    | ≥3 个钱包，每个净买 ≥ $10,000                              | —    | —        |
| 2   | 激进         | `consensus`    | ≥2 个钱包，每个净买 ≥ $5,000                               | —    | ✅       |
| 3   | 精英共识     | `consensus`    | ≥2 个钱包（**仅 score ≥ 80 的计入**），每个 ≥ $5,000       | —    | —        |
| 4   | 重仓共识     | `consensus`    | ≥2 个钱包且**总净买 ≥ $100,000**（看总额不看人数）         | —    | —        |
| 5   | 首发共识     | `consensus`    | ≥3 个钱包每个 ≥ $10,000，且**信号形成 ≤ 300 秒**（抢新鲜） | —    | —        |
| 6   | 巨鲸         | `heavy`        | 单笔 BUY ≥ $50,000                                         | —    | —        |
| 7   | 超级巨鲸     | `heavy`        | 单笔 BUY ≥ $150,000                                        | —    | —        |
| 8   | 巨鲸精英     | `heavy`        | 单笔 BUY ≥ $50,000 **且**钱包 score ≥ 80                   | —    | —        |
| 9   | 一边倒分歧   | `lopsided`     | 主导边占比 ≥ 70%，跟**主导边**                             | —    | —        |
| 10  | 分歧解除     | `resolved`     | 少数边认输，跟主导边                                       | —    | —        |
| 11  | 高分独狼     | `lone_wolf`    | 单钱包 score ≥ 90 **且**净买 ≥ $10,000                     | —    | —        |
| 12  | 早期赢家跟投 | `early_winner` | 早期赢家渠道钱包净买 ≥ $5,000                              | —    | —        |
| 13  | 逆势少数边   | `lopsided`     | 同第 9 档的市场，但跟**少数边**                            | 对照 | —        |
| 14  | 反巨鲸       | `heavy`        | 同第 6 档，买相反边                                        | ✓    | —        |
| 15  | 反超级巨鲸   | `heavy`        | 同第 7 档，买相反边                                        | ✓    | —        |
| 16  | 反巨鲸精英   | `heavy`        | 同第 8 档，买相反边                                        | ✓    | —        |
| 17  | 反分歧解除   | `resolved`     | 同第 10 档，买相反边                                       | ✓    | —        |
| 18  | 反高分独狼   | `lone_wolf`    | 同第 11 档，买相反边                                       | ✓    | —        |
| 19  | 反早期赢家   | `early_winner` | 同第 12 档，买相反边                                       | ✓    | —        |

> **「当前对外」列是 2026-08-19 的快照**（见 §4.1）：19 档都在跑纸面仓，但
> 只有标 ✅ 的档位会把信号发给订阅方。以 `recordByStrategy` 的键为准遍历。
>
> `#` 是标准部署下的种子顺序，通常与 `strategy.id` 一致，但**不要写死**——
> 请以响应里的 `strategy.id` 与 `recordByStrategy` 的键为准。运营者可随时
> 增删档位或调整推送开关。

所有档位共用的默认执行参数：

| 参数                     | 中文名     | 默认值       | 含义                                         |
| ------------------------ | ---------- | ------------ | -------------------------------------------- |
| `sizeUsd`                | 纸面下注额 | `500`        | 每笔模拟买入的金额                           |
| `exitRule`               | 退出规则   | `settlement` | 持有到市场结算，不中途止盈止损               |
| `maxEntryDeviationCents` | 追价护栏   | `10`（¢）    | 现价比聪明钱成本贵超过 10¢ 就**不开仓**      |
| `maxPrice`               | 最高进场价 | `0.95`       | 高于此价不开仓（结算清扫单信息量≈0）         |
| `freshSec`               | 新鲜度闸门 | `900`（秒）  | 信号形成超过这么久就不再跟（首发共识为 300） |

> ⚠️ **各档持仓会重叠，战绩不可相加。** `heavy` 族刻意**不**继承展示层
> 「共识已覆盖就抑制」那条规则——抑制掉会让 `heavy` 只在共识失败的市场取样，
> 样本被系统性偏置。代价就是同一个市场可能同时出现在多个档的 `active` 里。
> 把各档 `record.settled` 相加会得到一个偏大的、无意义的分母。

#### 6.7.3 `strategies.active[]` — 近 48 小时触发、尚未结算

窗口固定 **48 小时**，不随 `windowHours` 变化。

| 字段              | 类型           | 中文名     | 含义                                                       |
| ----------------- | -------------- | ---------- | ---------------------------------------------------------- |
| `id`              | number         | 信号 ID    | 台账主键。**webhook 去重键的一半**（另一半是 `event`）     |
| `strategy.id`     | number         | 档位 ID    | 用它做分组，不要用档名                                     |
| `strategy.name`   | string         | 档位名     | 如 `巨鲸`。运营者可改名，不要当主键                        |
| `strategy.source` | string         | 检测器族   | 见 §6.7.1                                                  |
| `conditionId`     | string         | 市场 ID    | —                                                          |
| `title`           | string         | 市场问题   | 原文（英文）                                               |
| `slug`            | string         | 市场短名   | 拼**单市场**页 URL 用                                      |
| `eventSlug`       | string         | 事件短名   | 拼**事件**页 URL 用                                        |
| `category`        | string \| null | 一级分类   | —                                                          |
| `subcategory`     | string \| null | 二级分类   | —                                                          |
| `outcome`         | string         | 买入方向   | 反向档这里已经是**翻转后**的方向（即我们真正买的那一边）   |
| `outcomeIndex`    | number \| null | 方向序号   | —                                                          |
| `asset`           | string \| null | 代币 ID    | CLOB token id                                              |
| `formationTs`     | number         | 形成时刻   | 语义随 `source` 而变，见 §6.7.1                            |
| `referencePrice`  | number \| null | 聪明钱成本 | 我们跟的那批钱的成本基准                                   |
| `walletCount`     | number \| null | 钱包数     | 触发这条信号的钱包个数（`heavy` 恒为 1）                   |
| `totalNetUsd`     | number \| null | 总净买额   | USD                                                        |
| `entryPrice`      | number \| null | 纸面进场价 | **我们的**模拟买入价（信号发出那一刻的现价），非聪明钱均价 |
| `sizeUsd`         | number \| null | 纸面下注额 | USD，默认 500                                              |
| `emittedAt`       | number         | 发布时刻   | 存证锚点。`emittedAt − formationTs` = 检测延迟             |

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

两个必须自己算的派生量：

- **检测延迟** = `emittedAt − formationTs`。判断「还来不来得及跟」。
- **追价成本** = `entryPrice − referencePrice`（正数 = 比聪明钱买贵了）。
  本项目实测红线 10¢。

#### 6.7.4 `strategies.settled[]` 与 `recordByStrategy`

`settled[]`：近 3 天认账，最多 20 条。

| 字段           | 类型            | 中文名     | 含义                                |
| -------------- | --------------- | ---------- | ----------------------------------- |
| `id`           | number          | 信号 ID    | 与 `active[].id` 同一台账           |
| `strategyId`   | number          | 档位 ID    | —                                   |
| `strategyName` | string          | 档位名     | —                                   |
| `conditionId`  | string          | 市场 ID    | —                                   |
| `title`        | string          | 市场问题   | —                                   |
| `outcome`      | string          | 买入方向   | —                                   |
| `entryPrice`   | number \| null  | 进场价     | 纸面                                |
| `exitPrice`    | number \| null  | 退出价     | 结算价（`0` 或 `1`）                |
| `won`          | boolean \| null | 是否盈利   | **`null` = 平局**，不进任何胜率分母 |
| `realizedPnl`  | number \| null  | 已实现盈亏 | USD，纸面                           |
| `settledAt`    | number          | 结算时刻   | unix 秒                             |

`recordByStrategy`：**键是 strategy id 的字符串**（`"6"`），不是档位名。

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

- 覆盖所有已放开推送的档位，**包括本窗口没有任何 active 信号的档**。
- `record` 的字段量纲同 §6.6，展示铁律同样适用。
- 口径：该档**全部纸面履历**近 30 天已结算的仓位（不只是公开发布过的那些）。
  只统计已公开发布信号的战绩请用 `/api/record`（§11）。

**纸面口径提醒**：`entryPrice` / `realizedPnl` / `record` 是模拟跟单数字
（真实数据 · 模拟策略）。展示时必须携带
**「研究用途模拟信号 · 非投资建议 · 只读非托管」**。

### 6.8 `bus[]` — 统一信号总线

> ⛔ **本节描述的是未来形态，当前拿不到数据。** 截至 2026-08-19，本部署的
> 三个总线类型**都没有开启**，`bus` 恒为 `[]`（见 §4.1）。请**不要**现在就
> 为它写业务逻辑，也不要把空数组当成故障。想启用请联系运营者——启用后本节
> 描述的形态即刻生效，字段不会变。

全站各类**原始事件**的台账投影——流水账，不是判断。需要 key 的订阅范围
包含对应类型。

窗口 = `windowHours`，按 `emittedAt` 倒序，**最多 200 条**。

| 字段          | 类型           | 中文名   | 含义                                                |
| ------------- | -------------- | -------- | --------------------------------------------------- |
| `id`          | number         | 台账 ID  | 自增主键                                            |
| `sourceType`  | string         | 事件类型 | `large` / `consensus` / `discovery`                 |
| `dedupKey`    | string         | 幂等键   | 同一事件重复投影时不变，用它去重                    |
| `conditionId` | string \| null | 市场 ID  | `discovery` 类型恒为 `null`（它讲的是钱包不是市场） |
| `title`       | string \| null | 市场问题 | 同上，`discovery` 恒为 `null`                       |
| `payload`     | object         | 载荷     | **形状随 `sourceType` 而定**，见下                  |
| `emittedAt`   | number         | 事件时刻 | unix 秒                                             |

```typescript
interface BusSignal {
  id: number;
  sourceType: "large" | "consensus" | "discovery";
  dedupKey: string;
  conditionId: string | null;
  title: string | null;
  payload: Record<string, unknown>;
  emittedAt: number;
}
```

#### `sourceType: "large"` — 大额成交

单笔成交名义额达到运营者设定的阈值（默认 $100,000）即入总线。
`dedupKey` 形如 `alert:<告警 id>`。

| `payload` 字段 | 类型                        | 中文名   | 含义               |
| -------------- | --------------------------- | -------- | ------------------ |
| `usd`          | number                      | 名义额   | `数量 × 价格`，USD |
| `side`         | `"BUY"` \| `"SELL"` \| null | 买卖方向 | —                  |
| `outcome`      | string \| null              | 结果方向 | 买的是哪一边       |
| `price`        | number                      | 成交价   | `0`–`1`            |
| `wallet`       | string \| null              | 钱包地址 | 成交者的代理钱包   |
| `slug`         | string \| null              | 市场短名 | —                  |
| `eventSlug`    | string \| null              | 事件短名 | —                  |

> **大额 ≠ 聪明。** 本项目的 edge 体检已经证伪了「金额大 = 聪明钱」这个假设。
> `large` 是流水，不带任何方向建议——真正带判断的是 `active[]` 与 `strategies`。

#### `sourceType: "consensus"` — 聪明钱共识

达到运营者设定的最少钱包数（默认 2）的共识事件。`dedupKey` 形如
`alert:<告警 id>`。

| `payload` 字段 | 类型           | 中文名   | 含义                     |
| -------------- | -------------- | -------- | ------------------------ |
| `outcome`      | string \| null | 结果方向 | 共识看好的那一边         |
| `walletCount`  | number         | 钱包数   | 参与共识的白名单钱包个数 |
| `totalNetUsd`  | number \| null | 总净买额 | USD                      |
| `slug`         | string \| null | 市场短名 | —                        |
| `eventSlug`    | string \| null | 事件短名 | —                        |

#### `sourceType: "discovery"` — 聪明钱发现

**新钱包通过准入闸进入白名单池**时发出——这条讲的是「我们的观察名单变了」，
不是某个市场的行情。`dedupKey` 形如 `wallet:<地址>`，`conditionId` 与
`title` 恒为 `null`。

| `payload` 字段 | 类型           | 中文名   | 含义                             |
| -------------- | -------------- | -------- | -------------------------------- |
| `address`      | string         | 钱包地址 | `0x…`                            |
| `score`        | number \| null | 综合评分 | `0`–`100`，构成见下              |
| `source`       | string \| null | 发现渠道 | 这个钱包是怎么被找到的，取值见下 |

**`score` 的构成**（0–100，启发式，刻意保持可解释）：

| 分量     | 满分 | 归一方式                                      |
| -------- | ---- | --------------------------------------------- |
| 绝对利润 | 40   | 已实现盈利 / $1,000,000，封顶                 |
| 资金效率 | 30   | ROI / 10%，封顶（即 ROI ≥ 10% 拿满分）        |
| 胜率     | 30   | 已结算胜率；样本被截断时打 0.9 折（存活偏差） |

> `score` **不是**准入判据。准入走的是 §6.4 的胜率／ROI 双路径闸门——
> `score` 的利润轴在 $1M 处饱和，拿它当门槛会把「资金体量大」重新引进来，
> 而那正是发现渠道要绕开的偏差。`score` 只用于排序与展示。

**`source` 的取值**：

| 取值                      | 中文名     | 含义                             |
| ------------------------- | ---------- | -------------------------------- |
| `leaderboard`             | 全球盈利榜 | 官方 top-100，榜单本身即门槛     |
| `category:<分类>`         | 分类榜     | 某个分类榜的上榜者，须再过准入闸 |
| `discovered:echo`         | 跟随者回声 | 从跟随行为中发现                 |
| `discovered:splitter`     | 拆单建仓   | 分散下单堆出大仓位的形态         |
| `discovered:insider`      | 早鸟重注   | 冷门时刻的重注形态               |
| `discovered:early_winner` | 早期赢家   | 在价格便宜时下重注且赢下来的钱包 |

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
§6.3 的类型定义对两条路径都成立。

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
  record: SignalRecord | null; // 该档 30d 战绩，量纲见 §6.6
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
    record: SignalRecord; // 已发布且已结算的 30d 战绩，量纲见 §6.6
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
的推送。当前对外放开的是「激进」一档（§4.1），联系运营者确认你的 key 范围。

**Q：`bus` 一直是空数组？**
**这是当前的预期行为**——本部署三个总线类型都没开启（§4.1），`bus` 恒为
`[]`。不是你接错了，也不是故障。想启用请联系运营者；启用后只投影此后新产生
的事件，不回灌历史。

**Q：`implied` 是 1051.3，这是百分比吗？**
不是。`record30d` 全部五个字段都是**条数**量纲（§6.6）。`implied` 的意思是
「市场在同样价位下预期能中 1051.3 条」。

**Q：`recordByStrategy` 用档位名取值取不到？**
键是 strategy id 的字符串（`"6"`），档位名在 `.name` 里（§6.7）。

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

| 日期       | 变更                                                                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-19 | 新增 §4.1「当前开放状态」快照：明确当前只有「激进」一档对外发布、`bus[]` 三类均未开启（恒为 `[]`）。名录表加「当前对外」列，订阅范围表与 FAQ 同步标注 —— 文档不再承诺订阅方此刻拿不到的东西                                |
| 2026-08-18 | 字段级详解：每个对象补「字段／类型／中文名／含义」表；新增 §6.1 信号体系总览、§6.7.1 六个检测器族、§6.7.2 19 档名录、白名单准入闸与 `score` 构成、`bus` 三类 payload 逐字段说明。§6 内部小节重编号（原 6.1–6.6 → 6.3–6.8） |
| 2026-08-18 | 失败响应补齐 `heavyMinUsd` 与 `staleLoops`，字段集合与成功响应完全一致（此前缺这两个字段，§6.3 的类型现在对两条路径都成立）                                                                                                |
| 2026-08-18 | 校准至当前实现：补 `bus[]` / webhook / 公开端点章节；修正 `record30d` 量纲（条数而非比率）与 `recordByStrategy` 键（strategy id 而非档名）；补齐全部字段的 TypeScript 类型与单位约定                                       |
| 2026-08-13 | 新增 `bus[]`（统一信号总线）与 key 的订阅范围过滤                                                                                                                                                                          |
| 2026-08-13 | 新增 webhook 推送、`/api/record` 公开战绩与每日存证链                                                                                                                                                                      |
| 2026-08-13 | 新增 `strategies` 段与 `delayed` tier；`api_keys` 多租户鉴权                                                                                                                                                               |
