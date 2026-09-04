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
  "🏆 聪明钱窗口台账（近 {h}h · 市场已结算）":
    "🏆 Smart-money window ledger (last {h}h · market settled)",
  "市场已结算——敞口一律归零。赎回（REDEEM）不走成交流水，无法从买卖推算，故不再声称任何仓位「仍持有」；下方净股数与买入均价仍是窗口内的成交事实。":
    "Market settled — exposure is zeroed. Redemptions (REDEEM) never appear in the trade feed and cannot be inferred from buys/sells, so nothing here is claimed to be STILL held; net shares and avg buy price below remain the window's trade facts.",
  结果: "Outcome",
  钱包: "Wallet",
  敞口: "Exposure",
  窗口净股数: "Net shares in window",
  窗口净买入: "Net bought in window",
  "{o} {n} 钱包 · 窗口净买入 ${v}":
    "{o} {n} wallets · ${v} net bought in window",
  "🧩 拆单累计（≥3 笔 · 单笔 <$10k · 窗口净买入 ≥$2k）":
    "🧩 Split-buy accumulation (≥3 fills · <$10k each · ≥$2k net bought in window)",
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
  // 时光机 · 复盘(第二梯队八件套,2026-08-28)
  "🕰 复盘（价格曲线 × 本站告警 × 结算）":
    "🕰 Replay (price curve × this site's alerts × settlement)",
  "加载复盘（拉一次价格曲线）": "Load replay (fetches the price curve once)",
  "曲线为 {o} 一侧的价格。": "Curve shows the {o} side. ",
  "另一侧的告警按 1−p 精确映射到同一坐标（标记带 ↔）。":
    "Alerts on the other side map exactly via 1−p onto the same axis (markers carry ↔). ",
  "非二元市场：只显示第一结果一侧的告警，其余边无等价映射。":
    "Non-binary market: only first-outcome alerts are shown — other sides have no exact mapping. ",
  "虚线为结算价。": "Dashed line = settlement price. ",
  "标记色：💰大单 🏆聪明钱 🔥共识 🐣同批新钱包。":
    "Marker colors: 💰 large · 🏆 smart · 🔥 consensus · 🐣 cohort.",
  "该区间没有价格历史点（市场太新或曲线不可用）。":
    "No price-history points in this range (market too new or curve unavailable).",

  // -------- 市场脉搏标签条(2026-08-31)。标签文字本身(异常/分歧/无鲸/洗量、
  // 品类名)复用 pulse 分片与 categoryLabel,此处只放本页独有的时间口径提示 ——
  // 卡片其余字段是此刻的窗口,榜单标记是已收盘那个 UTC 日的判定,不写明会被混读。
  "{d}（UTC）的市场脉搏日榜判定，不是此刻窗口":
    "From the {d} (UTC) market-pulse daily boards, not the live window",
  "{d}（UTC）异常分 {s}/100": "Anomaly score {s}/100 on {d} (UTC)",
  "异常分 {s}": "Anomaly {s}",

  // ===================================================================
  // Etherscan 风改皮(设计稿 11「市场卡 · 粘贴落地页」/ 12「五段式信号卡」)
  // 新增的文案。旧键留在上面没删:它们是上一版版式的措辞,删掉只会让回滚
  // 时英文界面出洞,留着不占运行时成本。
  // ===================================================================

  // -------- 落地页(设计稿 11)
  "🃏 单市场信号卡": "🃏 Single-market signal card",
  "粘贴任何能指认一个市场的东西，10 秒看清聪明钱在这个市场里做了什么。":
    "Paste anything that identifies a market — see in 10 seconds what smart money did in it.",
  支持三种格式: "Three accepted formats",
  事件链接: "Event URL",
  卡里会告诉你: "What the card tells you",
  "共识 / 分歧状态": "Consensus / disagreement state",
  白名单站哪一侧: "Which side the whitelist is on",
  谁在蚂蚁搬家: "Who is building a position in small bites",
  留存敞口: "Retained exposure",
  "净股数 × 买入均价": "Net shares × avg buy price",
  新钱包异常流: "Fresh-wallet unusual flow",
  "账龄 ≤7 天的重注": "Big bets from wallets ≤7 days old",
  本工具告警战绩: "This tool's alert record",
  "90 天内 · 含验证结果": "90 days · with verification",

  // -------- 卡片页:口径条与 KPI(设计稿 12)
  "窗口触顶截断：该市场窗口内的成交超过分页上限，下方所有计数与金额都是下界。":
    "Window capped: this market's trades in the window exceeded the pagination limit — every count and amount below is a lower bound.",
  "24h 量": "24h volume",
  聪明钱这一侧: "Smart money is on this side",
  窗口留存敞口: "Retained exposure in window",

  // -------- 共识 / 分歧判定条
  "{n} 个白名单钱包买入 {o}": "{n} whitelist wallets bought {o}",
  "⚖️ 分歧": "⚖️ Disagreement",
  "🤖 做市机器人不计入共识投票":
    "🤖 Market-maker bots are excluded from consensus votes",

  // -------- 五段的段名与口径后缀(段名 600、口径 400 muted,分两个键)
  复盘: "Replay",
  "价格曲线 × 本站告警 × 结算": "price curve × this site's alerts × settlement",
  聪明钱留存敞口: "Smart-money retained exposure",
  聪明钱窗口台账: "Smart-money window ledger",
  "近 {h}h · 净股数 × 买入均价": "last {h}h · net shares × avg buy price",
  "近 {h}h · 市场已结算": "last {h}h · market settled",
  "≥3 笔 · 单笔 <$10k · 敞口 ≥$2k": "≥3 fills · <$10k each · ≥$2k exposure",
  "≥3 笔 · 单笔 <$10k · 窗口净买入 ≥$2k":
    "≥3 fills · <$10k each · ≥$2k net bought in window",
  "账龄 ≤7 天 · 单笔 ≥$5k 买入": "age ≤7d · single buy ≥$5k",
  本工具告警史: "This tool's alert history",

  // -------- 表内标记与判定徽章
  "🤖 做市": "🤖 MM",
  疑似对冲: "Possible hedge",
  "🤖 疑似做市": "🤖 Possible market making",
  "✅ 命中": "✅ Hit",
  "❌ 反向": "❌ Wrong side",
  "➖ 平": "➖ Push",
  "「—」是判不了，不是 0：价格一栏为空表示该信号缺 asset、当时取不到价；1h / 24h 为空表示那个时点还没有价格历史（信号太新或曲线不可用）。":
    "A dash means undecidable, not zero: an empty price means the signal had no asset and no price could be read at the time; an empty 1h / 24h means no price history existed at that moment (signal too new, or the curve was unavailable).",

  // -------- 01 复盘未加载态
  拉一次价格曲线: "Fetch the price curve once",
  "点一下才拉曲线 —— 这页对上游仍是零请求":
    "Nothing is fetched until you click — this page stays at zero upstream requests",
  "🐣 同批新钱包": "🐣 Fresh-wallet cohort",
  "曲线为第一结果一侧 · 另一侧按 1−p 映射（标记带 ↔）":
    "Curve shows the first outcome's side · the other side maps via 1−p (markers carry ↔)",
};
