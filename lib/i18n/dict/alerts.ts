// alerts 页字典分片 —— 键=中文原文,值=英文译文。由该页改造代理独家填写。
export const DICT_ALERTS: Record<string, string> = {
  "告警条件（金额 / 方向 / 赔率 / 地址年龄 / 冷却 / 聪明钱）统一在运营页配置：":
    "Alert conditions (amount / side / odds / wallet age / cooldown / smart money) are configured on the ops page:",
  "近24h {n} 条": "{n} in 24h",
  // Header
  "🐋 Polymarket 大额成交监控": "🐋 Polymarket Whale Trade Monitor",
  共: "Total",
  条告警: "alerts",
  " · 最后刷新 {at}": " · last refresh {at}",
  " · 刷新失败: {err}": " · refresh failed: {err}",
  "· 每 5 秒自动刷新（后台标签页暂停）":
    "· auto-refreshes every 5s (paused in background tabs)",

  // Conditions panel
  告警条件: "Alert Conditions",
  启用: "Enabled",
  最低金额: "Min amount",
  方向: "Side",
  全部: "All",
  "买入 BUY": "Buy",
  "卖出 SELL": "Sell",
  价格区间: "Price range",
  "赔率 0–1（默认上限 0.95：排除 ≥0.95 的结算扫尾单，清空 = 不设上限）":
    "Odds 0–1 (default 0.95 cap excludes ≥0.95 settlement sweeps; clear = no cap)",
  地址年龄: "Wallet age",
  不限: "Any",
  "天（留空 = 不限）": "days (blank = no limit)",
  距结算: "Settles in",
  "小时（留空 = 不限；抓结算前突击买入）":
    "hours (blank = no limit; catches pre-resolution strike buys)",
  冷却窗口: "Cooldown",
  "分钟（同一钱包·同一市场冷却期内只推首笔，其余仅入库；0 = 关闭）":
    "minutes (per wallet & market, only the first fill pushes during cooldown, the rest just log; 0 = off)",
  聪明钱: "Smart Money",
  "只推送聪明钱白名单钱包（🏆，每日自动从官方盈利榜播种）":
    "Only push whitelisted smart-money wallets (🏆, seeded daily from the official profit leaderboard)",
  "白名单 {n} 个": "Whitelist: {n} wallets",
  " · 近24h 🏆 {n} 条": " · {n} 🏆 alerts last 24h",
  "聪明钱白名单为空 — 开启后将不会推送任何告警。引擎启动后每日自动从 官方盈利榜播种（首次约 1 分钟内完成），播种失败会自动重试":
    "Smart-money whitelist is empty — with this on, no alerts will be pushed. The engine seeds it daily from the official profit leaderboard (first seed lands within ~1 minute of startup); a failed seed retries automatically",
  "💡 开启后建议把最低金额降至 $2k–5k：聪明钱大单通常拆小，$10k 单笔线与白名单的交集近零":
    "💡 With this on, drop the min amount to $2k–5k: smart money usually splits big orders, so a $10k per-fill floor barely intersects the whitelist",
  管理令牌: "Admin token",
  "公开部署为只读 — 保存需服务器 .env 中的 ADMIN_TOKEN（仅存本机浏览器）":
    "Public deployment is read-only — saving requires the ADMIN_TOKEN from the server's .env (stored only in this browser)",
  "保存中…": "Saving…",
  保存: "Save",
  "已保存 {at}，引擎下一轮(~{s}s)生效":
    "Saved {at} — live on the next engine poll (~{s}s)",
  "保存失败: {err}": "Save failed: {err}",

  // Telegram push-channel health callout
  "⚠️ Telegram 推送通道异常：已连续": "⚠️ Telegram push channel failing —",
  次发送失败: "consecutive send failures",
  "（最近失败 {at}）": " (last failure {at})",
  "。新告警仍正常入库并显示在下方列表，仅推送受影响 — 请检查 bot token / 频道权限 / 限流。":
    ". New alerts still land in the DB and the list below; only pushes are affected — check the bot token / channel permissions / rate limits.",

  // Validation strip
  "信号验证（当前列表）": "Signal validation (current list)",
  "10m 方向命中": "10m direction hits",
  "1h 方向命中": "1h direction hits",
  "24h 方向命中": "24h direction hits",
  已结算胜率: "Settled win rate",
  样本不足: "small sample",
  "95%区间 {lo}–{hi}%": "95% CI {lo}–{hi}%",
  // 有效样本量:同一市场的多条告警共享一个结算,只算一个独立观测。
  "{n} 个市场": "{n} markets",
  "💰大单": "💰 Large",
  "🐣同批新钱包": "🐣 Cohort",
  "🏆聪明钱": "🏆 Smart",
  "🔥共识": "🔥 Consensus",

  // Alerts table
  "暂无告警 — worker 抓到大单后会出现在这里":
    "No alerts yet — large fills caught by the worker will show up here",
  市场: "Market",
  结果: "Outcome",
  金额: "Amount",
  价格: "Price",
  钱包: "Wallet",
  验证: "Validation",
  时间: "Time",
  "信号后 1h/24h 价格变化（按方向着色）与结算结果":
    "1h/24h price move after the signal (colored by direction) and the resolution result",
  " · 结算价 {res} vs 成交价 {fill}": " · resolved {res} vs fill {fill}",
};
