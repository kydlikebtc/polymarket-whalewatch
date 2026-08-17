// consensus 页字典分片 —— 键=中文原文,值=英文译文。由该页改造代理独家填写。
// 覆盖 app/consensus/page.tsx 与 app/DisagreementSection.tsx;glossary 词表
// 串(Icon tooltip 等)不在此登记 —— glossary 分片是唯一属主。
export const DICT_CONSENSUS: Record<string, string> = {
  // ---- 页头
  "🔥 共识 · ⚖️ 分歧": "🔥 Consensus · ⚖️ Disagreement",
  "白名单钱包在同一市场：同向买同一结果 = 共识，对立结果各自建仓 = 分歧（两者互斥）— 都比单笔大单更有说服力":
    "Whitelisted wallets in one market: same-side buys of one outcome = consensus, entries on opposing outcomes = split (mutually exclusive) — either beats any single whale order as evidence",
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
  "点击查看全部白名单地址（支持搜索）":
    "Click to view every whitelisted address (searchable)",
  "⏱️ 成交太密集，API 回看深度已用满 — 本页基于":
    "⏱️ Trades too dense — API look-back depth exhausted. This board covers",
  "完整覆盖的 {span}": "the fully covered {span}",
  "（自 {time} 起，买卖双侧均完整）检测":
    "(both buy & sell sides complete since {time})",
  "~{m} 分钟": "~{m} min",
  "~{h} 小时": "~{h}h",
  "~{h} 小时 {m} 分": "~{h}h {m}m",

  // ---- 共识/分歧 tab
  共识或分歧: "Consensus or disagreement",
  共识: "Consensus",
  分歧: "Disagreement",
  "一边倒 · ≥{n} 个白名单钱包同向买入同一结果":
    "Lopsided · ≥{n} whitelisted wallets buying the same outcome",
  "同一市场对立结果都有聪明钱 · 按质量加权称天平（与共识互斥）":
    "Smart money on opposing outcomes of one market · quality-weighted balance (mutually exclusive with consensus)",

  // ---- 共识表
  "窗口内暂无聪明钱共识 — 出现时也会推送到实时告警":
    "No smart-money consensus in this window — new ones also push to live alerts",
  "市场 · 结果": "Market · Outcome",
  钱包数: "Wallets",
  建仓均价: "Avg entry",
  按金额加权的聪明钱建仓均价:
    "Size-weighted average entry price of the smart money",
  现价: "Now",
  "Gamma 最新赔率": "Latest Gamma odds",
  跟单空间: "Follow gap",
  最新时间: "Last trade",
  点击展开钱包明细: "Click to expand wallet details",
  点击收起钱包明细: "Click to collapse wallet details",
  "已结算 ✓ 命中": "Settled ✓ hit",
  "已结算 ✗ 落空": "Settled ✗ missed",
  "仍可跟 {gap}¢": "Followable {gap}¢",
  "已跑 +{gap}¢": "Gone +{gap}¢",

  // ---- 共识钱包明细
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
  市场: "Market",
  质量加权天平: "Quality-weighted balance",
  倾斜: "Tilt",
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
  " · {n} 个钱包 · 净买 ${net} · 质量加权 ${weighted} · 建仓均价 {avg}":
    " · {n} wallets · net buy ${net} · quality-weighted ${weighted} · avg entry {avg}",
  " · 现价 {cur}": " · now {cur}",
  胜率: "Win rate",
};
