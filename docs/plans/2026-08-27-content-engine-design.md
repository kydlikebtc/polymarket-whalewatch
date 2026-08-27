# 内容引擎三件套：异常市场日榜 + 散户vs鲸鱼分歧 + 市场校准研究 — 设计文档

> 日期：2026-08-27
> 来源：[第二轮脑暴](2026-08-27-iteration-brainstorm-round2.md) #5/#6/#8，用户裁决实施
> 主题：同一份库换个问法——说的都是**市场自己的事实**，不主张自家信号 edge，
> 30 天闸门无关；三件共享一个每日聚合底座，产出天然是内容素材

## 0. 共享底座：`market_daily` 每日聚合

**为什么不是挂在 5 分钟共识循环上累加**：共识循环的 6h 窗口彼此重叠，逐轮累加
必须跨轮去重；进程重启丢内存去重集就双计。**选定：每日收盘一次性重建**——
UTC 午夜后一个独立循环把昨天的 24h 深窗口（`getTradesWindowDeep`，floor $2k，
与扫描器同源）拉一次，按 `dedupKey` 去重后逐市场聚合，`INSERT OR REPLACE`
keyed `(day, condition_id)`。成本 = 每天多一次「用户打开 24h 扫描」量级的抓取。

诚实字段：`covered_from_sec` + `truncated`（分页顶到 cap 时窗口只到截断边，
榜单页脚注如实说「该日覆盖从 HH:MM 起」）。历史不回灌——榜从部署日开始积累，
基线随天数变厚（前 3 天没有同市场基线，量能异动分量退化为横截面分位）。

金额分桶（单笔名义额）：**散户桶 $2k–10k**（floor 之下真散户不可见——文案
永远写「小单」不写「散户全量」）、中间桶隐含、**鲸鱼桶 ≥$50k**（复用
`HEAVY_MIN_USD`，与 heavy 信号同一把尺）。

每行：day / condition_id / title / slug / event_slug / category / subcategory /
trades / volume_usd / wallet_count / top_outcome（毛量最大结果）/ one_sided
（顶结果 |净流| ÷ 总量）/ small_usd·small_net_usd·small_top_outcome /
whale_usd·whale_net_usd·whale_top_outcome / price_first·price_last（顶结果日内
首末成交价）/ covered_from_sec / truncated。

新循环不进 heartbeats（日节拍配 1h 默认停跳阈值必然假警报）；新鲜度由
`/api/pulse` 的 `latestDay` 字段对外自述，页面渲染「数据到 X 日」。

## 1. 异常市场日榜（#5）

**评分在读取侧现算**（`lib/marketPulse.ts`），不落库——评分公式还会演化，
落库就要背回填。四个可解释分量（各 0..1，UI 逐项展开，遵循总纲 §4.4
「任何总分必须允许查看组成」）：

- `volSurge` 量能异动：同市场 ≤14 天基线 ≥3 天时用 `log10(今日/基线均值)`
  压到 0..1；基线不足退化为当日横截面分位（`baselineDays` 字段如实标注）。
- `oneSided` 单边度：顶结果 |净流| ÷ 总量。
- `whaleShare` 鲸鱼占比：鲸鱼桶毛量 ÷ 总量。
- `priceMove` 日内价移：顶结果 |末−首| ÷ 20¢ 封顶。

综合分 = 100 ×（0.35·volSurge + 0.25·oneSided + 0.20·whaleShare +
0.20·priceMove），取前 10。刻意不做的分量：新钱包涌入（钱包年龄缓存外的
地址要打上游，v1 不为一个分量开抓取口子——留档 v2）。

## 2. 散户 vs 鲸鱼分歧（#6）

同底座直接推导：`small_top_outcome ≠ whale_top_outcome` 且两侧材料性达标
（|小单净| ≥ $5k 且 |鲸鱼净| ≥ $50k）即入列，按 `min(|小单净|, |鲸鱼净|)`
降序。呈现为「小单在买 A · 鲸鱼在买 B」。口径脚注：小单 = $2k–10k 单笔，
不是散户全量（floor 之下不可见）。

## 3. 市场校准研究（#8）

**这不是我们的战绩页**：样本 =（alert 时点的市场隐含概率, 最终结算），回答的
是「Polymarket 的价格本身准不准」。BUY 观察贡献 q=price、SELL 贡献 q=1−price
（与 `settleWon`/`gradeRows` 同一方向约定），按 10¢ 分带对比「带内隐含均值 vs
实际胜率」。CI 用现成 `clusteredInterval`（按 condition_id 数做有效样本——
同市场多条 alert 是同一次随机事件的复制品，8-18 订正的教训直接复用）。

维度：整体 + 一级分类（读取侧从 alerts 载荷 eventSlug join event_category）。

**选择偏差必须写在页面上**：观察时点不是随机抽样，而是「鲸鱼活动触发 alert
的时刻」、市场范围是本站覆盖过的市场——结论只主张到这个样本，学术引用请带
此限定。这行脚注是本功能的可信度底线，砍谁不能砍它。

## 4. 出口

- `GET /api/pulse`（day 可选，默认最新日）与 `GET /api/calibration`：公开、
  零上游、缓存 300s、限流与 /api/record 同池纪律；api-access.md 三处同步。
- 页面 `/pulse`（日榜 + 分歧两区）与 `/calibration`（分带校准表 + 分类切换），
  进 TopNav「市场▾」组；全量 i18n。
- **X 播报接入刻意不在本批**：新增播报内容类型要动 xQuota/模板/manage 三处，
  独立批次（拆单任务跟进）。

## 5. 测试

- 聚合纯函数：分桶边界（恰 $10k/$50k）、dedup、顶结果判定、首末价、截断字段。
- 评分：基线充足/不足两态、分量边界、top10 排序稳定性。
- 分歧：材料性双门槛、同向不入列。
- 校准:方向约定（SELL 反号）、分带、聚簇 CI 生效（markets < n 时区间变宽）。
- 真机：种子库跑一轮日聚合 + 两页渲染截图 + i18n 双语。
