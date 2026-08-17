# 统一信号总线 —— 把全站信号类型纳入可管理的推送

日期：2026-08-17
状态：用户已裁决范围

## 1. 现状与问题

「📡 可推送信号」目前只覆盖 **19 档策略信号**（`follow_strategies.push_enabled`
→ `strategy_signals` 台账 → 投递总线 → webhook / `/api/signals`）。

而全站其实产出至少 6 类信号，各走各的路：

| 类型                     | 当前去向       | 是否已持久化                               |
| ------------------------ | -------------- | ------------------------------------------ |
| 策略档位信号             | 投递总线 ✅    | `strategy_signals`                         |
| 大额成交（大单 / 巨鲸）  | 仅 TG 告警频道 | `alerts(type=large/smart)`                 |
| 聪明钱共识               | 仅 TG 告警频道 | `alerts(type=consensus)`                   |
| 聪明钱发现（新成员入池） | 仅页面         | `wallet_candidates` + `smart_wallets`      |
| 聪明钱分歧               | 仅页面         | ❌ 实时算（有 `market_tilt_history` 快照） |
| 拆单累计建仓             | 仅页面         | ❌ 实时算                                  |
| 赛前聚合                 | 仅 𝕏 播报      | ❌ 实时算                                  |

**用户裁决**：把现有各类纳入统一管理（不做自定义规则引擎）；投递通道
**只要 Webhook / API**——TG 告警频道维持现状不动，也不发 𝕏。

## 2. 架构

### 统一事件台账 `bus_signals`

```sql
CREATE TABLE bus_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,   -- 'large'|'consensus'|'discovery'|'disagreement'|'accumulation'|'pregame'
  dedup_key TEXT NOT NULL,     -- 源自各自源表的天然键，跨轮幂等
  condition_id TEXT,
  title TEXT,
  payload TEXT NOT NULL,       -- 该类型的结构化载荷（JSON）
  emitted_at INTEGER NOT NULL,
  UNIQUE(source_type, dedup_key)
);
```

为什么不复用 `strategy_signals`：它的 `strategy_id NOT NULL` 与「不属于任何
策略档位」的信号（大单、发现…）语义冲突；硬塞会让既有的策略战绩查询全部
需要额外过滤，是把两件事搅在一起。两张表各自单纯，投递层做联合。

### 投影而非重算

已持久化的类型（大单 / 共识 / 发现）**从源表投影**进总线，不重新检测：
源表已是唯一真相，重算既浪费又会产生口径分叉。未持久化的三类需要先落库
（见 §4 分批）。

### 开关与阈值

存 `config` 表一行 JSON（与 `xSettings` 同款：坏值逐键回落默认、真实变更才
写 `config_history`）。每类可独立开关 + 各自的阈值（如大单的最低金额）。

## 3. 消费侧

- **Webhook**：现有 `webhookDelivery` 的事件流里增加这些类型；订阅方按
  `source_type` 自行过滤。
- **`/api/signals`**：新增 `bus` 段（**只增不改**既有字段，兼容现有订阅方）。
- **`/manage → 📡 推送与提醒`**：SignalsSection 上方新增「信号类型」区，
  列出全部类型 + 开关 + 阈值 + 近 24h 产出量。

## 4. 分批

**批次 A（本批）**：表 + 类型注册表 + 开关/阈值 + `/manage` UI +
**已持久化三类**（大单 / 共识 / 发现）的投影接线 + API 暴露。
交付即可用，且不碰任何实时计算路径。

**批次 B（后续）**：分歧 / 拆单 / 赛前聚合先落库再接入。这三类都要在 worker
里新增或复用计算（分歧与赛前已有现成计算可复用，拆单需要新的轻量循环），
风险与工作量都高于 A，单独一批做。

## 5. 红线

- 不改 TG 告警频道的任何行为（用户明确只要 webhook/API）。
- 投影不得触发上游请求：只读本地表。
- `/api/signals` 既有字段只增不改。
- 关掉的类型不写入总线（而不是写了再过滤）——省表也省投递配额。
