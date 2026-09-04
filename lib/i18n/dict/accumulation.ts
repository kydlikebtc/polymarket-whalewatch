// accumulation 页字典分片 —— 键=中文原文,值=英文译文。由该页改造代理独家填写。
export const DICT_ACCUMULATION: Record<string, string> = {
  // Header（Etherscan 皮：12px 小标 + 24/600 标题 + 14px 描述）。
  // 标题键「拆单累计」与刷新时间「最后刷新 {time}」分别由 common / follow
  // 分片供给,同键同值不在此重复。
  "🧩 绕过单笔监控的建仓": "🧩 Position-building that slips past fill alerts",
  "同一钱包在同一市场的多笔小额买入合并成一条 —— 单笔监控看不到的建仓方式。":
    "Many small buys by one wallet in one market, folded into a single row — the way of building a position that single-fill monitoring never sees.",
  "拆单 / 累计买入榜": "Split-Buy / Accumulation Board",
  "按 (钱包·市场·结果) 聚合多笔小额买入，揪出绕过单笔监控的累积建仓":
    "Aggregates small buys by (wallet · market · outcome) to catch accumulation built to slip past single-trade monitoring",
  " · 最后刷新 {time}": " · last refreshed {time}",
  " · 加载中…": " · loading…",

  // Controls
  时间窗: "Window",
  精度: "Precision",
  "floor 越低越能抓到小额拆单，但时间窗越短":
    "A lower floor catches smaller split-buys but covers a shorter window",
  净买入: "Net buy",
  "自定义 USD": "Custom USD",
  "当前净买入 ≥": "Current net buy-in ≥",
  刷新: "Refresh",
  "自动刷新 30s": "Auto-refresh 30s",
  "精度 floor": "Precision floor",
  " · 每笔 < $10k 才算拆单 · ≥3 笔买入 · 低于 floor 的卖出不可见，净买入为上界":
    " · only sub-$10k fills count as split-buys · ≥3 buys · sells below the floor are invisible, so net buy-in is an upper bound",

  // Error / stats / coverage callouts
  "扫描失败: {err}": "Scan failed: {err}",
  累积者数: "Accumulators",
  合计净买入: "Total net buy",
  最大净买入: "Max net buy",
  // KPI 分格卡的值与副行（第四格把当前筛选与覆盖窗口摆到台面上）
  "{n} 个钱包": "{n} wallets",
  "当前 {h}H 窗口": "Current {h}H window",
  统计口径: "Methodology",
  "{h}H · floor ${f}": "{h}H · floor ${f}",
  "≥3 笔 · 每笔 <$10k": "≥3 fills · each <$10k",
  " · 覆盖自 {time}": " · covered since {time}",
  "成交太密集，API 回看深度已用满 — 以下为完整覆盖时段":
    "Trade flow too dense — API look-back depth exhausted; the span below is fully covered",
  "实际覆盖 {span}（自 {time} 起）": "Actual coverage {span} (since {time})",
  "~{m} 分钟": "~{m} min",
  "~{h} 小时": "~{h}h",
  "~{h} 小时 {m} 分": "~{h}h {m}m",

  // Table states
  "上游缓存预热中，自动重试…":
    "Upstream cache warming up — retrying automatically…",
  "正在聚合 {hours}h 内的拆单买入 — 深度拉取首次约 5-15 秒，请稍候…":
    "Aggregating split-buys from the last {hours}h — the first deep pull takes ~5-15s, please wait…",
  该条件下暂无拆单累计: "No split-buy accumulation under these filters",
  "放宽净买入门槛、降低精度 floor 或拉长时间窗，再看一次。":
    "Loosen the net-buy floor, lower the precision floor, or widen the window, then look again.",

  // 主表卡：标题条 + 卡底说明条
  拆单累计榜: "Accumulation board",
  "· 共 {n} 组": "· {n} groups",
  "净买入取成本敞口口径（留存净股数 × 买入均价）；带「对冲?」「做市?」标记的组默认沉底，不与干净的定向建仓争排名。":
    "Net buy-in uses the cost-basis exposure definition (retained net shares × average buy price); groups flagged “Hedge?” or “MM?” sink to the bottom by default instead of competing with clean directional accumulation.",

  // Table headers (+ mobile data-labels)
  钱包: "Wallet",
  地址年龄: "Wallet age",
  // 地址年龄并进钱包列后的合并列名（见 app/accumulation/page.tsx 表头注释）
  "钱包 · 地址年龄": "Wallet · Age",
  战绩: "Record",
  "已结算市场胜率 · 已实现盈亏（🏆 = 聪明钱白名单）":
    "Settled-market win rate · realized PnL (🏆 = smart-money whitelist)",
  "市场 · 结果": "Market · Outcome",
  标记: "Flags",
  "对冲嫌疑 = 同钱包也净买入了同市场的对侧结果；做市嫌疑 = 买卖高频交替。两类默认沉底":
    "Hedge suspicion = the wallet also net-bought the opposing outcome in this market; MM suspicion = rapid buy/sell flipping. Both sink to the bottom by default",
  // 表头缩短版：口径收进 (?) 的 title，列名不背长口径
  赔率: "Odds",
  时间: "Time",
  点击按净买入排序: "Click to sort by net buy-in",
  点击按笔数排序: "Click to sort by fill count",
  点击按单笔最大排序: "Click to sort by max single buy",
  点击按毛买入排序: "Click to sort by gross buy",
  笔数: "Fills",
  单笔最大: "Max Single",
  毛买入: "Gross Buy",
  毛卖出: "Gross Sell",
  "结果名与标记跟在市场名下方：对冲嫌疑 = 同钱包也净买入了同市场的对侧结果；做市嫌疑 = 买卖高频交替。两类默认沉底":
    "Outcome name and flags sit under the market name. Hedge suspect = the same wallet also net-bought the opposite outcome of this market; MM suspect = rapid buy/sell alternation. Both sink to the bottom by default",
  "仅统计 ≥ 精度 floor 的卖出——更小的卖单在此精度下不可见，净买入应视为上界":
    "Counts only sells ≥ the precision floor — smaller sells are invisible at this precision, so treat net buy-in as an upper bound",

  // Row cells
  点击收起明细: "Click to collapse details",
  点击展开底层买单: "Click to expand underlying buys",
  "同钱包在同市场的对侧结果也有净买入——对冲/套利嫌疑，方向意图存疑。":
    "The same wallet also net-bought the opposing outcome in this market — hedge/arb suspicion, directional intent questionable. ",
  "按 1−价格 折算对侧买入后，本方向净买入约 ${n}（仅二元市场折算）。":
    "Converting the opposing buys at 1−price, net buy-in on this side is ≈${n} (binary markets only). ",
  "多结果市场仅标记不折算。":
    "Multi-outcome markets are flagged, not converted. ",
  默认沉底: "Sinks to the bottom by default",
  "对冲?": "Hedge?",
  "买卖高频交替（换向率 {pct}%，仅统计 ≥floor 的可见单，实际只高不低）——更像做市库存管理而非定向建仓。默认沉底":
    "Rapid buy/sell flipping (flip rate {pct}%, counting only visible fills ≥floor — the true rate is higher) — looks like market-maker inventory management rather than directional accumulation. Sinks to the bottom by default",
  "做市?": "MM?",
  "按 size 加权的平均买入价（赔率）": "Size-weighted average buy price (odds)",
  "首笔 {first} → 末笔 {last}": "First {first} → last {last}",
  "成本敞口 = 留存净股数 × 买入均价（{shares} 股 × {price}¢）· 窗口现金流 ${cashflow}":
    "Cost-basis exposure = retained net shares × avg buy price ({shares} shares × {price}¢) · window cashflow ${cashflow}",
  "{n} 买": "{n} buys",

  // Expanded detail (AccumDetail)
  "当前持仓（{outcome}）：": "Current position ({outcome}): ",
  " · 同市场其他结果：": " · other outcomes in this market: ",
  "、": ", ",
  "底层买单（共 {n} 笔，最新在前）":
    "Underlying buys ({n} fills, newest first)",
  金额: "Amount",
  "价格(赔率)": "Price (odds)",

  // Render-cap footer
  "显示其余 {n} 行": "Show remaining {n} rows",
  "统计卡已包含全部 {n} 组": "Stat cards already include all {n} groups",
};
