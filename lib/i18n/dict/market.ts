// market 页字典分片 —— 键=中文原文,值=英文译文。由该页改造代理独家填写。
// 覆盖 /market 入口页 + /market/[conditionId] 市场信号卡两个客户端组件。
export const DICT_MARKET: Record<string, string> = {
  // -------- 入口页(app/market/page.tsx)
  "🎯 市场信号卡": "🎯 Market Signal Card",
  "粘贴 Polymarket 市场链接 / market slug / conditionId——10 秒看清这个市场里聪明钱在做什么：共识/分歧状态、留存敞口、拆单累计、新钱包异常流、本工具告警战绩。":
    "Paste a Polymarket market URL / market slug / conditionId — see in 10 seconds what smart money is doing in this market: consensus/split status, retained exposure, split-buy accumulation, fresh-wallet unusual flow, and this tool's alert record.",
  "https://polymarket.com/event/… 或 market slug 或 0x…":
    "https://polymarket.com/event/… or market slug or 0x…",
  "市场链接或 slug": "Market URL or slug",
  "解析中…": "Resolving…",
  查看: "View",
  解析失败: "Could not resolve",
  "该事件包含 {n} 个市场，选择一个：":
    "This event contains {n} markets — pick one:",

  // -------- 卡片页:加载/头部
  "加载失败：": "Failed to load: ",
  "聚合中…（拉取该市场 24h 成交并跑全部检测器）":
    "Aggregating… (fetching this market's 24h trades and running every detector)",
  "窗口近 {h}h · {n} 笔 ≥$500 成交": "window: last {h}h · {n} trades ≥$500",
  "（窗口触顶截断，指标为下界）": " (window capped — figures are lower bounds)",
  已结算: "Settled",
  "24h 量 ${v} · ": "24h vol ${v} · ",
  "流动性 ${v} · ": "Liquidity ${v} · ",
  距结算: "Settles in",
  "{n}天": "{n}d",
  "现价 · {o}": "Now · {o}",

  // -------- 共识 / 分歧判定
  聪明钱共识: "Smart-money consensus",
  "：{n} 个白名单钱包买入 ": ": {n} whitelist wallets bought ",
  " · 合计净买入 ${v} · 均价 {p}": " · combined net buys ${v} · avg {p}",
  聪明钱分歧: "Smart-money disagreement",
  "（{tilt}）：": " ({tilt}): ",
  一边倒: "lopsided",
  势均力敌: "evenly matched",
  "{o} {n} 钱包 ${v}": "{o} {n} wallets ${v}",
  "窗口内无聪明钱共识/分歧（阈值：≥2 白名单钱包各 ≥$5k 敞口）":
    "No smart-money consensus/split in window (threshold: ≥2 whitelist wallets, ≥$5k exposure each)",

  // -------- 聪明钱留存敞口
  "🏆 聪明钱留存敞口（近 {h}h · 净股数 × 买入均价）":
    "🏆 Smart-money retained exposure (last {h}h · net shares × avg buy price)",
  窗口内无白名单钱包留仓: "No whitelist wallet holding in window",
  结果: "Outcome",
  钱包: "Wallet",
  敞口: "Exposure",
  买入均价: "Avg buy price",
  "评分/胜率": "Score / win rate",
  "做市机器人：池内保留但不计入共识/分歧投票":
    "Market-maker bot: kept in the pool but excluded from consensus/split votes",

  // -------- 拆单累计
  "🧩 拆单累计（≥3 笔 · 单笔 <$10k · 敞口 ≥$2k）":
    "🧩 Split-buy accumulation (≥3 trades · each <$10k · exposure ≥$2k)",
  窗口内无拆单累计: "No split-buy accumulation in window",
  笔数: "Fills",
  均价: "Avg price",
  标记: "Flags",
  "对冲? ": "hedge? ",
  "做市?": "MM?",

  // -------- 新钱包异常流
  "🆕 新钱包异常流（账龄 ≤7 天 · 单笔 ≥$5k 买入）":
    "🆕 Fresh-wallet unusual flow (age ≤7d · single buy ≥$5k)",
  窗口内无新钱包大额买入: "No large fresh-wallet buys in window",
  账龄: "Age",
  金额: "Amount",
  价格: "Price",
  时间: "Time",
  "{n}小时": "{n}h",

  // -------- 本工具告警史
  "📐 本工具告警史（90 天内 · 含验证结果）":
    "📐 This tool's alert history (90 days · with verification)",
  该市场暂无本工具告警: "No alerts from this tool for this market yet",
  类型: "Type",
  方向: "Side",
  "信号后 1h / 24h 市场价": "Market price 1h / 24h after the signal",
  "结算验证：✅ 命中 ❌ 反向 ➖ 平":
    "Settlement check: ✅ hit ❌ wrong side ➖ push",
  结算: "Settlement",
  "🔴卖": "🔴 Sell",
  "🟢买": "🟢 Buy",
};
