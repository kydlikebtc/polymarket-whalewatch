# 信号行向前落库(wallets_json)— 设计文档

> 日期:2026-08-28
> 状态:walk-forward 批次(PR #15)点名的 v2 前置,同日开工
> 上位资料:[walk-forward 设计](2026-08-28-walkforward-rederivation-design.md) §5(score 维原表)·
> [walk-forward 实现计划](2026-08-28-walkforward-rederivation.md) §0.4(不可回放裁决)

## 1. 问题:两个维度不可回放,因为事实从未被记录——且只能向前补

walk-forward v1 实现期确证了两个「可观测锥外」的维度:

- **score 下限维**:仓位/信号行都没记「触发钱包 + 彼时评分」。`smart_wallets.score`
  是当前值,拿它回填历史 = 前视污染(分数本身部分来自这些仓位之后的结果)。
  v1 整维弃用,以 minNetUsd 平移顶替,报告固定段落写明「需先向前落 wallet+score(v2)」。
- **minPerWalletUsd**:逐钱包金额未落库,只能 `total/count` 均值近似——
  真收紧子集(每钱包 ≥X)的**超集**,报告逐份声明。

这两样**无法回填,只能从落地那天起向前记**。晚一天上线 = 下月/下下月的
walk-forward 永久少一天可回放窗口——这是本批唯一的时间压力来源,也是它插队
在渠道记分卡之前的理由。

## 2. 方案:候选契约加一个纯归因字段,台账加一列 JSON

### 2.1 数据在哪(勘探结论:detector 手里全都有)

| 源                       | 每钱包金额                                       | 彼时评分                             | 锚点                               |
| ------------------------ | ------------------------------------------------ | ------------------------------------ | ---------------------------------- |
| consensus                | `ConsensusGroup.wallets`(ConsensusWallet.netUsd) | 同结构自带 `score`                   | sourceConsensus.ts 候选构造(~L118) |
| heavy                    | 单笔 `usd`                                       | 循环内 `tag.score`(ctx.smart)        | sourceHeavy.ts (~L77)              |
| lone_wolf / early_winner | 聚合 `netUsd`                                    | `ctx.smart.get(entry.wallet)?.score` | sourceWallet.ts (~L220)            |
| lopsided                 | `chosen.wallets`(DisagreementWallet.netUsd)      | 同结构自带 `score`                   | sourceLopsided.ts (~L164)          |
| resolved                 | `lead.wallets`                                   | 同上                                 | sourceResolved.ts (~L184)          |

score 的语义 = **检测时刻可见的评分快照**(ctx.smart 是引擎每轮预取的
smart_wallets 值)。这恰是 walk-forward 要的:重放「当时的引擎按什么分数
能不能把这仓拦下来」;不是 formation 瞬间的分(评分按天更新,粒度足够),
注释写明。`score: null` = 当时无分,诚实落 null。

### 2.2 契约与落库形态

- `FollowCandidate` 增**可选**字段
  `wallets?: CandidateWallet[]`,`CandidateWallet = { wallet: string; netUsd: number; score: number | null }`。
  与 walletCount/totalNetUsd 同一条纪律:**纯归因,不参与任何开仓判定**;
  可选使六个 detector 可以逐个接、缺省不破坏任何既有路径。
- `strategy_signals` 增列 `wallets_json TEXT`(JSON 数组,键名与类型字段
  逐字一致,不缩写);`recordStrategySignal` 输入增可选 `wallets`,有则
  序列化写入,无则 NULL。老行天然 NULL = 「该行早于本批」自描述,v2 的
  walkforward 直接按 `wallets_json IS NOT NULL` 划覆盖窗,无需另记起始日。
- **记全,不截断**:一边倒分歧的边可能有几十个钱包,但 cap 恰好会重造
  「必要不充分」问题(漏记的钱包让「每钱包 ≥X」永远判不了)。JSON 行
  KB 级、每天几十条信号,行体积不构成理由。
- 顺序保持 detector 给出的序(netUsd 降序,来源本就有序),落库不重排。
- reverse 档零改动自动正确:反向档与被对照档共用同一次检测(翻边发生在
  开仓侧),wallets 记的是同一份信号事实——对照组同源,正是想要的。

### 2.3 对外面:惰性,本批零消费方改动(逐处已核对)

- `strategyFeed` 两处 `SELECT *` 只是取数,active[]/settled[] 输出是
  **显式手工投影**(逐字段点名),新列不出现;
- webhook `buildSignalEvent` 逐字段构造 SignalEventV1,TG 模板读具名字段,
  datasetExport / adminOverview / recordFeed / signalDigest 全部显式列 SELECT。
- 是否把 wallets 开放给订阅方是**另一个批次的产品决定**(涉及 api-access.md
  三处同步与信息量权衡),本批刻意不做;补一条**惰性守卫测试**:台账行带
  wallets_json 时,feed 输出与 webhook 事件里都不得出现该字段——防未来
  spread 式重构静默漏出。

### 2.4 明确不做

- 不动 lib/walkforward.ts(v2 到数据攒够那个月再接维度);
- 不动任何对外载荷/文档契约;不 cap、不脱敏(钱包地址全站本就公开展示);
- 不回填(没有可回填的事实——这正是本批存在的理由)。

## 3. 任务拆解(TDD,每任务红→绿→提交)

1. **Task A** db:`strategy_signals` 加列(CREATE TABLE + 幂等 ALTER)+
   `recordStrategySignal` 可选 wallets 序列化;测试:带/不带 wallets 的
   落库读回、JSON 逐字段还原、NULL 语义。
2. **Task B** 契约 + consensus:`CandidateWallet` 类型、
   detectConsensusCandidates 填充;测试钉 wallets.length === walletCount、
   Σ netUsd === totalNetUsd、score 透传(含 null)。
3. **Task C** heavy + lone_wolf/early_winner:单钱包数组;测试含
   「同钱包两笔取大」时 wallets 与 totalNetUsd 一致。
4. **Task D** lopsided + resolved:chosen/lead 边的 wallets 映射;测试含
   minor 边(逆势少数边档)记的是**所选边**的钱包。
5. **Task E** 接线:runFollowCycle 开仓 → recordStrategySignal 带
   wallets;followCycle 级测试断言台账行 wallets_json 落库。
6. **Task F** 惰性守卫:strategyFeed 输出与 buildSignalEvent 事件无
   wallets 字段(行里有也不漏)。
7. **Task G** docs:CHANGELOG 批次条目 + docs/README 索引与计数
   (39 份/42 份,design 27)+ 根 README roadmap 勾掉「30 天 + 重推阈值」
   总 blocker(机器已合并上线)。
8. 全套 + tsc + 真机(合成 followCycle 全链路验证 wallets_json)+ PR。

## 4. 验收

- 单元:上述逐任务;基线 1849/143 只增不减 + tsc 0。
- 真机:临时脚本以假 deps 跑 `runFollowCycle` 对临时库开仓,读回
  `strategy_signals.wallets_json` 逐字段核对;/api/signals 与 webhook 测试
  事件确认无泄漏。
- 上线后自证:新信号行 wallets_json 非空即覆盖窗开始;下月 walk-forward
  运行时按 `IS NOT NULL` 自然分窗。
