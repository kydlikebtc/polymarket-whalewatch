# 市场脉搏接入 𝕏 播报（日榜/分歧两类，默认关） — 设计文档

> 日期：2026-08-27
> 来源：[内容引擎设计](2026-08-27-content-engine-design.md) §4 预留的独立批次，用户裁决实施
> 范围：xSettings/xComposer/xTemplates/xParams/xPulse(新)/engine/route//manage

## 1. 形态裁决

- **两个独立 kind（`pulse` 日榜 / `divergence` 分歧），不是一个合并 kind**：
  分歧线天然稀疏（无分歧的日子静默），运营者该能只开日榜；与既有五类
  「一类一开关一模板」的颗粒度一致。
- **默认全关**：与 `settled`、信号总线 `DEFAULT_BUS_SETTINGS` 同一纪律——
  新能力不该在运营者不知情时就往时间线上发东西。
- **时间驱动，模式照抄 xWeekly**：时刻闸 → 数据就绪闸 → 台账 dedup →
  配额 → claim/post/settle/unclaim，失败语义逐字一致。不走 alerts 队列
  （这两类不是信号事件，是市场汇总，与 pregame/weekly 同类）。
- **两类共用一个发帖时刻** `pulseUtcHour`（出厂 14:00 UTC，/manage 可配）：
  同一底座同一节奏，两个时刻字段是伪自由度。

## 2. 三道闸

1. **时刻闸**：数据凌晨就绪，但压到设定 UTC 时刻发——不在时间线死区烧预算。
2. **数据就绪闸**：`buildPulse().latestDay` 必须**恰好是昨天**。聚合迟到就等
   下一 tick；漏了一天（latestDay 更旧）**永不补发旧闻**——与 xBroadcast 的
   30 分钟新鲜度窗同一哲学。
3. **每日至多一帖**：靠台账 dedup（`pulse:<day>` / `divergence:<day>`），
   不进 `DAILY_CAP`——与 weekly 同款（dedup 是结构性约束，cap 是流控，
   一天一帖的东西不需要第二把闸）。日/周/月花费闸照常经 `quotaDecision`。

## 3. 文案

- 与 /pulse 页同源同口径（`buildPulse`，零上游）；日榜帖必须带「为什么它
  异常」的分量拆解——不能解释的总分连一条推文都撑不起来。
- 分歧帖只说 **small orders** 绝不说 retail（抓取下限之下的真散户不可见），
  与页面文案同一红线。
- 模板体系全接入：词表 `pulse: {title,day,score,why,runners,tags}`、
  `divergence: {title,smallOutcome,smallUsd,whaleOutcome,whaleUsd,kicker,tags}`；
  280/无链接两条硬不变量不因模板放开（renderCustom 安全网原样生效）。
- 次名（runners）不是 fitPost 的 {title} 锚点，标题在数据侧预截 30 字符。

## 4. 已知语义

- 永久发帖失败（4xx≠429）后该日不再重试（failed 行占住 dedup）——与
  whale 的毒帖语义一致，方向是「少发」。
- `/manage` 路由矩阵不列这两类：矩阵只列**信号线**，pregame/weekly 同样
  不在其中，这是既有分类而非遗漏。

## 5. 验证

- 14 新测试（composer 两帖的梯级/超长标题/模板回退 + 循环三道闸/dedup/
  配额拒/瞬态回滚重试/模板透传）；全套 1785 全绿、tsc 0。
- /manage 真机：两卡片出现且「已关闭」（默认关实锤）、hint 动态含
  14:00 UTC、模板编辑器带各自词表图例、`pulseUtcHour` 字段在日榜卡下。
