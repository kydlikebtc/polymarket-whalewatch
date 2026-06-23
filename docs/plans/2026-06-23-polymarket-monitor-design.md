# Polymarket 大额成交 & 聪明钱监控系统 — 设计文档

- 状态: 已评审通过（待实现）
- 日期: 2026-06-23
- 作者: 设计协作产出（头脑风暴 + 接口实测验证）
- 验证说明: 本文所有接口均经并行研究 agent 对照官方文档并**实测打通**（HTTP 200 + 真实数据），核心两个接口本会话再次复核。

---

## 1. 背景与目标

两个核心目标：

1. **大额下单监控**：监控 Polymarket 上的大额**成交**（实际成交的 fill，非挂单），及时推送提醒。
2. **聪明钱监控**：定义"聪明钱"后，监控其大额下单行为。

## 2. 需求决策（已确认）

| 维度       | 决策                                                |
| ---------- | --------------------------------------------------- |
| 交付形态   | 常驻服务 + Web 可视化看板                           |
| 监控对象   | 大额**成交**（executed fills，非 resting orders）   |
| 聪明钱定义 | 自动筛选 + 手动白名单                               |
| 推送渠道   | Telegram                                            |
| 技术栈     | TypeScript 全栈（Next.js 看板 + Node 常驻 worker）  |
| 运行环境   | 本地机器先跑（MVP 优先），后续可上云                |
| 聪明钱维度 | 已实现 PnL + 胜率/ROI + 交易量 + 一致性（综合评分） |
| 监控范围   | 全市场                                              |

## 3. 数据源（实测验证）

整个核心系统**零鉴权、纯 REST 轮询**即可在本地运行。WebSocket 与链上监控为后备（详见 §14）。

### 3.1 大额成交流（功能1 + 功能2 共用）

- `GET https://data-api.polymarket.com/trades`
- 参数: `filterType=CASH` `filterAmount=<最小美元>` `takerOnly=true` `limit=500`（全局流则不传 `user`/`market`；结果按 `timestamp DESC`）。
- 按钱包: 追加 `user=<proxyWallet>`；按市场: 追加 `market=<conditionId>`。
- 返回关键字段: `proxyWallet`、`side`(BUY/SELL)、`asset`(clobTokenId)、`conditionId`、`size`(份额)、`price`(0–1 USDC/股)、`timestamp`(Unix 秒)、`title`、`slug`、`eventSlug`、`outcome`、`outcomeIndex`、`transactionHash`。
- 美元名义: `notional = size × price`（price 有浮点毛刺，显示取整）。
- 限速: `/trades` 200 req/10s。

### 3.2 市场元数据 / token→市场映射（告警富集）

- `GET https://gamma-api.polymarket.com/markets?clob_token_ids=<tokenId>`（可批量；亦可 `condition_ids=`）。
- 枚举市场: `GET .../markets?active=true&closed=false&order=volume24hr`，**每页上限 100**，用 `offset` 翻页直到不足 100。
- 注意: `outcomes`/`outcomePrices`/`clobTokenIds` 是**字符串化 JSON**，需 `JSON.parse` 后按下标对齐取结果标签；多结果 neg-risk 用 `groupItemTitle` 作为腿名。
- CDN 缓存 max-age=300，轮询便宜。
- URL: 市场页 `polymarket.com/market/{slug}`；事件页 `polymarket.com/event/{eventSlug}`（grouped/neg-risk 用 event slug 更稳）。

### 3.3 聪明钱数据

- 种子榜单: `GET https://data-api.polymarket.com/v1/leaderboard?orderBy=PNL|VOL&timePeriod=DAY|WEEK|MONTH|ALL&category=OVERALL|...&limit=50&offset=0..1000`。返回 `rank`、`proxyWallet`、`userName`、`vol`、`pnl`、`xUsername`、`verifiedBadge`。
- 逐钱包富集: `/positions`(150 req/10s)、`/activity`、`/value`（均 `user=<钱包>`）。
- 通用限速桶: 1000 req/10s。

## 4. 系统架构

```
Polymarket 公共接口（零鉴权）
  ├─ data-api /trades        全局大额成交流
  ├─ gamma-api /markets      元数据 / token→市场映射
  └─ data-api /leaderboard   聪明钱种子榜单 + /positions /activity /value
        │
        ▼
常驻 Node Worker（本地）
  ├─ 大额成交轮询（功能1，阈值分级、去重）
  ├─ 聪明钱评分引擎（功能2，leaderboard 种子 → 富集 → 综合打分 → 动态名单）
  └─ 告警引擎（去重、富文本组装、限流、推送）
        │  读/写
        ▼
本地 SQLite（去重键 / 聪明钱名单 / token映射 / 告警历史 / 配置）
        │                         │
        ▼                         ▼
Telegram 频道（实时推送）      Next.js 看板（只读，查询与配置）
```

- worker 与看板**解耦**：worker 写 SQLite 并直接推 Telegram；看板只读 SQLite。
- 聪明钱监控**复用功能1的成交流**：每条成交的 `proxyWallet` 与名单交叉比对即可，不需要额外成交接口。

## 5. 功能1设计：大额成交监控

- **轮询**: 单全局轮询，每 3–5 秒拉第一页（`limit=500`），从最新往回走，遇到"已见过键"即停；仅当首页全为新数据才继续 `offset` 翻页（突发保护）。
- **金额分级**（配置化）: 默认 `≥$10k 大单` / `≥$50k 巨鲸`，不同档位可走不同 Telegram 路由/优先级（可分别起独立 `filterAmount` 轮询）。
- **去重键**: `${transactionHash}:${asset}:${proxyWallet}:${side}:${size}`。
- **持久化**: `lastSeenTimestamp` 游标 + 有界 seen-keys 集合（落 SQLite），**跨重启**不漏不重。
- **冷启动播种**: 首次启动（seen 表为空）时，把当前整页成交**静默标记为已见、不告警**（`seedSeen`），避免开机回放最多 500 条历史成交造成"告警风暴"；之后只对启动后新出现的成交告警。暖重启（seen 表非空）跳过播种、正常恢复。
- **为何不用 WebSocket**: CLOB WS 的 `last_trade_price` 事件**不含 tx hash 和钱包地址**，无法做聪明钱归因与深链；先轮询，必要时再加 WS（见 §13/§14）。

## 6. 功能2设计：聪明钱监控

### 6.1 名单生成管线

1. **自动种子**: 跑 leaderboard 矩阵（PNL/VOL × MONTH/ALL × 类别），收集去重 `proxyWallet`（≤~1000）。
2. **逐钱包富集**（候选 + 白名单）:

| 维度          | 来源                                           | 算法                                                                              |
| ------------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| 已实现 PnL    | `/positions.realizedPnl` + `/activity`(REDEEM) | 跨市场求和；已平仓不在 positions，必须叠加 activity                               |
| 胜率 / ROI    | 派生                                           | 按 `conditionId` 统计净已实现盈利为正的已结算市场占比；ROI=(已实现+未实现)/成本基 |
| 交易量        | `leaderboard.vol` 或 `/trades?user=`           | `takerOnly=true` 防重复计                                                         |
| 一致性 / 账龄 | `/activity`                                    | 最早时间戳=账龄；活跃跨度过滤"一把暴富"                                           |

3. **综合评分 + 硬门槛**: 加权打分 + 准入门槛（如 `/value > $X`、交易数 > N、账龄 > D 天）。**权重与门槛配置化**（"聪明"的定义，需调参）。
4. **白名单合并**: 一组 `proxyWallet`，走同一富集管线，但①绕过评分门槛 ②永远被监控 ③打标记。（若用户给 EOA 而非 proxy，需 `deriveSafe` 派生，UI 优先要求 proxy 地址。）
5. **刷新**: 名单每日重算；富集循环限速+缓存（token bucket + 60s TTL + 429 退避）。

### 6.2 监控其大额成交

- 主路: 功能1全局成交流中，每条 `proxyWallet` 与名单交叉比对（最省）。
- 增强（可选）: 对名单钱包跑更低阈值的定向轮询 `/trades?user=<钱包>&filterType=CASH&filterAmount=<lower>`，做更紧的跟踪。

### 6.3 评分函数（实现阶段的关键协作点）

综合评分函数是最有业务含量的部分（多种合理权重/门槛取舍取决于用户判断）。实现时搭好函数骨架与上下文，由用户填权重逻辑。骨架（示意）:

```ts
// shared/smartMoney/score.ts
interface WalletMetrics {
  realizedPnlUsd: number;
  winRate: number; // 0..1
  roi: number; // 例如 0.25 = +25%
  volumeUsd: number;
  tradeCount: number;
  accountAgeDays: number;
  activeWeeks: number; // 一致性
  portfolioValueUsd: number;
}
// 返回 0..100 综合分；不达硬门槛返回 null（淘汰）。
function scoreWallet(m: WalletMetrics, cfg: ScoreConfig): number | null {
  /* 用户填 */
}
```

## 7. Telegram 推送设计

- **用频道(channel) 不用群**（群限 20/分，频道约 30/秒）；Bot 设为频道管理员。
- **格式**（HTML + 深链）: 市场标题 → 结果 → 方向 → 美元金额 → 价格 → 钱包短地址 + Polymarket 主页链接 + Polygonscan tx 链接；聪明钱命中加 🏆 + 评分/PnL。
- **限流**: 429 读 `parameters.retry_after` 精确退避；标题含 `& < >`/emoji 时 HTML 转义，解析失败回退纯文本（防静默丢弃）。

## 8. 数据存储（本地 SQLite）

| 表              | 字段（要点）                                                                               |
| --------------- | ------------------------------------------------------------------------------------------ |
| `seen_trades`   | dedupKey(PK), timestamp                                                                    |
| `smart_wallets` | address(PK), score, realizedPnl, winRate, roi, volume, consistency, isWhitelist, updatedAt |
| `token_map`     | tokenId(PK), conditionId, question, outcome, slug, eventSlug, updatedAt                    |
| `alerts`        | id, type(large/smart), dedupKey, payload(json), createdAt                                  |
| `config`        | key(PK), value(json) — 阈值/权重/白名单                                                    |

## 9. Web 看板（Next.js）

实时大单流、聪明钱榜单（评分+各维度指标）、告警历史检索、配置管理（阈值/权重/白名单增删）。看板只读 SQLite，与 worker 解耦。

## 10. 技术栈与项目结构

TypeScript 单仓:

- `/worker` — 常驻轮询 + 评分（tsx/node 运行）
- `/web` — Next.js 看板
- `/shared` — 接口客户端、类型、SQLite 访问层（两端共用）
- `.env` — Telegram token、阈值、限速等

## 11. 主要配置项

`LARGE_THRESHOLDS`(如 [10000, 50000])、`POLL_INTERVAL_MS`(3000–5000)、聪明钱 `SCORE_WEIGHTS` 与硬门槛、`SMART_WATCH_THRESHOLD`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHANNEL_ID`、`WHITELIST`(地址数组)。

## 12. 分阶段路线

| 阶段      | 内容                                                 | 产出           |
| --------- | ---------------------------------------------------- | -------------- |
| P0        | 脚手架 + SQLite + Telegram 打通（测试消息）          | 地基           |
| P1（MVP） | 功能1：大额成交轮询 → Telegram（去重/分级/富文本）   | **目标1 达成** |
| P2        | 功能2基础：手动白名单 → 监控其大额成交               | 目标2 可用     |
| P3        | 功能2进阶：leaderboard 种子 → 富集 → 评分 → 动态名单 | 自动聪明钱     |
| P4        | Next.js 看板                                         | 可视化         |
| P5        | 硬化/上云：运行时验证清单、按需加 WS/链上、迁云      | 生产化         |

## 13. 运行时验证清单（上线前/编码中逐项确认）

**大额成交流**

- [x] 全局 `/trades?filterType=CASH&filterAmount=N` 仅返回 ≥$N 成交（已复核）。
- [ ] 实测**索引延迟**（链上 fill → 出现在 `/trades` 的耗时），决定轮询是否达 SLA。
- [ ] 确认全局流返回**所有**市场成交（不被采样/截断）：对账某活跃市场。
- [ ] 实测真实 `limit` 上限与安全 `offset` 深度。
- [ ] 验证去重键对同区块同时间戳的并发成交不塌缩/不重复。
- [ ] 读运行时 `X-RateLimit-*` 头调节节奏。

**聪明钱筛选**

- [x] `/v1/leaderboard` 返回 `proxyWallet`/`pnl`/`vol`（已复核）。
- [ ] 锁定**胜率定义**（win = 某 conditionId 净已实现盈利 > 0？）；处理部分平仓与 neg-risk。
- [ ] 确认 leaderboard `pnl`/`vol` 是否含未实现、滚动 vs 自然窗口。
- [ ] 确认 `/positions.realizedPnl` 语义与已赎回/已结算是否掉出。
- [ ] 验证 `/closed-positions` 形态（疑似需要它补全已实现 PnL）。
- [ ] 跑 1000 钱包富集前实测真实（未公开）持续限速。
- [ ] 白名单若收 EOA：验证 `deriveSafe` 对 Safe / Magic 工厂都正确。

**映射**

- [x] `/markets?clob_token_ids=` 反查可用（已验证）。
- [ ] 确认反查也能解析**已关闭/已结算**市场。
- [ ] 确认多结果 neg-risk 的结果标签语义（event 标题 + groupItemTitle + Yes/No）。

**推送**

- [ ] 确认目标是**频道**（≈30/秒）而非群（20/分）。
- [ ] 测 HTML `parse_mode` 对含 `& < >`/emoji 标题的处理 + 纯文本回退。
- [ ] 确认 `polymarket.com/profile/<proxyWallet>` 仍可解析（2026 前端有变）。

## 14. 后备方案（非第一版依赖）

- **CLOB WS market 频道** `wss://ws-subscriptions-clob.polymarket.com/ws/market`（更低延迟，但 `last_trade_price` 缺钱包/tx，需与 `/trades` 做时间+量+价模糊 join 才能归因）。
- **链上 / 子图**: Polygon CTF/NegRisk Exchange 的 `OrderFilled` 日志、Goldsky 子图（需确认 2026 V2 迁移后的合约地址/ABI 与免费 GraphQL 可用性）。
- 仅当实测 `/trades` 索引延迟无法满足告警 SLA 时才引入 WS/链上。

## 15. 置信度小结

- Data API `/trades`（大额成交流）: **高** ✅
- Leaderboard + `/positions`/`/value`（聪明钱种子）: **高** ✅
- `/activity`（生涯 PnL/胜率）: 中-高（需锁定胜率口径）
- Gamma（元数据/映射）: **高**
- CLOB WS（备选实时）: 中（第一版不用）
- 链上/子图（备选）: 中（V2 迁移后需复核地址/ABI）

**结论**: 大额成交告警 + 聪明钱筛选 + 映射 + Telegram 的全部核心，可在**本地、零鉴权、纯 REST 轮询**下构建；WS 与链上为后备。唯一真正的"空缺"是派生指标（胜率/ROI/一致性需自算）和 §13 的若干语义确认。
