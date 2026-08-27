# 信号名录 API 设计（`GET /api/signals/list`）

日期：2026-08-27

## 要解决的问题

订阅方拿到 key 之后，**没有任何机器可读的方式知道自己能收到哪些信号**。

「能收到什么」是三层独立开关的乘积：

1. **tier**（`realtime` / `delayed`，`lib/feedAuth`）
2. **key 订阅范围**（`api_keys.bus_types`，`lib/apiKeys.keyAllows`）
3. **运营开关**（`bus_defs.enabled` / `follow_strategies.push_enabled`）

第 3 层公开在 `/api-docs`；第 2 层是这把 key 私有的，**此前无处可查**。于是
「接口通、返回 200、就是没数据」这个最难排查的状态没有诊断入口——订阅方只能
去问运营者。

本端点给出**名录**：这把 key 此刻真能收到的信号清单。不含信号条目本身
（那是 `/api/signals` 的事），也不含开关矩阵或原因说明——刻意只做一件事。

## 契约

```
GET /api/signals/list
```

鉴权、`401`/`403` 响应体、tier 语义全部复用 `/api/signals`（`checkFeedAccess`），
不新造第二套。

```jsonc
{
  "updatedAt": 1755412800, // 响应时刻（unix 秒）
  "tier": "delayed", // realtime | delayed
  "signals": {
    "bus": [
      // ① 原始事件
      { "type": "large", "threshold": 50000 },
      { "type": "large", "threshold": 500000 },
      { "type": "consensus", "threshold": 2 },
    ],
    "strategy": [
      // ② 策略事件
      { "code": "mega_whale", "source": "heavy" },
      { "code": "first_mover_consensus", "source": "consensus" },
    ],
  },
}
```

**全 ASCII，不含中文展示名。** 这是文档 §8.3 自己的建议：`name` 是中文展示名，
「运营改一次文案你就断了」。名录是拿来写代码的，不是拿来看的。

### 两级分组 = 文档既有的分类法

`bus` / `strategy` 对应文档 §6 的 ①原始事件 / ②策略事件，也对应 webhook 幂等键
`event` 的值域（`bus` / `entry` / `settle`）。不发明第三套词表。

### 字段取舍

| 给了              | 为什么                                                    |
| ----------------- | --------------------------------------------------------- |
| `bus.type`        | ASCII、稳定，`bus[]` 条目的 `sourceType` 用的就是它       |
| `bus.threshold`   | 去掉中文 label 后，同一 `type` 下多档的**唯一诚实判别键** |
| `strategy.code`   | §8.3 明写「认档用它」：ASCII、每档唯一、发布后冻结        |
| `strategy.source` | 检测器族（`heavy`/`consensus`/…），用于按族归类           |

| 没给                | 为什么                                                     |
| ------------------- | ---------------------------------------------------------- |
| `bus_defs.id`       | 部署本地自增行号——与 §8.3 否掉 `strategy.id` 同一个坑      |
| 中文 `label`/`name` | 见上：会诱导订阅方硬编码会变的文案                         |
| 开关/原因矩阵       | 收不到的直接不出现在名录里。三层各自为什么关，是运营者的事 |
| 信号条目本身        | `/api/signals` 已经在做，重复即口径分叉                    |

### `threshold` 的暴露口径（知情决策）

`lib/apiDocsStatus` 明确**不吐阈值**（「可被规避的规则集」）。那条纪律的对象是
**无需 key 的公开 `/api-docs` 页**。本端点要 key，且订阅方本来就能从收到的
`netUsd` 反推下限，因此在这里给 `threshold` 不构成新增暴露。

### `code` 可能为 `null`

运营手工建、尚未登记档位码的档。种子 19 档都有码。条目仍出现（`source` 仍有
意义），消费方按 §8.3 的既有指引跳过即可。

## 实现

- `lib/signalCatalog.ts` —— 纯函数 `buildSignalCatalog(db, { scopes })`，
  复用 `listBusDefs` 与 `follow_strategies` 查询，无新增查询路径。
- `app/api/signals/list/route.ts` —— 鉴权 + 30s 缓存。
  **缓存键必须含订阅范围**：否则全量 key 烤热的缓存会被受限 key 命中，
  那是越权泄露（`app/api/signals/route.ts:74` 已经为同一个坑写过注释）。
- `docs/api-access.md` —— 补 §4.1 与 §16 变更记录。`/api-docs` 直接渲染
  markdown，不用动 JSX。

## 测试

- 三层过滤各自生效：未启用的定义不出现；未发布的档不出现；不在 key 范围内的
  大类不出现。
- 未限定范围的 key（`bus_types` 为 NULL）拿到全部。
- **越权隔离**：只订 `large` 的 key 拿不到 `consensus`/`strategy`。
- **守卫**：名录里的 `bus.type` 必须都在 `lib/keyScopes` 的域内——防止新增
  类型时漏同步（`bus[]` 投影白名单已经因为缺这类对照守卫漏过三次字段）。
