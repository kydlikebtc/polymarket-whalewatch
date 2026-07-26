# 共识跟单 · 纸面模拟 + 策略收益追踪 — 设计文档

> 状态:2026-07-07 脑暴评审通过,待实现。分支 `claude/frosty-lalande-fb91e1`。
> 本文档只描述**已确认**的设计;实现拆解见配套的 `2026-07-07-consensus-follow-implementation.md`。

## 1. 目标与非目标

### 目标

把现有**只读**的聪明钱共识检测,升级出一层**纸面跟单**能力:当一个共识形成时,按当前市价开一笔**虚拟仓**,持有到市场结算,并把这些虚拟仓聚合成一条**策略级净值曲线 + 指标**。支持**多套策略变体并行**,用各自净值做 A/B,回答两个问题:

1. 「如果无脑跟共识,收益到底如何?」
2. 「哪套共识阈值(几个钱包、每人多少钱)最值得跟?」

### 非目标(v1 明确不做)

- **不下真实单**。纯纸面模拟,零真金白银,不接 CLOB 下单、不需鉴权/私钥。契合项目「query-only、不下单」定位与安全红线。
- **不做历史回测**。系统无成交归档(roadmap 已注明),只能**前向**追踪:从共识形成那一刻起记录。
- **不做未平仓浮盈(mark-to-market)**。只在市场**结算**时记 realized P&L;净值曲线只在结算点跳变,持有中仓位显示「待结算」、不显示浮动盈亏。此为用户明确选择,顺带把每轮盯市的 data-api 限频压力降为零。
- **不给跟/不跟建议**。延续 disagreement 的 read-only 哲学,只报告策略表现,不发投资建议。

## 2. 核心概念与关键取舍

| 决策     | 选择                       | 理由                                                                                                                      |
| -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 入场价   | **当前市价**(非聪明钱均价) | 聪明钱那一刻的价已成历史;真实跟单只能吃当下价。「现价 − 聪明钱均价」= **跟单滑点**,如实记录才诚实回答「散户还追得上吗」。 |
| 退出规则 | **持有到结算**             | 最贴合预测市场「到期即终结」机制,最稳健,无需额外行情监控。时间止盈/止损 v1 不做。                                         |
| 仓位     | **固定 $/信号**(默认 $500) | 等额下注便于横向比较不同信号质量;后续可扩展按共识规模/质量加权。                                                          |
| 盯市     | **仅结算盈亏**             | 见非目标。                                                                                                                |
| 多策略   | **并行变体 A/B**           | 每套阈值独立净值;闭合 README roadmap 缺的「阈值/评分权重反标定」环。                                                      |

## 3. 架构与挂载点

新增一条 `followCycle`,挂在现有 5min 共识循环旁边(`worker/embeddedEngine.ts` 的 `consensusLoop` 同级),与 Telegram 告警路径**完全解耦**(延续「worker≠dashboard」哲学)。每轮:

```
followCycle (每 5min):
 1. fetchWindow()  → 复用 getTradesWindowDeep({minUsd, sinceSec})  拿 6h 窗口成交
 2. detectConsensus(trades, smartTags, 最松阈值)  → 活跃共识组      [复用]
 3. 开仓:对 每个启用策略 × 满足该策略阈值的共识组:
       若 (strategy_id, condition_id, outcome) 无记录 → fetchCurrentPrice(asset) 现价开虚拟仓
       (UNIQUE 约束保证每组每策略只进一次)
 4. 结算:对所有 status='open' 的仓位:
       getMarketMeta(conditionIds) → 若 closed:exit_price=outcomePrices[idx],
       realized_pnl = shares*(exit_price − entry_price),status='settled'   [复用 gamma 缓存,便宜]
```

- **最松阈值优化**:一次 `detectConsensus` 跑在所有策略里最松的 `minWallets`/`minPerWalletUsd` 上,再在内存里按各策略阈值过滤,避免多次检测。
- **跨进程去重**:沿用共识循环的 claim 范式——`follow_positions` 的 `UNIQUE(strategy_id, condition_id, outcome)` + `INSERT OR IGNORE` 天然防两进程重复开仓。
- **首跑时机**:启动后延迟(如 45s)首跑,给每日播种/白名单抢跑时间;空白名单则空转跳过(同 consensus)。

## 4. 数据模型(2 张新表)

```sql
CREATE TABLE IF NOT EXISTS follow_strategies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,          -- '保守' / '激进'
  enabled    INTEGER DEFAULT 1,
  params_json TEXT,                -- {minWallets, minPerWalletUsd, sizeUsd, exitRule:'settlement'}
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS follow_positions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id   INTEGER,
  condition_id  TEXT,
  outcome       TEXT,
  asset         TEXT,              -- token id,用于 prices-history + 结算取价
  outcome_index INTEGER,
  title         TEXT,
  event_slug    TEXT,
  entry_ts      INTEGER,
  entry_price   REAL,              -- 现价进场
  smart_avg_price REAL,            -- 共识组 usd 加权均价(滑点参照)
  size_usd      REAL,
  shares        REAL,              -- size_usd / entry_price
  status        TEXT,              -- 'open' | 'settled'
  exit_ts       INTEGER,
  exit_price    REAL,              -- 结算 outcomePrice(≈0/≈1/小数标量)
  realized_pnl  REAL,
  UNIQUE(strategy_id, condition_id, outcome)
);
```

- 无需 `mark_price/mark_ts` 列(不做浮盈)。
- 迁移沿用 `lib/db.ts` 的 `CREATE TABLE IF NOT EXISTS` + 版本号 config 门控范式;种子策略(保守/激进)首启插入。
- 预置策略示例:
  - `保守`:`{minWallets:3, minPerWalletUsd:10000, sizeUsd:500, exitRule:'settlement'}`
  - `激进`:`{minWallets:2, minPerWalletUsd:5000, sizeUsd:500, exitRule:'settlement'}`

## 5. P&L 与指标数学(纯函数,复用 `lib/outcomeStats.ts`)

单仓:

- `shares = size_usd / entry_price`
- 结算 `realized_pnl = shares × (exit_price − entry_price)`
- 输赢分类 `settleWon('BUY', entry_price, exit_price)`(已正确处理小数结算;≈0.5 或 ≈entry 的 push 返回 null,不进胜率分母)
- 单仓滑点 `= shares × (entry_price − smart_avg_price)`(正=比聪明钱追得更贵)

策略级(`computeStrategyMetrics(positions)` 纯函数):

| 指标                    | 算法                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| 总实现盈亏 / 投入 / ROI | `Σrealized` / `Σsize_usd`(仅 settled)                                        |
| 结算胜率 + 95%CI        | `wins/settledCount`,套 `wilsonInterval`(push 不计)                           |
| 净值曲线                | settled 按 `exit_ts` 升序的累计 realized 序列                                |
| 最大回撤                | 净值序列上 peak-to-trough 最大跌幅                                           |
| 平均持有期              | `Σ(exit_ts − entry_ts)/settledCount`                                         |
| 按赛道拆分              | 复用 `gamma` category(防 Simpson 悖论,同 summarizeOutcomes 按类型分组的做法) |
| 累计滑点成本            | `Σ shares × (entry_price − smart_avg_price)`                                 |

## 6. 前端 + API

- 新页 `app/follow/page.tsx`(或作 `/consensus` 的 tab;倾向独立页更清晰)。布局已出可视化原型并确认:
  1. 策略 A/B 卡(净值/ROI/胜率±CI/结算·持有/滑点/最大回撤),领先者 2px accent 边框标注;
  2. 结算净值阶梯曲线(多策略叠加,实线/虚线区分,不靠颜色);
  3. 「已结算」分区:进价→结算价 · 滑点 · 持有期 · realized(涨绿跌红);
  4. 「持有中·待结算」分区:进价 · 滑点 · 已持有天数,不显示浮盈。
- 新 `app/api/follow/route.ts`:`force-dynamic`,读 `follow_strategies` + `follow_positions`,调 `computeStrategyMetrics`,返回策略 + 仓位 + 指标。复用现有 `ds-*` 组件/tooltip/glossary 范式;新符号进 `app/glossary.ts` 单一真相源。

## 7. 复用 vs 新增

**复用**:`detectConsensus`(进场触发)· `getTradesWindowDeep`(窗口)· `priceHistory.fetchPriceAt`(现价/结算价)· `gamma.getMarketMeta`(结算 outcomePrices + category)· `outcomeStats.settleWon`/`wilsonInterval` · db 迁移与 config 门控范式 · claim/UNIQUE 去重范式 · 5min 循环骨架 · `ds-*` UI 组件。

**新增**:2 张表 · `lib/follow.ts`(P&L + 指标纯函数 + `runFollowCycle` 注入式依赖)· `followCycle` 调度 · `app/follow` 页 + `app/api/follow` 路由 · 策略种子 · glossary 新词条。

## 8. 诚实边界(必须在 UI/文档标注)

- 纸面成交按现价撮合,**不建模流动性冲击/部分成交**;可用 gamma `liquidityShare` 标注冲击估计。
- **仅前向**,无历史回测(无成交归档)。
- 小数结算/push 由 `settleWon` 正确处理;push 不进胜率分母。
- 入场价取 `fetchPriceAt(asset, now)`,失败时回退到共识组最近一笔成员成交价;两者都缺则跳过该仓开仓(下轮重试),绝不用聪明钱均价冒充现价。

## 9. 分期

- **P2a(MVP)**:2 表迁移 + `lib/follow.ts` 开仓/结算/P&L + `runFollowCycle`(注入式)+ 单策略端到端。
- **P2b**:多策略并行 + `computeStrategyMetrics` 全指标(净值曲线/回撤/滑点/按赛道)。
- **P2c**:`/follow` 页 + `/api/follow` + glossary。
- **P2d(远期)**:策略 P&L 反标定共识阈值 / 0-100 评分权重(闭合飞轮)。

## 10. 测试策略(TDD,沿用 vitest)

- 纯函数优先:P&L(shares/realized/滑点)、`computeStrategyMetrics`(净值/回撤/Wilson/按赛道)、策略阈值过滤、开仓 payload 构造 —— 全单测。
- `runFollowCycle` 用注入依赖(仿 `runConsensusCycle` 测法):喂假成交 + 假 smartTags + 假 getMeta/fetchPrice,断言开仓/结算/去重/幂等。
- db 迁移测试:表存在、UNIQUE 生效、策略种子幂等。
- 覆盖率对齐现状(≥现有基线)。

## 11. 风险与未决

- **入场现价来源**:`fetchPriceAt(asset, now)` 是否稳定返回可用现价,需实现时实测(CLOB prices-history 最新点);回退链见 §8。
- **结算及时性**:依赖 gamma `closed/outcomePrices`;未 closed 的仓位保持 open,每轮低成本复查(缓存)。
- **策略配置入口**:v1 用种子 + `params_json`;是否需要 `/follow` 页可视化编辑策略,留待 P2c 决定(默认先只读展示)。
