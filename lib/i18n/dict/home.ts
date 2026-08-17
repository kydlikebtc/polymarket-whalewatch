// home 页字典分片 —— 键=中文原文,值=英文译文。由该页改造代理独家填写。
export const DICT_HOME: Record<string, string> = {
  // Header
  "24h 大额成交扫描器": "24h Whale Trade Scanner",
  "实时查询 Polymarket 公共 API（不落库）":
    "Queried live from Polymarket's public API (nothing stored)",
  " · 最后刷新 {time}": " · last refreshed {time}",
  " · 加载中…": " · loading…",

  // Filter controls
  金额: "Amount",
  最低金额: "Min amount",
  "自定义 USD": "Custom USD",
  "当前 ≥": "Currently ≥",
  方向: "Side",
  全部: "All",
  "买入 BUY": "Buy",
  "卖出 SELL": "Sell",
  时间: "Time",
  时间窗: "Window",
  刷新: "Refresh",
  "自动刷新 30s": "Auto-refresh 30s",
  价格: "Price",
  清除: "Clear",
  "赔率 0–1": "Odds 0–1",
  类型: "Type",
  市场类型: "Market type",
  地址年龄: "Wallet age",
  "≤1天": "≤1d",
  "≤7天": "≤7d",
  "≤30天": "≤30d",
  天: "days",

  // Callouts / stat cards / filtered count
  "扫描失败: {msg}": "Scan failed: {msg}",
  笔数: "Fills",
  总额: "Total volume",
  "买额 vs 卖额": "Buy vs sell volume",
  "买 {amt}": "Buy {amt}",
  "卖 {amt}": "Sell {amt}",
  最大单: "Largest trade",
  "成交太密集，API 回看深度已用满 — 时间窗尾部的部分成交未覆盖":
    "Trades too dense — API lookback depth exhausted; part of the tail of the window is not covered",
  符合筛选: "Matched",
  笔: "trades",
  " · 地址年龄加载中，结果将随加载补全":
    " · wallet ages still loading; results fill in as they resolve",

  // Table area states
  "上游缓存预热中，自动重试…":
    "Upstream cache warming up — retrying automatically…",
  "正在扫描 {hours}h 成交 — 深度拉取首次约 5-15 秒，请稍候…":
    "Scanning {hours}h of trades — the first deep pull takes ~5-15s, please wait…",
  "该筛选条件下 {hours}h 内暂无成交":
    "No trades in the last {hours}h under these filters",

  // Table header / row overflow
  点击按时间排序: "Click to sort by time",
  "市场 / 结果": "Market / outcome",
  点击按金额排序: "Click to sort by amount",
  钱包: "Wallet",
  "已结算市场胜率 · 已实现盈亏（🏆 = 聪明钱白名单）":
    "Settled-market win rate · realized PnL (🏆 = smart-money whitelist)",
  战绩: "Record",
  "显示其余 {n} 行": "Show remaining {n} rows",
  "统计卡与「符合筛选」计数已包含全部 {n} 笔":
    "Stat cards and the “Matched” count already include all {n} trades",

  // Category labels (lib/categoryLabel.ts 产出的一级中文名;chips 与行内
  // 「一级·二级」合成标签共用。拉丁名(NBA/F1 等)透传,无需键)。
  政治: "Politics",
  选举: "Elections",
  体育: "Sports",
  电竞: "Esports",
  加密: "Crypto",
  经济: "Economy",
  金融: "Finance",
  商业: "Business",
  科技: "Tech",
  科学: "Science",
  文娱: "Pop culture",
  国际: "World",
  天气: "Weather",
  游戏: "Games",
  其他: "Other",

  // Category labels (二级中文译名 → 英文原名回译)
  足球: "Soccer",
  网球: "Tennis",
  高尔夫: "Golf",
  拳击: "Boxing",
  综合格斗: "MMA",
  板球: "Cricket",
  橄榄球: "Rugby",
  大学橄榄球: "College Football",
  大学篮球: "College Basketball",
  英雄联盟: "League of Legends",
  无畏契约: "Valorant",
  比特币: "Bitcoin",
  以太坊: "Ethereum",
  狗狗币: "Dogecoin",
  地缘政治: "Geopolitics",
};
