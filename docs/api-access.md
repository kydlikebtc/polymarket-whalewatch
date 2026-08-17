# WhaleWatch 信号 API — 接入文档

> 面向持有 API key 的订阅方。key 由运营者在 `/manage → 🔑 接入` 签发，
> 明文只在签发那一刻显示一次（库中仅存 sha256），丢失只能重新签发。

- **端点**：`GET https://whalewatch.wired.fund/api/signals`
- **数据源**：全部来自本服务已持久化的状态，**零上游调用** —— 你的请求不会
  挤占监控引擎的 Polymarket API 预算，也不会因上游抖动而失败。
- **服务端缓存**：30 秒。同一窗口 + 同一 tier 的并发请求共享一次计算。

---

## 1. 鉴权

两种写法等价，任选其一：

```http
x-feed-token: <YOUR_API_KEY>
```

```http
authorization: Bearer <YOUR_API_KEY>
```

```bash
curl -s -H "x-feed-token: $KEY" \
  "https://whalewatch.wired.fund/api/signals?windowHours=24"
```

### 错误响应

| 状态                          | 含义                                                     | 处理建议                                     |
| ----------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| `401`                         | key 缺失、错误，或已被吊销                               | 检查 header 拼写；确认 key 未被运营者吊销    |
| `403`                         | 服务端尚未开放 feed（既没配 env token 也没签发任何 key） | 联系运营者                                   |
| `200` + 响应体含 `error` 字段 | 服务端内部异常                                           | 见下方「失败语义」——**不要当成"今天没信号"** |

---

## 2. Tier：`realtime` 与 `delayed`

每个 key 在签发时定 tier，决定你看到的是**哪个时刻的世界**：

| tier       | 语义                                                     |
| ---------- | -------------------------------------------------------- |
| `realtime` | 实时。信号形成即可见                                     |
| `delayed`  | 整个 feed 以 `now − delayedMin` 构建（默认延迟 30 分钟） |

关键点：**延迟层不阉割任何字段**，只是时间平移——你拿到的是"30 分钟前的完整
世界"，而不是"现在的删减版"。响应里的 `delayedMin` 明确告诉你延迟了多少分钟
（`realtime` 为 `0`）。

唯一的例外是健康位：`healthy` / `staleLoops` **始终按真实时间评估**。引擎死没死
是所有订阅方都必须立刻知道的事实，不该被延迟掩盖。

---

## 3. 请求参数

| 参数          | 取值                     | 默认 | 说明                                                 |
| ------------- | ------------------------ | ---- | ---------------------------------------------------- |
| `windowHours` | `6` / `12` / `24` / `48` | `24` | 「进行中」列表的时间窗。非法值静默回落默认值，不报错 |

---

## 4. 响应结构

```jsonc
{
  "updatedAt": 1755412800, // 本次数据的构建时刻（unix 秒）
  "windowHours": 24,
  "heavyMinUsd": 50000, // 当前「大额」口径阈值
  "delayedMin": 0, // 0 = realtime；30 = 延迟 30 分钟
  "healthy": true, // 引擎健康位（永远按真实时间评估）
  "staleLoops": [], // 停跳的循环名；healthy=false 时非空

  "active": [/* 窗口内进行中的信号 */],
  "settled": [/* 已结算的信号（带结果） */],
  "record30d": {
    // 近 30 天总战绩
    "settled": 128, // 已结算样本数
    "wins": 71,
    "implied": 0.52, // 按进场赔率的隐含胜率（基准线）
    "excess": 0.03, // 实际胜率 − 隐含胜率，>0 才是真 edge
    "sd": 0.044, // 标准差，用于判断 excess 是否显著
  },

  "strategies": {
    // 策略中心各档的信号与战绩
    "active": [/* 各档进行中的持仓信号 */],
    "settled": [/* 各档已结算 */],
    "recordByStrategy": { "巨鲸": {/* 该档 30d 战绩 */} },
  },
}
```

### `strategies.active[]` 单条

```jsonc
{
  "id": 4211,
  "strategy": { "id": 6, "name": "巨鲸", "source": "heavy" },
  "conditionId": "0x…",
  "title": "Chiefs win Super Bowl LX?",
  "slug": "chiefs-sb-lx",
  "eventSlug": "super-bowl-lx",
  "category": "体育",
  "subcategory": "NFL",
  "outcome": "Yes",
  "outcomeIndex": 0,
  "asset": "7112…", // CLOB token id，可直接用于下单接口
  "formationTs": 1755410000, // 信号形成时刻（第 N 个合格钱包到位那一刻）
  "referencePrice": 0.61, // 形成时的市价
  "walletCount": 3,
  "totalNetUsd": 92000,
  "entryPrice": 0.63, // 本档纸面进场价
  "sizeUsd": 500,
  "emittedAt": 1755410120, // 信号发出时刻；− formationTs = 检测延迟
}
```

**`formationTs` 与 `emittedAt` 的差值就是本系统的检测延迟**，公开这个差值是
刻意的：它让你能自己判断"跟这个信号还来不来得及"。

---

## 5. 失败语义（重要）

服务端内部异常时**不会返回 5xx**，而是返回 `200` + 一个结构完整的空 feed，并
带上 `healthy: false` 与 `error` 字段：

```jsonc
{ "active": [], "settled": [], "healthy": false, "error": "…", "delayedMin": 0 }
```

这样设计是为了让"服务出错"和"今天没有信号"**在你的代码里必须分开处理**——
一个只看 `active.length === 0` 的消费者，绝不该把故障当成平静的一天。

**接入方必读**：拉到数据后先判 `healthy`。`healthy === false` 时应冻结你自己的
下游动作（推送 / 下单 / 展示"数据正常"），而不是照常渲染一份空列表。

---

## 6. 拉取频率与限流

- **推荐：每分钟 1 次。** 服务端缓存 30 秒，拉得更频繁只会拿到同一份数据。
- 本服务是单机 Next + SQLite 的研究服务，限流是进程内的，**不具备承接终端
  App 直连流量的能力**。正确的拓扑是：

```
WhaleWatch  ──1 次/分钟──▶  你的后端（缓存 + 你自己的鉴权）  ──▶  你的客户端
```

把 key 放在你的服务端，不要下发到客户端——key 一旦泄露，任何人都能用你的
配额拉数据，而你无法单独吊销某个终端。

---

## 7. 最小接入示例

```javascript
const KEY = process.env.WHALEWATCH_KEY;

async function pull() {
  const res = await fetch(
    "https://whalewatch.wired.fund/api/signals?windowHours=24",
    { headers: { "x-feed-token": KEY }, signal: AbortSignal.timeout(15000) },
  );
  if (res.status === 401) throw new Error("key 无效或已被吊销");
  const feed = await res.json();

  // 故障与"没信号"必须分开处理（见 §5）
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

setInterval(() => void pull(), 60_000);
```

---

## 8. 常见问题

**Q：`active` 是空的，是不是接错了？**
先看 `healthy`。为 `true` 且 `updatedAt` 是新鲜的，那就是这个窗口内确实没有
达标信号——把 `windowHours` 放大到 48 再看。

**Q：我的 key 什么时候会失效？**
只有运营者主动吊销时。吊销后立即返回 `401`，没有宽限期。

**Q：能拿到历史数据吗？**
当前端点只提供滚动窗口（最长 48 小时）与 30 天聚合战绩，不提供任意历史区间
查询。公开战绩页 `/record` 提供人类可读的长期记录。

**Q：字段会变吗？**
只增不改。既有字段的名称与语义不会变更，新能力以新字段追加——你可以安全地
忽略未知字段。
