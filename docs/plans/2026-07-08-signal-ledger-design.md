# 信号台账(Signal Ledger)与管道分解 — 系统层设计文档

> 状态:2026-07-08 设计评审稿,待实施(实施另立计划)。
> 起因:用户指出系统层缺陷——跟单触发依赖"寄生在 Web 应用进程里的自调度轮询循环",线上部署同样如此,这个耦合不因换机器而消失。

## 1. 问题陈述(系统设计层)

当前架构把四件事挤在一个 Node 进程里:

```
┌────────────── 一个 Node 进程(Next 应用 或 standalone worker)──────────────┐
│  采集(轮询 data-api) → 检测(6h 内存滚动窗口即时推导) →                    │
│  执行(开纸面仓) → 展示(Web 页面,仅内嵌模式)                              │
│  全部依赖:这个进程活着、setTimeout 自调度循环在转                          │
└────────────────────────────────────────────────────────────────────────┘
```

四个真问题:

| #   | 问题                                                      | 后果                                                                 |
| --- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| P-1 | 采集/执行与 Web 应用同生共死(内嵌模式)                    | 部署、崩溃、容器重启 → 引擎停                                        |
| P-2 | 触发靠常驻进程自调度,无外部调度器兜底                     | 进程生命周期 = 管道生命周期                                          |
| P-3 | **信号不是持久事实**:共识每轮从滚动窗口即时推导、用完即弃 | 停机期间形成的共识"从未存在过"——不可审计、不可回测、错过损失不可度量 |
| P-4 | 单进程单 SQLite,无 HA                                     | 个人工具可接受,不在本设计治理范围                                    |

P-3 是要害:纸面实验的统计有效性依赖连续观测,而当前设计把"观测空窗"变成"信号黑洞"。

## 2. 已有的正确地基(设计时必须复用)

1. **进程分离已存在**:`worker/index.ts` 是独立引擎(`npm run worker`),Next 应用可只作只读看板。内嵌模式只是便利默认。
2. **幂等已为多进程/重跑设计好**:alerts 表 claim 锁(UNIQUE(type,dedup_key) + INSERT OR IGNORE)、follow_positions UNIQUE 约束。外部调度器反复触发是安全的。
3. **formationTs 可追溯重建**(P1 改造的副产品):"形成时刻"从成交窗口回算——重启后重拉 6h 窗口,停机期间形成的共识可完整重建(时刻 + 形成价 + 成员),只是当前代码把 stale 的直接丢弃。**"停机=信号不存在"是选择不是必然。**

## 3. 目标架构

```
采集器 ──→ 检测器 ──→ 信号台账(consensus_signals 表) ──→ 执行器 ──→ 展示层
(独立 worker,   (每轮把「共识形成」    durable、一等公民、        (幂等消费:        (无状态,
 受监督,S1)     作为不可变事件落库,    UNIQUE 去重、可回放        fresh→开仓        随意重启)
                不管跟没跟)                                     stale→标 missed)
```

核心:把「信号」从内存幻影升格为**持久化一等公民**。检测(发现事实)与执行(对事实做决策)彻底解耦。

## 4. 信号台账 schema(S2 核心)

```sql
CREATE TABLE IF NOT EXISTS consensus_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id     INTEGER,           -- 形成时刻依赖策略阈值(第 N 人跨线),故信号按策略记
  condition_id    TEXT,
  outcome         TEXT,
  asset           TEXT,
  outcome_index   INTEGER,
  title           TEXT,
  event_slug      TEXT,
  formation_ts    INTEGER NOT NULL,  -- 第 minWallets 个合格钱包 last-upward-crossing 时刻
  formation_price REAL,              -- fetchPriceAt(asset, formation_ts, {atOrBefore:true}),可 null 后补
  wallet_count    INTEGER,
  total_net_usd   REAL,
  avg_buy_price   REAL,              -- 聪明钱成本参照
  members_json    TEXT,              -- 形成时刻成员快照(wallet/netUsd/qualifiedTs),审计用
  detected_ts     INTEGER NOT NULL,  -- 检测器首次观测到该信号的时刻(detected_ts − formation_ts = 检测延迟,直接可查)
  status          TEXT NOT NULL,     -- 'followed' | 'missed_stale' | 'skipped_contested'
                                     -- | 'skipped_deviation' | 'skipped_no_price' | 'skipped_closed'
  -- 结算回填(missed 也回填——"错过的如果跟了会怎样"就是这几列)
  resolved        INTEGER DEFAULT 0,
  resolution_price REAL,
  hypo_pnl        REAL,              -- 假想 $sizeUsd 按 formation_price 进场持有到结算的盈亏(纯归因,非真实仓)
  UNIQUE(strategy_id, condition_id, outcome, formation_ts)
);
```

要点:

- **UNIQUE 含 formation_ts**:同一 (策略,市场,结果) 允许多次形成(掉出窗口后再形成是新信号);同一次形成幂等去重。
- **status 记录执行器的决策与理由**:跟了、错过(stale)、被互斥/护栏/缺价/已结算拦下——每类都可统计,护栏的机会成本从此可见(这正是 backlog E「虚拟限价单」的地基)。
- **hypo_pnl 红线**:与 formation_price/markout 同一纪律——只用于归因展示,绝不混入 follow_positions 的真实纸面 P&L。两套账目在 UI 上必须分区呈现。

## 5. 检测器与执行器语义

### 检测器(每轮,现 followLoop 的检测半段)

1. 拉 6h 窗口 → 每策略 detectConsensus(P1 已实现)→ 分歧互斥(已实现)。
2. 对每个组:`INSERT OR IGNORE INTO consensus_signals`(status 先按执行结果写;见下)。**stale 的组不再直接丢弃**——落库为 `missed_stale`,这是本设计与现状的关键差异。
3. formation_price 取价失败 → null 落库,后续轮次补填(immutable,填一次)。

### 执行器(同轮紧随,或独立消费)

对本轮新增(INSERT 成功)的信号行:

- `now − formation_ts ≤ freshSec` 且非分歧且护栏通过且有价且未结算 → 开仓(follow_positions 现有逻辑),信号标 `followed`;
- 否则按拦截原因标 `missed_stale` / `skipped_*`。
- follow_positions 可加 `signal_id` 外键(可空,兼容旧仓),形成"信号→仓位"的完整因果链。

### 结算回填(missed 也回)

复用 gamma closed/outcomePrices:对 `resolved=0` 的信号回填 `resolution_price` 与 `hypo_pnl = sizeUsd/formation_price × (resolution_price − formation_price)`(formation_price null 则 hypo_pnl null)。看板新增「错过信号」分区:错过了多少、假想盈亏多少——停机/护栏的机会成本变成数字。

### 停机自愈

重启后第一轮:窗口回算会重建停机期间(<6h)形成的共识 → INSERT 补记(formation_ts 是历史值,status 自然落 `missed_stale`)→ 台账无空洞。>6h 的空窗诚实存在(窗口回算极限),日志标注。

## 6. 分阶段实施

| 阶段   | 内容                                                                                                                                           | 改动量                  | 治理                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------- |
| **S1** | 标准部署改为 worker(引擎)+ web(只读)分离,worker 受监督(docker compose 已具备 restart 策略;文档写明"内嵌模式仅限本地调试")                      | 零改码,改 README 部署节 | P-1                     |
| **S2** | consensus_signals 台账 + 检测/执行拆分 + missed/hypo_pnl 回填 + /follow 页「错过信号」分区                                                     | 中(~P1 规模)            | **P-3(要害)**           |
| **S3** | 循环改为可被外部调度器(cron/systemd timer)触发的幂等 runOnce CLI(claim 锁已保证安全);4s 告警循环保留常驻(cron 无法承载),仅共识/follow/播种外置 | 小                      | P-2                     |
| 远期   | 事件驱动摄取(WS/链上)、全量成交归档                                                                                                            | 大                      | 等 markout/台账数据说话 |

推荐顺序:**S2 → S1(文档) → S3**。S2 收益最大且独立;S1 是部署习惯;S3 在 S2 之后做才有意义(执行器已是幂等消费者)。

## 7. 测试策略(S2)

- 台账幂等:同一形成事件两轮 INSERT 只落一行;
- 停机重建:构造"formation_ts 在过去、首次观测在现在"的窗口 → 补记为 missed_stale;
- 状态机:followed/missed/skipped_* 各拦截路径逐一断言;
- hypo_pnl 回填与红线(不触碰 follow_positions.realized_pnl);
- follow_positions.signal_id 因果链;旧仓(无 signal_id)兼容。

## 8. 风险与边界

- 台账体量:每策略每形成一行,6h 窗口 + UNIQUE 去重下增速温和;必要时加保留期清理(参照 seen_trades 7 天范式,但信号建议长期保留——它就是回测资产)。
- formation_price 补填的 HTTP 次数:按 (asset, 10min K 线) 缓存合并;每轮限量(参照 markout 回填的防饿死范式:新信号优先 + 截止期)。
- 双进程(内嵌+worker)并发检测:UNIQUE 天然去重,status 以先写者为准——可接受;文档仍建议单引擎。
