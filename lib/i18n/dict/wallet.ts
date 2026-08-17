// wallet 页字典分片 —— 键=中文原文,值=英文译文。由该页改造代理独家填写。
export const DICT_WALLET: Record<string, string> = {
  // -------- header:身份标签与来源链接
  "🏆 聪明钱": "🏆 Smart money",
  " · 评分 {n}": " · score {n}",
  " · 手动白名单": " · manual whitelist",
  "🤖 高频做市 / 机器人": "🤖 HF market maker / bot",
  " · {n} 市场": " · {n} markets",
  "Polymarket 主页 ↗": "Polymarket profile ↗",
  "分析窗口：近 {n} 笔成交（{from} → {to}）":
    "Analysis window: last {n} trades ({from} → {to})",
  加载失败: "Failed to load",
  "档案加载中…": "Loading dossier…",

  // -------- KPI 五卡
  已结算胜率: "Settled win rate",
  "高频做市/机器人(交易过大量不同市场):做市赚点差、非定向下注,胜率不适用":
    "HF market maker / bot (traded a huge number of distinct markets): earns the spread, no directional bets — win rate not applicable",
  "已结算市场过多,只能取到按盈亏排序的最赚一部分(赢家偏差),胜率无法可靠统计":
    "Too many settled markets — only the most profitable slice (profit-sorted) could be fetched (winner bias), so win rate cannot be measured reliably",
  无数据: "No data",
  "高频做市/机器人 · {n} 市场 · 胜率不适用":
    "HF market maker / bot · {n} markets · win rate n/a",
  "{n}+ 个已结算市场 · 过多,胜率不可靠":
    "{n}+ settled markets · too many, win rate unreliable",
  "{n} 个已结算市场": "{n} settled markets",
  净盈亏: "Net PnL",
  "Polymarket 口径净盈亏（已实现 + 当前持仓浮动盈亏），取自官方 user-pnl 曲线，与主页 Profit/loss 一致":
    "Net P/L on Polymarket's basis (realized + unrealized on open positions), from the official user-pnl curve — matches the profile's Profit/loss figure",
  "已结算 ROI": "Settled ROI",
  "PUSD 现金余额": "PUSD cash balance",
  "Polymarket 账户内未下注的现金（链上 PUSD 余额，实时查询）":
    "Idle, un-bet cash inside the Polymarket account (on-chain PUSD balance, live query)",
  账户内可用资金: "Available account cash",
  "RPC 暂不可用": "RPC unavailable",
  "近窗买入 / 卖出": "Window buys / sells",
  "平均每笔 ${n}": "Avg ${n} per trade",
  拆单倾向: "Split-buy tendency",
  "买单中 <$1k 的占比": "Share of buys under $1k",

  // -------- 当前持仓
  "当前持仓（{n} 个活仓 · 总市值 ${v} · 浮动盈亏 ":
    "Open positions ({n} live · market value ${v} · unrealized P/L ",
  " · 仅前若干页": " · first pages only",
  "）": ")",
  当前持仓: "Current position",
  "该钱包当前没有活跃持仓（或未查询到）":
    "No active positions for this wallet (or none found)",
  "市场 / 结果": "Market / outcome",
  份额: "Shares",
  建仓均价: "Avg entry",
  按金额加权的建仓均价: "Entry price weighted by dollar size",
  现价: "Now",
  市值: "Value",
  浮动盈亏: "Unrealized P/L",

  // -------- 专攻类别 + 类别词元(catLabel/subLabel 译回英文原名;
  // 「体育·NBA」等合成串不进字典,组件按词元 t() 后合成)
  "专攻类别（按头部市场成交额）": "Focus categories (by top-market volume)",
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

  // -------- 赔率带 / 头部市场
  "买入赔率带分布（近 {n} 笔）": "Buy odds-band distribution (last {n} trades)",
  "{n}笔": "{n} trades",
  "头部市场（按成交额）": "Top markets (by volume)",
  市场: "Market",
  类别: "Category",
  买入: "Buy",
  卖出: "Sells",
  净买入: "Net buy",
  笔数: "Fills",

  // -------- 本工具历史命中 / 最近成交
  "本工具历史命中（近 {d} 天 · {n}）":
    "This tool's past hits (last {d} days · {n})",
  "近 {d} 天内该钱包未触发过告警":
    "No alerts triggered by this wallet in the last {d} days",
  类型: "Type",
  方向: "Side",
  金额: "Amount",
  价格: "Price",
  时间: "Time",
  "💰 大单": "💰 Large trade",
  "🔥 共识": "🔥 Consensus",
  "最近成交（20）": "Recent trades (20)",
};
