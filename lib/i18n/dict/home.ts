// home 页字典分片 —— 键=中文原文,值=英文译文。由该页改造代理独家填写。
export const DICT_HOME: Record<string, string> = {
  // Header
  "24h 大额成交扫描器": "24h Whale Trade Scanner",
  "实时查询 Polymarket 公共 API（不落库）":
    "Queried live from Polymarket's public API (nothing stored)",
  " · 最后刷新 {time}": " · last refreshed {time}",
  " · 加载中…": " · loading…",
  // Etherscan 风页头:12px 小标 + 24/600 标题 + ≤700px 描述
  "实时扫描 · 不落库 · 时间 UTC": "Live scan · nothing stored · times in UTC",
  大额成交扫描器: "Whale Trade Scanner",
  "按金额、方向、时间窗、赔率与地址年龄筛出单笔大额成交；每一行都能点进钱包档案与市场信号卡。":
    "Filter single large fills by size, side, time window, odds and wallet age — every row opens the wallet dossier and the market signal card.",

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
  // KPI 分格卡副行 / 卡内标题条（Etherscan 风改版）
  "显示前 {n} 条": "Showing the first {n}",
  已全部显示: "All rows shown",
  "单笔 ≥ {amt}": "Per fill ≥ {amt}",
  "买 / 卖 · 买方占 {pct}%": "Buy / sell · buy side {pct}%",
  "共 {n} 笔符合筛选": "{n} fills match the filters",
  "（显示前 {n} 条）": " (showing the first {n})",
  "地址年龄加载中，结果将随加载补全":
    "Wallet ages still loading; results fill in as they resolve",
  // 降级态说明条（表下方琥珀条）——「—」是判不了，不是零
  "「…」= 地址年龄 / 战绩仍在后台补齐，结果会自己填上；「—」= 判不了，不是零 —— 战绩列的「—」表示该钱包没有可统计的已结算市场，不代表 0 胜率。":
    "“…” = wallet age / record still being filled in the background; it resolves on its own. “—” = undecidable, not zero — a “—” in the Record column means the wallet has no settled markets to score, not a 0% win rate.",

  // Table area states
  "上游缓存预热中，自动重试…":
    "Upstream cache warming up — retrying automatically…",
  "正在扫描 {hours}h 成交 — 深度拉取首次约 5-15 秒，请稍候…":
    "Scanning {hours}h of trades — the first deep pull takes ~5-15s, please wait…",
  "该筛选条件下 {hours}h 内暂无成交":
    "No trades in the last {hours}h under these filters",
  // 空态的「出路」—— 每个空态都给内容也给下一步
  "首次深拉会把上游缓存烧热，重试通常就成了；也可以直接点「刷新」。":
    "The first deep pull warms the upstream cache, so the retry usually goes through — or just hit Refresh.",
  "嫌慢就把时间窗切到 1h：窗口越短，回看深度越浅。":
    "Too slow? Switch the window to 1h — a shorter window needs less lookback.",
  "试试降低金额门槛、把时间窗切到 24h，或清掉价格区间 / 类型 / 地址年龄这三项客户端筛选。":
    "Try a lower amount floor, switch the window to 24h, or clear the price band / type / wallet-age client-side filters.",
  "正在准备扫描…": "Getting the scan ready…",
  "如果这里一直停着，点筛选条右侧的「刷新」重新发起一次拉取。":
    "If this sticks, hit Refresh on the right of the filter bar to fire a fresh pull.",

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
