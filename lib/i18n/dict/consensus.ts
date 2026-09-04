// consensus 页字典分片 —— 键=中文原文,值=英文译文。由该页改造代理独家填写。
// 覆盖 app/consensus/page.tsx 与 app/DisagreementSection.tsx;glossary 词表
// 串(Icon tooltip 等)不在此登记 —— glossary 分片是唯一属主。
export const DICT_CONSENSUS: Record<string, string> = {
  // ---- 页头
  // Etherscan 风页头:12px 小标(emoji 前缀)+ 24/600 标题 + 14px 说明。
  // 「🔥 共识 · ⚖️ 分歧」保留 —— /follow 仍在用同一串。
  "🔥 白名单同向与对立建仓":
    "🔥 Whitelist entries — same side & opposing sides",
  "最后刷新 {time}": "Last refreshed {time}", // 与 follow 分片同值(同键同值无冲突)
  "加载中…": "Loading…", // 与 status / discovery 分片同值
  "🔥 共识 · ⚖️ 分歧": "🔥 Consensus · ⚖️ Disagreement",
  // 页头只说「这页是什么」:两种形态怎么分、互斥。天平怎么称、各列口径分别
  // 进列头 title 与卡底口径条,不在页头堆。
  "同一市场里白名单钱包站同一侧 = 共识，分站两侧 = 分歧，两者互斥。":
    "Whitelisted wallets inside one market: same side = consensus, opposing sides = a split. Mutually exclusive.",
  " · 最后刷新 {time}": " · last refreshed {time}",
  " · 加载中…": " · loading…",

  // ---- 筛选控件
  时间窗: "Window",
  最少钱包: "Min wallets",
  最少钱包数: "Minimum wallet count",
  "≥{n} 个": "≥{n}",
  每钱包净买: "Per-wallet net buy",
  每钱包净买入下限: "Per-wallet net buy floor",
  刷新: "Refresh",
  "自动刷新 30s": "Auto-refresh 30s",

  // ---- 提示条 / KPI
  "加载失败: {err}": "Load failed: {err}",
  "聪明钱白名单为空 — 引擎启动后每日自动从官方盈利榜播种（首次约 1 分钟内完成）":
    "Smart-money whitelist is empty — the engine seeds it daily from the official profit leaderboards (first run finishes within ~1 minute)",
  共识组数: "Consensus groups",
  合计净买入: "Total net buy",
  白名单钱包: "Whitelisted wallets",
  // 分歧格 —— 与 pulse 分片同键同值(刻意复用,不是覆盖)
  方向分歧: "Directional splits",
  // KPI 值带单位(设计稿:「6 个」);英文计数不带量词
  "{n} 个": "{n}",
  // KPI 副行(设计稿的 13px 副行:一句话说清这个数是怎么来的)
  "≥{n} 个白名单同向": "≥{n} whitelisted wallets on the same side",
  两侧各达门槛: "Both sides clear the threshold",
  窗口内共识组合计: "Total across the window's consensus groups",
  点击查看全部地址: "Click to see every address",
  "点击查看全部白名单地址（支持搜索）":
    "Click to view every whitelisted address (searchable)",
  // 窗口覆盖不足是「不读会把数字读错」的那一条 —— 保留,但压成一句。
  "⏱️ API 回看深度已用满 — 本页只覆盖 {time} 起的 {span}（买卖双侧均完整）":
    "⏱️ API look-back depth exhausted — this board only covers the {span} since {time} (both buy & sell sides complete)",
  "~{m} 分钟": "~{m} min",
  "~{h} 小时": "~{h}h",
  "~{h} 小时 {m} 分": "~{h}h {m}m",

  // ---- 共识/分歧 tab
  共识或分歧: "Consensus or disagreement",
  共识: "Consensus",
  分歧: "Disagreement",

  // ---- 共识表
  "窗口内暂无聪明钱共识 — 出现时也会推送到实时告警":
    "No smart-money consensus in this window — new ones also push to live alerts",
  // 空态给出路(放宽筛选 / 换一页看),绝不只留一句「暂无」
  "把时间窗放宽到 12h、或把每钱包净买下限降到 $5,000 再看一次。":
    "Widen the window to 12h, or drop the per-wallet net-buy floor to $5,000, and look again.",
  "去实时告警 →": "Go to live alerts →",
  "共 {n} 组共识": "{n} consensus groups",
  // 表下方琥珀条:「—」是判不了,不是零 —— 三处成因用最短句式列全。加权口径
  // 与跟单空间的成本/颜色口径已下沉到各自列头 title,这里不重说。
  "— 三种成因，都不是 0：现价栏＝缺 asset 不可取价（跟单空间随之判不了）· 评分栏＝无已结算样本 · 当前持仓栏＝此刻已无持仓。":
    "Three causes for —, none of them a zero: Now = no asset to price (which also leaves the follow gap undecidable) · Score = no settled sample yet · Current position = holds none right now.",
  "市场 · 结果": "Market · Outcome",
  钱包数: "Wallets",
  建仓均价: "Avg entry",
  按金额加权的聪明钱建仓均价:
    "Size-weighted average entry price of the smart money",
  现价: "Now",
  "Gamma 最新赔率": "Latest Gamma odds",
  跟单空间: "Follow gap",
  // 跟单空间列头 title —— 成本口径、三档措辞分界、颜色分界、已结算例外
  "现价 − 建仓均价的 ¢ 差，是成本不是盈亏：|差| ≤ 5¢ 仍可跟，> 5¢ 已跑，< −5¢ 已反向（进场即接飞刀）。一律中性色，|差| 超 10¢ 转琥珀；已结算的市场不谈跟单空间，只标命中 / 落空。":
    "Now − average entry, in ¢: a cost, not a P&L. |gap| ≤ 5¢ still followable, > 5¢ gone, < −5¢ reversed (entering now means catching a falling knife). Always neutral in colour, turning amber past |10¢|; settled markets drop the follow gap and show hit / miss instead.",
  最新时间: "Last trade",
  点击展开钱包明细: "Click to expand wallet details",
  点击收起钱包明细: "Click to collapse wallet details",
  // 已结算走纯文字(与分歧表同一层级),不再是绿/红徽章
  " · 命中": " · hit",
  " · 落空": " · missed",
  // 措辞与颜色同为双边判据:|gap| ≤ 5¢ 才是「仍可跟」,负空间越线说「已反向」
  "仍可跟 {gap}¢": "Followable {gap}¢",
  "已跑 +{gap}¢": "Gone +{gap}¢",
  "已反向 {gap}¢": "Reversed {gap}¢",

  // ---- 共识钱包明细(展开面板 = 设计稿的第二张卡:标题条 + 紧凑表)
  "{outcome} 一侧展开": "{outcome} side expanded",
  // 标题条的灰色续写用「· 」起头(设计稿:「NO 一侧展开 · 4 个钱包 · …」)
  " · {n} 个钱包 · 净买 ${net} · 建仓均价 {avg}":
    " · {n} wallets · net buy ${net} · avg entry {avg}",
  "{n} 个钱包 · 净买 ${net} · 建仓均价 {avg}":
    "{n} wallets · net buy ${net} · avg entry {avg}",
  "共识钱包（按净买入排序）": "Consensus wallets (sorted by net buy)",
  钱包: "Wallet",
  评分: "Score",
  净买入: "Net buy",
  笔数: "Fills",
  当前持仓: "Current position",
  该钱包当前在此结果的持仓市值与浮动盈亏:
    "This wallet's current position value and unrealized PnL on this outcome",

  // ---- 分歧表
  "窗口内暂无聪明钱分歧 — 白名单钱包没有在同一市场对立建仓":
    "No smart-money split in this window — no whitelisted wallets took opposing sides of one market",
  // 空态只留出路 —— 「为什么少」主句已经说过(没有对立建仓)
  "把最少钱包降到 ≥2 个、时间窗放宽到 12h 再看一次。":
    "Lower the wallet minimum to ≥2 and widen the window to 12h, then look again.",
  "共 {n} 个分歧市场": "{n} split markets",
  "剔除 {n} 个两边押": "{n} both-sides wallets excluded",
  // 倾斜列改成图标 + 文字:蓝色在全站只表示可点击,不表示状态结论
  "⬛ 倒向 {pct}%": "⬛ Leans {pct}%",
  "⚠️ 势均力敌 {pct}%": "⚠️ Balanced {pct}%",
  // 卡底只留「—」的成因;加权口径已下沉到「质量加权天平」列头 title
  "— 两种成因，都不是 0：评分 / 胜率栏＝该钱包无已结算样本 · 当前持仓栏＝此刻在该结果已无持仓。":
    "Two causes for —, neither a zero: Score / Win rate = the wallet has no settled sample yet · Current position = it holds none of this outcome right now.",
  市场: "Market",
  质量加权天平: "Quality-weighted balance",
  "净买入 × 钱包评分权重，不是原始金额；同时在两边都净买入的钱包按对冲 / 做市从两侧一起剔除。":
    "Net buy × the wallet's score weight, not raw dollars; wallets that net-bought both sides are dropped from both as hedging / market-making.",
  倾斜: "Tilt",
  "质量加权后领先侧的占比；两侧接近时转琥珀（天平不倾斜，读不出方向）。已结算的市场不谈倾斜，只标胜出的结果。":
    "Share held by the leading side after quality weighting; turns amber when the sides are close (the balance barely tilts, so there is no direction to read). Settled markets drop the tilt and name the winning outcome instead.",
  合计加权: "Total weighted",
  点击展开各侧明细: "Click to expand per-side details",
  点击收起各侧明细: "Click to collapse per-side details",
  " · 已剔除 {n} 个两边押": " · {n} both-sides wallets excluded",
  已结算: "Settled",
  " · {outcome} 胜": " · {outcome} won",
  "{outcome} 倒向 {pct}%": "Leans {outcome} {pct}%",
  "势均力敌 {pct}%": "Balanced {pct}%",

  // ---- 分歧各侧明细
  "{outcome} · 质量加权 ${usd}": "{outcome} · quality-weighted ${usd}",
  "{n} 个钱包 · 净买 ${net} · 质量加权 ${weighted} · 建仓均价 {avg}":
    "{n} wallets · net buy ${net} · quality-weighted ${weighted} · avg entry {avg}",
  " · {n} 个钱包 · 净买 ${net} · 质量加权 ${weighted} · 建仓均价 {avg}":
    " · {n} wallets · net buy ${net} · quality-weighted ${weighted} · avg entry {avg}",
  " · 现价 {cur}": " · now {cur}",
  胜率: "Win rate",
  // 离场(第二梯队八件套,2026-08-28)
  离场: "Exits",
  // 门槛口径下沉到「离场钱包」列头 title —— 标题条只留计数
  "在同一结果上净卖出的池内钱包数（与共识同一把最少钱包 / 每钱包金额尺）":
    "Pool wallets net-selling the same outcome (same min-wallets / per-wallet size thresholds as consensus)",
  窗口内暂无池内钱包的集体离场: "No collective pool exits inside the window",
  "离场比建仓稀疏：把时间窗放宽到 12h、或把最少钱包降到 ≥2 个再看一次。":
    "Exits are sparser than entries: widen the window to 12h, or lower the wallet minimum to ≥2, and look again.",
  "共 {n} 组离场": "{n} exit groups",
  离场钱包: "Exiting wallets",
  合计卖出: "Total sold",
  卖出均价: "Avg sell price",
  按金额加权的卖出均价: "Size-weighted average sell price",
  // 留下的是会改变读数的那句:窗内只见卖不见建仓
  "只统计窗口内的卖单 —— 看不到此前怎么建的仓，获利了结与止损在这里长得一模一样。":
    "Only sells inside the window are counted — it cannot see how those positions were built, so profit-taking and stop-outs look identical here.",
};
