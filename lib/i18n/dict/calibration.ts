// /calibration 市场校准字典分片 —— 键=中文原文,值=英文译文。
export const DICT_CALIBRATION: Record<string, string> = {
  市场校准: "Market Calibration",
  "Polymarket 的价格本身准不准：按赔率带对比「市场隐含概率」与「实际发生率」。这不是本站信号的战绩页。":
    "How well-calibrated are Polymarket's own prices: per odds band, market-implied probability vs realized frequency. This is NOT this site's signal record.",
  "选择偏差声明：样本 = 本站 alert 触发时点的市场价格观察（大额/聪明钱活动时刻，非随机抽样），市场范围 = 本站覆盖过的市场。结论只主张到这个样本；置信区间按市场数聚簇（同市场多条 alert 是同一次随机事件的复制品）。":
    "Selection-bias disclosure: observations are market prices at this site's alert moments (whale / smart-money activity, not random sampling), over markets this site has covered. Conclusions extend to this sample only; confidence intervals are clustered by market count (multiple alerts on one market are copies of a single random event).",
  "尚无已结算的观察样本 —— 结算回填持续积累中。":
    "No settled observations yet — settlement backfill is accumulating.",
  总体: "Overall",
  分组: "Group",
  "{n} 条观察 · {m} 个去重市场": "{n} observations · {m} distinct markets",
  观察数: "Obs",
  市场数: "Markets",
  隐含均值: "Implied mean",
  实际发生率: "Realized rate",
  "95% 区间（聚簇）": "95% CI (clustered)",
  偏差: "Gap",
  "读法：偏差 = 实际发生率 − 隐含均值。正 = 该价位历史上被低估（便宜），负 = 被高估；只有当隐含均值落在聚簇 95% 区间之外时，偏差才谈得上统计显著。样本随结算回填每日增长。":
    "Reading: gap = realized − implied. Positive = that band has been historically underpriced (cheap), negative = overpriced; a gap only counts as significant when the implied mean falls outside the clustered 95% interval. The sample grows daily with settlement backfill.",
};
