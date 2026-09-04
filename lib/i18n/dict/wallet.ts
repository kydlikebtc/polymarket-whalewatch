// wallet 页字典分片 —— 键=中文原文,值=英文译文。由该页改造代理独家填写。
export const DICT_WALLET: Record<string, string> = {
  // -------- header:身份标签与来源链接
  "🕵️ 钱包档案": "🕵️ Wallet dossier",
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

  // -------- 降级横幅与自动重试(限流/上游故障 ≠ 无数据)
  "⏳ 实时档案被限流（公共接口预算已满）——先展示本地留存数据。":
    "⏳ Live dossier rate-limited (public API budget exhausted) — showing locally stored data first.",
  "⚠️ 上游接口暂时不可用——先展示本地留存数据。":
    "⚠️ Upstream API temporarily unavailable — showing locally stored data first.",
  "{n}s 后自动重试": "Auto-retrying in {n}s",
  立即重试: "Retry now",

  // -------- 概览双栏卡(Etherscan 地址页语法:概览 / 更多信息)
  "概览 · 已结算口径": "Overview · settled basis",
  更多信息: "More info",
  "近 {d} 天告警": "Alerts in {d}d",
  本工具发出: "Sent by this tool",
  "{n} 个活仓": "{n} live positions",
  "总市值 ${v}": "Market value ${v}",
  初动留存率: "Initial-move retention",
  "95% 区间 {lo}–{hi}% · {k} 个市场": "95% CI {lo}–{hi}% · {k} markets",
  风格最像的池内钱包: "Most similar pool wallets",
  "近 90 天告警样本 {n} 条": "{n} alert samples in 90d",

  // -------- 页内分区导航(锚点跳转,非互斥切换)
  档案分区导航: "Dossier sections",
  专攻类别: "Focus categories",
  买入赔率带: "Odds bands",
  头部市场: "Top markets",
  历史命中: "Past hits",
  价格影响: "Price impact",
  交易风格: "Trading style",
  最近成交: "Recent trades",

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

  // -------- 当前持仓（卡内标题条走「· 分段」语法，不用全角括号）
  "当前持仓 · {n} 个活仓 · 总市值 ${v} · 浮动盈亏 ":
    "Open positions · {n} live · market value ${v} · unrealized P/L ",
  " · 仅前若干页": " · first pages only",
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
  "建仓均价与现价是成本口径，一律中性色；只有浮动盈亏用涨绿跌红。":
    "Entry price and current price are cost figures — always neutral in color; only unrealized P/L uses green-up / red-down.",

  // -------- 专攻类别 + 类别词元(catLabel/subLabel 译回英文原名;
  // 「体育·NBA」等合成串不进字典,组件按词元 t() 后合成)
  "专攻类别 · 按头部市场成交额": "Focus categories · by top-market volume",
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
  "买入赔率带分布 · 近 {n} 笔": "Buy odds-band distribution · last {n} trades",
  "{n}笔": "{n} trades",
  "头部市场 · 按成交额": "Top markets · by volume",
  市场: "Market",
  类别: "Category",
  买入: "Buy",
  卖出: "Sells",
  净买入: "Net buy",
  笔数: "Fills",
  "类别栏的「—」= 上游没有给出分类标注，不是「其他」这一档。":
    "A “—” in the Category column means upstream gave no category label — it is not the “Other” bucket.",

  // -------- 本工具历史命中 / 最近成交
  "本工具历史命中 · 近 {d} 天 {n} 条":
    "This tool's past hits · {n} in the last {d} days",
  "近 {d} 天内该钱包未触发过告警":
    "No alerts triggered by this wallet in the last {d} days",
  看全站实时告警: "See the live alert stream",
  类型: "Type",
  方向: "Side",
  金额: "Amount",
  价格: "Price",
  时间: "Time",
  "💰 大单": "💰 Large trade",
  "🔥 共识": "🔥 Consensus",
  "价格栏的「—」= 当时的告警载荷没有记录成交价，不是成交价为 0。":
    "A “—” in the Price column means the alert payload recorded no fill price at the time — it does not mean the fill price was 0.",
  "最近成交 · 近 {n} 笔": "Recent trades · last {n}",
  // 价格影响持久性(第二梯队八件套,2026-08-28)
  "价格影响 · 告警后市场反应": "Price impact · market reaction after alerts",
  "样本不足：可测初动 {m} 条 · 覆盖 {k} 个市场（需 ≥8）":
    "Insufficient sample: {m} measurable moves across {k} markets (needs ≥8)",
  被市场跟随: "Followed by the market",
  被市场回吐: "Faded by the market",
  反应不一: "Mixed reaction",
  "初动留存率 {r}%（95% 区间 {lo}–{hi}%，{k} 个市场）":
    "Initial-move retention {r}% (95% CI {lo}–{hi}%, {k} markets)",
  "中位初动 +{a}¢ → 24h {b}¢": "Median initial move +{a}¢ → 24h {b}¢",
  "中位初动 → 24h": "Median initial move → 24h",
  // 口径条与免责句分家:后者在界面上加粗独立成句
  "口径：初动 = 告警后 10 分钟的方向化价移（≥2¢ 才可测），留住 = 24h 后保住初动一半以上；区间按市场聚簇。":
    "Definitions: initial move = direction-signed price change 10 minutes after the alert (≥2¢ to count), retained = 24h later at least half the move survives; CI clustered by market.",
  "这是市场对他的反应的描述统计，不是任何跟随建议。":
    "Descriptive statistics of how the market reacted — never a suggestion to follow anyone.",
  // 交易风格(第二梯队八件套,2026-08-28;词表与 discovery 页共用)
  "交易风格 · 池内 · 近 90 天告警样本 {n} 条":
    "Trading style · pool member · {n} alert samples in 90d",
  "风格最像的池内钱包：": "Most similar pool wallets: ",
  "🎯 冷门猎手": "🎯 Longshot hunter",
  "⚖️ 中盘": "⚖️ Midrange",
  "🛡️ 热门守卫": "🛡️ Favorite guard",
  "⏱️ 临场": "⏱️ Last-call",
  "📅 隔日": "📅 Intraday-to-day",
  "🗓️ 长线": "🗓️ Long-haul",
  "🔨 重锤": "🔨 Hammer",
  "↔️ 双向": "↔️ Two-way",
};
