# 渠道效果记分卡 — 设计文档

> 日期:2026-08-28
> 状态:README roadmap 挂账条目(「per-source forward hit-rate;the source column is the groundwork」),
> 首份 walk-forward 报告(2026-08-28,零存活)当日开工
> 上位资料:[发现渠道批次](2026-07-08 前后,source 归因列)· [edge 体检](../../scripts/edge-audit.ts)
> (三层校正纪律)· [walk-forward 实现计划](2026-08-28-walkforward-rederivation.md) §0(宇宙纪律)

## 1. 问题:发现渠道跑了近两个月,从没被验收过

聪明钱池的成员来自六条路:全局榜、分类榜、四条发现渠道(echo/splitter/insider/
early_winner),外加手动白名单。`smart_wallets.source` 首发渠道归因 07-08 就铺好了,
但「哪条渠道进来的钱包**向前**真的赢」至今没有答案。挂账的悬案全堆在这里:

- 全局榜 291 成员里 72 个做市机器人,该不该留在池里(投票权已剥夺,成员资格未裁);
- 发现渠道毕业生 vs 全局榜默认池,谁更值钱;
- 首份 walk-forward 报告的深层教训:激进档随机化 p≈0.5 —— **子集怎么收紧都救不了
  没有方向技能的钱包池**。调阈值(walk-forward)之外,改池子(记分卡)才是现在最可能
  撬动 edge 的杠杆,而记分卡是池子的验收工具。

## 2. 向前观察从哪来:告警台账天然就是逐钱包的前向实验

**不需要任何新数据**。两类已被验证闭环打分的告警自带钱包归因:

- `type='smart'`(池成员单笔大额):payload 就是 Trade,`proxyWallet` 单钱包归因;
- `type='consensus'`:payload 是 ConsensusGroup 展开,`wallets[]` 成员表自带每人
  `netUsd/avgBuyPrice/score` —— 一条共识告警展开成 N 条成员观察。

时间语义(设计的关键一步):**smart/consensus 告警只对在池钱包触发**,所以每条
告警天然是「该钱包在池期间」的向前观察 —— 不需要(也没有)admitted_at 列。
source 是首发渠道(COALESCE 保序),告警按钱包 join 到渠道即得每渠道向前战绩。

**幸存者盲区(必须设独立桶,不许丢)**:30 天老化与清退会 DELETE smart_wallets 行,
离池钱包的历史告警 join 不到 source。这些行归入「已离池(来源失联)」桶如实展示 ——
丢掉它们是反向幸存者偏差(留下的都是还活着的),归错桶是编造。桶的大小本身就是
读数的一部分。

## 3. 指标口径(零新发明,三处复用)

- **逐行贡献** `contrib = won − q − feePerShare`(edge-audit 同式):q = BUY 取
  price、SELL 取 1−price;consensus 成员行用**各自的** avgBuyPrice(payload 自带,
  不用组均价 —— 每人的入场赔率是每人自己的)。
- **费用**:lib/fees takerFeeUsd(market_meta feeSchedule);**null 不猜 0**,
  fee 不可定价的行出宇宙并逐组披露(walk-forward §0.2 的最新纪律,不学 edge-audit
  的「组内一 null 整组报 null」)。
- **区间**:CRVE 聚类(cluster = conditionId),直接复用 `lib/walkforward.clusterStat`
  —— 共识告警展开成 N 成员行后同市场同结算,正是聚类要吃掉的那层相关。
- **判定**:朴素 1.96 口径给 ✅/❌/○ 行内判定 + 页脚 Bonferroni 提醒(按实际分组数
  换算临界 z,分组数是算出来的不写死);逐行等权(与 edge-audit 同,不做金额加权)。

## 4. 分组(v1 刻意压小)

| 维度       | 分组                                                                                        | 备注                                                       |
| ---------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 渠道(主表) | 全局榜 / 分类榜(细分到 cat)/ echo / splitter / insider / early_winner / 手动白名单 / 已离池 | channelOf(source) 归一                                     |
| 做市商横切 | 全局榜 × {MM, 非 MM}                                                                        | wallet_stats.markets_traded ≥ 1000,72 机器人悬案的直接读数 |
| 告警类型   | 每组内 smart / consensus 成员行分列计数                                                     | 口径透明,不各自成组(分组数爆炸)                            |

每组同时给:告警行数 / 去重钱包数 / 去重市场数 / 裸胜率 vs 隐含 / 毛 edge /
费用 / 净 edge ± 聚类 CI / 判定。

## 5. 落地形态

- `lib/channelScorecard.ts`:`loadScorecardRows(db)`(SQL + payload 解析 + join)与
  `computeChannelScorecard(rows)`(纯聚合)分开,后者 TDD 直测;输出挂进
  `DiscoveryView.scorecard`(additive 键,/api/discovery 薄壳自动透出 ——
  该端点非订阅方契约,api-access.md 无义务,已核对其 discovery 字样均指 bus 事件类型)。
- `/discovery` 页新 Segmented tab「渠道记分卡」:主表 + MM 横切 + 披露区
  (fee 失联行数 / 已离池桶 / 时间语义与幸存者声明)+ Bonferroni 页脚。
- **只展示,不接清退动作**:准入闸门与 pnl 重审已有自己的硬条件;把记分卡结论
  变成自动清退是「永不自动改」红线的另一种违反。运营者看数说话,动手走既有路径。

## 6. 明确不做(v1)

- 钱包级下钻表(推送尾行已有单钱包 30d 记录;记分卡聚焦渠道层,钱包层 v2);
- alert type='large' 的钱包(非池成员,不属渠道验收);
- 按时间折切(walk-forward 的活,不重造);
- 清退自动化;wallets_json(strategy_signals)接入 —— 那是今天才开始攒的数据,
  等覆盖窗够了由 walk-forward v2 消费。

## 7. 任务拆解(TDD)

1. **Task A** `lib/channelScorecard.ts` + test:channelOf 归一(含 null/离池/
   category 细分)、smart 行构造、consensus 成员展开(用各自 avgBuyPrice)、
   fee-null 剔除计数、MM 横切、CRVE 复用、分组数如实统计。夹具用 openDb(":memory:")
   播种 alerts/alert_outcomes/smart_wallets/wallet_stats/market_meta。
2. **Task B** `DiscoveryView.scorecard` 接线 + test(additive,旧消费者零感知)。
3. **Task C** `/discovery` 新 tab 渲染(表格 + 披露 + 页脚)。
4. **Task D** docs:本文档入索引(40/43)、CHANGELOG 批次条目、README roadmap
   勾掉 scorecard 行。
5. **Task E** 全套 + tsc + 真机(演示库播种告警与结局跑页面截图)+ PR。

## 8. 验收

- 单元:分组归一逐值、共识展开数量与去重、离池桶、fee-null 披露、判定红绿、
  分组计数;基线 1862/143 只增不减 + tsc 0。
- 真机:演示库上主表渲染、三个披露读数与播种数据手工对账;线上部署后首次
  真实读数(全局榜 vs 发现渠道 vs MM)写进 PR 或后续运营记录。
