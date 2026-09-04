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

  // Page head（Etherscan 风改版：12px 小标 + 24/600 标题 + 说明）
  // 「实时告警」标题键在 common 分片（导航同名，共用一处译文）。
  "📣 每 5 秒轮询 · 后台标签页暂停":
    "📣 Polled every 5s · paused in background tabs",
  "命中告警条件的大额成交逐条出现在下方，最新一条在最上面。条件（金额 / 方向 / 赔率 / 地址年龄 / 冷却 / 聪明钱）统一在运营页配置。":
    "Large fills that match the alert conditions appear below one by one, newest first. The conditions (amount / side / odds / wallet age / cooldown / smart money) are configured on the ops page.",
  // 时区声明（设计系统 §1：时区在页头注明一次）
  "本页时间按浏览器本地时区显示（顶栏的「实时」时钟走 UTC）。":
    "Times on this page follow your browser's local time zone (the “Live” clock in the top bar runs on UTC).",

  // 口径条（琥珀，放在数据前面）—— 只放统计声明；降级态的读法在表下方的
  // 琥珀说明条里（设计系统 §1.2：「—」的成因写在表下方）。
  "口径 · 信号验证": "Basis · signal validation",
  "验证列的 10m / 1h / 24h 是信号发出后的公开市场价变化，按方向着色（±0.5¢ 内记平推），不等于你的实际成交。同一市场的多条告警共享一次结算，因此 95% 区间与「样本不足」都按市场数计算，不按行数。":
    "The 10m / 1h / 24h figures in the Validation column are public market-price moves after the signal, colored by direction (moves within ±0.5¢ count as a push); they are not your actual fills. Alerts on one market share its single settlement, so both the 95% interval and the small-sample flag are computed on the market count, not the row count.",

  // 卡底琥珀说明条 —— 降级态的读法（三处「—」逐处列全，见设计系统 §1.2）
  "⚠️ 表里的三处「—」各有各的含义，不能都读成 0：结果列的「—」表示该笔没带结果名；钱包列的「—」表示没带钱包地址；验证列的「—」表示这一笔已结算但记平局（50/50 结算或结算价≈成交价），不计入胜率。另有一个非「—」的降级态：验证列的「…」表示这一笔还在补算 —— 新命中立即取，未取到的每分钟重试一批（一次最多 100 条）。":
    "⚠️ The three dashes in this table mean three different things, and none of them means 0: under Outcome, the alert carried no outcome name; under Wallet, it carried no wallet address; under Validation, the market settled as a push (a 50/50 resolution, or a settlement price ≈ the fill price) and is left out of the win rate. One more degraded state is not a dash: an ellipsis under Validation means the row is still being computed — a fresh hit is fetched at once, and rows still missing their marks are retried once a minute (up to 100 per batch).",

  // KPI 3 格
  命中条数: "Alerts matched",
  "轮询中 · 每 5 秒（列表上限 100 条）":
    "Polling · every 5s (list caps at 100)",
  "刷新失败: {err}": "Refresh failed: {err}",
  最近命中: "Latest hit",
  "最后刷新 {at}": "Last refresh {at}",
  等待首次刷新: "Awaiting the first refresh",
  等待首条命中: "Awaiting the first hit",
  推送通道: "Push channel",
  推送正常: "Push healthy",
  "连续失败 {n} 次": "{n} consecutive failures",
  "接口未提供推送计数（旧版本或冷库）":
    "The API returned no push counters (older build or cold DB)",
  "仅推送受影响，新告警仍正常入库":
    "Only pushes are affected — new alerts still land in the DB",
  "最近成功推送 {at}": "Last successful push {at}",
  暂无成功推送记录: "No successful push on record yet",

  // 命中流卡
  命中流: "Hit stream",
  "最近 {n} 条 · 最新在上": "Latest {n} · newest first",
  等待下一条命中: "Waiting for the next hit",
  "每 5 秒轮询一次；把运营页的金额门槛放宽（例如 ≥$5,000）可提高命中频率。":
    "Polled every 5s; loosening the amount floor on the ops page (to ≥$5,000, say) raises the hit rate.",

  // 行内信号类型名称标签（其余名称的译文在 glossary / market 分片）
  同批新钱包: "New-wallet cohort",
  // 结算判定徽章
  命中: "Hit",
  未中: "Miss",

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
  // 表头 (?) 的口径 —— 与验证列实际渲染的三个 horizon 对齐（10m 是
  // price_10m 上线后补的一列，旧文案只写了 1h/24h）。
  "信号后 10m / 1h / 24h 价格变化（按方向着色）与结算结果":
    "10m / 1h / 24h price move after the signal (colored by direction) and the resolution result",
  " · 结算价 {res} vs 成交价 {fill}": " · resolved {res} vs fill {fill}",
};
