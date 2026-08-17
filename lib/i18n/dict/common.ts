// 共享层字典分片(TopNav/ui.tsx 组件/layout)。键=中文原文,值=英文译文。
export const DICT_COMMON: Record<string, string> = {
  // TopNav
  "24h 扫描": "24h Scan",
  实时告警: "Alerts",
  拆单累计: "Accumulation",
  "共识 / 分歧": "Consensus",
  聪明钱发现: "Discovery",
  市场卡: "Market",
  策略中心: "Strategy Center",
  说明: "Glossary",
  "Polymarket 监控": "Polymarket WhaleWatch",
  "Telegram 频道：实时信号推送，每条自带 30 天可验证命中率":
    "Telegram channel: real-time signal pushes, each with a verifiable 30-day hit rate",
  "TG 频道": "TG Channel",
  只读监控: "Read-only",
  切换语言: "Switch language",

  // CopyButton / QuietLink / MarketSlugActions / WalletLink
  复制: "Copy",
  已复制: "Copied",
  "复制 market slug": "Copy market slug",
  "在 wired.fund 打开交易页：{s}": "Open the wired.fund trade page: {s}",
  "打开市场信号卡：共识/分歧 · 聪明钱敞口 · 拆单 · 新钱包 · 告警战绩":
    "Open the market signal card: consensus/split · smart-money exposure · split-buys · fresh wallets · alert record",
  "{address} · 新标签打开钱包档案":
    "{address} · open the wallet dossier in a new tab",

  // AgeBadge
  "地址年龄：钱包首次 Polymarket 活动至今。🆕 = ≤30 天新钱包，红色 = <7 天 — 为一笔交易专门开的新钱包是最强内幕信号之一":
    "Wallet age: time since this wallet's first Polymarket activity. 🆕 = fresh wallet ≤30 days, red = <7 days — a wallet created just for one trade is among the strongest insider signals",

  // WalletStatsBadge
  聪明钱白名单: "Smart-money whitelist",
  "聪明钱白名单 · 评分 {score}": "Smart-money whitelist · score {score}",
  海量: "countless",
  "🤖 高频做市 / 机器人：交易过 {n} 个不同市场，胜率不适用（做市赚点差、非定向下注）\n盈亏为净盈亏（官方 user-pnl 口径）":
    "🤖 High-frequency market maker / bot: traded {n} distinct markets; win rate is not applicable (earns the spread, no directional bets)\nPnL is net PnL (official user-pnl basis)",
  无已结算战绩: "No settled record",
  "已结算 {n}+ 市场 · 胜率/ROI 无法可靠统计（结算过多，只取到按盈亏排序的最赚一部分）\n盈亏为净盈亏（官方 user-pnl 口径，不受截断影响）":
    "{n}+ settled markets · win rate/ROI cannot be measured reliably (too many settlements; only the most profitable slice was fetched)\nPnL is net PnL (official user-pnl basis, unaffected by truncation)",
  "已结算 {n} 市场": "{n} settled markets",
  " · 胜率 {pct}%": " · win rate {pct}%",
  " · ROI {roi}%": " · ROI {roi}%",
  "\n盈亏数字为净盈亏（已实现+浮动，官方 user-pnl 口径），非上面的已结算口径":
    "\nPnL figure is net PnL (realized + unrealized, official user-pnl basis), not the settled-only basis above",

  // SoundToggle / Modal / HoldingCell
  "新增记录时播放气泡提示音（点击关闭）":
    "Play a bubble chime on new records (click to turn off)",
  开启新增记录气泡提示音: "Enable the new-record bubble chime",
  "提示音 开": "Sound on",
  "提示音 关": "Sound off",
  关闭: "Close",
  "当前在该结果无持仓（窗口内买过但已清仓/转向）":
    "No current position on this outcome (bought in-window but since exited/flipped)",
  "{shares} 股 · 现价 {cur} · 建仓 {avg} · 浮盈 {pnl}":
    "{shares} shares · now {cur} · entry {avg} · unrealized {pnl}",
};
