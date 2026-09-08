# 增量窗口维护(windowKeeper)与共识循环提频设计

2026-09-08。状态:已实现(lib/windowKeeper.ts + lib/polymarket.ts getTradesSince
+ worker/embeddedEngine.ts 接线)。

## 背景与量测

下游按 webhook payload 的 `signal.formationTs` 做新鲜度风控,实测(2026-09-07,
18 条样本)formation→emitted 中位 ~329s、最大 790s,多次被误判为过期信号。
拆解结论:投递侧健康(webhook `minEmitAgeSec=0`,30s 投递轮,实测 emitted→
收到仅 6–38s);延迟主项是**检测节奏** —— 共识循环每 5 分钟一轮,`emittedAt`
是"下一轮扫到它的那一轮"的时钟,`formationTs` 是从成交时间戳回算的"共识在
市场上客观成立的时刻",两者之差结构上就是 0 ~ 一个周期(守卫顺延时 +1 周期,
硬上界 = 各档 freshSec,默认 900s —— 790s 贴着上界,证伪了队列积压假设)。

节奏钉在 5 分钟的原因是成本结构:每轮用 getTradesWindowDeep 全量重拉 6h 窗口。
实测(2026-09-08,$2k 档):6h 窗口 BUY ~830 行 / SELL ~200 行,共 ~1030 行、
~5 页 HTTP;两轮之间的新增仅 ~14 行 —— **98.6% 是重复抓取**,且窗口数据轮末
即弃、无任何留存。offset 探测:BUY 侧 3000 行深度 ≈ 23.7h,当日无截断。

## 核心概念:两个窗口必须解耦

- **分析窗口(6h,不可动)**:检测器需要看见的历史。共识 = N 个钱包各自在
  窗口内净买 ≥ 阈值,腿跨小时累积;第 1..N−1 条腿可以很旧,只有第 N 条腿
  (触发跨线)受 freshSec 约束。缩分析窗口 = 改信号定义(所有腿都得挤进短窗
  口),同时对冲者剔除/分歧互斥因失忆而失效 —— 漏报与错报齐升。曾评估过的
  「30 分钟窗口」方案因此否定。
- **抓取窗口(成本参数)**:每轮需要传输的数据。没有本地留存时它被迫等于
  分析窗口;有了常驻缓冲,它只需覆盖两轮之间的增量。

## 机制(lib/windowKeeper.ts)

常驻内存缓冲(Map<dedupKey, Trade>)+ 水位线(缓冲中最新行 ts):

1. **种子**:首轮 getTradesWindowDeep 全量扫(现成代码),记 coverageStartSec
   = effectiveSinceSec(种子截断如实继承,随时间下界推进自愈);
2. **每轮(90s)**:getTradesSince 从最新往回翻,翻到 `水位线 − 180s 边距`
   即停;connected=true 才合并(去重吸收边距重叠),否则整体丢弃退回全量扫;
3. **淘汰**:滚出 6h 的行出账;行数上限 30k(≈40 MB 最坏)整秒切齐淘汰最旧,
   coverageStartSec 如实上移;
4. **自愈**:每小时定时全量重扫(上游迟到入索引的成交落在水位线之下,增量
   扫永远看不见 —— 定时重扫是有界兜底,把旧设计"每 5 分钟全量自愈"降级保留);
5. **返回形状与 getTradesWindowDeep 逐字段一致**,四个窗口消费者(共识告警 /
   firehose / 跟单 / cohort)零改动。

## 不变量与 fail-closed

唯一硬不变量:**净买账完整性**。检测按窗口内 BUY−SELL 净敞口算,缓冲漏一笔
SELL 即虚增净买,可能造出假共识与错误 formationTs,且静默。所有失败路径为
此收口:

- 不衔接(页预算耗尽 / offset 上限 / 翻页途中失败)→ 前缀丢弃 + 当轮全量重扫;
- 重扫也失败 → 供给「陈旧但完整」的既有缓冲(陈旧 ≠ 残缺,不标 truncated);
- 陈旧超过 300s(= 旧设计一轮的岁数,已被接受过的陈旧度)仍拿不到数据 →
  tick 抛错,engine catch 跳过本轮 beat —— 上游停摆必须对健康监控可见
  (「安静和死了不长得一样」),不能被一个永远返回旧缓冲的 keeper 掩盖;
- 缓冲不完整(种子截断 / 行数上限)→ truncated + effectiveSinceSec 如实上报,
  runFollowCycle 既有纪律拒绝开仓,共识推送附覆盖率标注。

## 参数

| 参数 | 值 | 位置 |
| --- | --- | --- |
| 周期 | 90s(原 300s) | embeddedEngine CONSENSUS_INTERVAL_MS |
| 分析窗口 | 6h 不变 | CONSENSUS_WINDOW_SEC |
| 安全边距 | 180s | windowKeeper WINDOW_MARGIN_SEC |
| 增量页 | 100 行 × 最多 8 页 | polymarket SINCE_PAGE_LIMIT / SINCE_MAX_PAGES |
| 行数上限 | 30_000(≈40 MB) | windowKeeper MAX_BUFFER_ROWS |
| 定时重扫 | 3600s | windowKeeper RESWEEP_INTERVAL_SEC |
| 陈旧限度 | 300s | windowKeeper STALE_LIMIT_SEC |

预期:formation→emitted 中位 ~329s → ~55–75s(90s 周期均匀等待均值 ~45s +
轮内垫时);稳态传输 ~1030 行/5min → ~50–100 行/90s 轮;热点日抓取成本与
密度解耦(单轮新增 <800 行内恒 1–8 页)。

## 回滚

config 表 `follow_window_mode` = `'full'` → 每轮全量重扫(老抓取路径),下一轮
生效无需重启;删除该行或任何其它值 = 增量(默认)。节奏不随开关回退 —— 90s
全量在实测密度下可承受(~5 页/轮),开关隔离的是增量机制自身的风险。

## 行为变化(提频的副作用,需知会下游)

- 「首发共识」档(freshSec=300)此前在 5 分钟节奏下漏掉相当比例的形成,提频
  后捕获率上升 —— 该档信号量明显增加(回归设计意图);
- 更早评估 → 现价更贴近形成价 → 10¢ 追价闸通过率上升,各档信号量普遍略增;
  入场系统性更早,战绩口径在切换点出现断点,前后不可直接比较;
- 共识 TG 升级推送可能更碎(5 分钟内 3→5 人原来合并一条,现在可能 3→4、4→5
  两条);
- cycle_metrics 写入 288 → 1440 行/天(无保留清理,~40 MB/年,暂可接受)。

## 测试

lib/windowKeeper.test.ts(种子 / 增量合并去重 / 边界钳制 / 时间淘汰与截断自愈 /
不衔接回退 / 瞬态失败供旧 / 陈旧超限抛错 / 种子失败抛错 / 定时重扫 / 回滚模式 /
行数上限整秒切);lib/polymarket.test.ts 补 getTradesSince 的 connected 三态
(见边界行 / 短页到底 / 预算耗尽 / 翻页途中失败与首页失败)。
