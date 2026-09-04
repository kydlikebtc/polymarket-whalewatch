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
  // 描述压到一句「这页是什么」；口径的去处见下面的 timeTip 与流尾提示。
  "📣 每 5 秒轮询 · 后台标签页暂停":
    "📣 Polled every 5s · paused in background tabs",
  "命中告警条件的大额成交逐条出现在下方，最新一条在最上面。":
    "Large fills matching the alert conditions appear below, newest first.",
  // 时区声明（设计系统 §1：注明一次）—— 从页头描述迁到「时间」列的 (?)。
  显示为浏览器本地时区: "Shown in your local timezone",

  // 口径条（琥珀，全页唯一一条，放在数据前面）—— 只留会改变读数的统计
  // 声明。列的定义与平推死区进「验证」列的 (?)，降级态的读法在表下方。
  "口径 · 信号验证": "Basis · signal validation",
  "验证列是公开市价变化，不等于你的实际成交；95% 区间与「样本不足」按市场数计算，不按行数。":
    "The Validation column shows public market-price moves, not your actual fills; the 95% interval and the small-sample flag are computed on the market count, not the row count.",

  // 卡底说明条 —— 一行内把三处「—」列全（设计系统 §1.2：穷举一半会让
  // 读者以为只有两种成因）。平局的判定式与补算节奏进 (?)。
  "⚠️「—」是判不了、不是 0：结果列 = 没带结果名 · 钱包列 = 没带地址 · 验证列 = 已结算但平局（不计入胜率）。验证列的「…」= 仍在补算。":
    "⚠️ A dash means undecidable, not 0: Outcome = no outcome name · Wallet = no address · Validation = settled as a push (left out of the win rate). An ellipsis under Validation = still being computed.",

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
  // 流尾的第二行 —— 兼作「条件在哪配置」的去处（原在页头描述里）。
  // 轮询周期不再复述：页头小标与 KPI 副行已各说一次。
  "条件在运营页配置；放宽金额门槛（如 ≥$5,000）可提高命中频率。":
    "Conditions are set on the ops page; loosening the amount floor (to ≥$5,000, say) raises the hit rate.",

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
  // 「仍正常入库」是会改变读数的那一句（空流不是这条故障造成的），留下；
  // 「并显示在下方列表」与下方 KPI 副行重复，删。
  "。新告警仍正常入库，仅推送受影响 — 检查 bot token / 频道权限 / 限流。":
    ". New alerts still land in the DB; only pushes are affected — check the bot token / channel permissions / rate limits.",

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
  // 表头 (?) 的口径 —— 这一列的完整定义都在这里：三个 horizon、±0.5¢ 平推
  // 死区、「…」的补算节奏。页面正文只留会改变读数的那一句。
  "信号后 10m / 1h / 24h 的公开市价变化，按方向着色，±0.5¢ 内记平推；已结算的给命中 / 未中判定。「…」= 仍在补算，每分钟重试一批（一次最多 100 条）。":
    "Public market-price move 10m / 1h / 24h after the signal, colored by direction; moves within ±0.5¢ count as a push. Settled rows get a hit / miss verdict. An ellipsis means the row is still being computed — retried once a minute (up to 100 per batch).",
  " · 结算价 {res} vs 成交价 {fill}": " · resolved {res} vs fill {fill}",

  // --- WhitelistDialog（聪明钱白名单弹窗）--------------------------------
  // 其余键在 discovery 分片（该弹窗的原属主页）；这批是本轮新增的三档
  // 筛选与迁进 title 的口径，放在这里以免跨单改动 discovery.ts。
  // （「全部」裸键已在上面的 Conditions panel 段落里，不重复声明。）
  "全部 {n}": "All {n}",
  "有投票权 {n}": "Voting {n}",
  "机器人 {n}": "Bots {n}",
  白名单范围: "Whitelist scope",
  "做市机器人判定：成交市场数 ≥ 1000":
    "Market-maker rule: traded in ≥ 1,000 markets",
  "「无投票权」= 做市机器人：库存再平衡不是方向性观点，不计入共识 / 分歧投票。评分 / 胜率 / 净盈亏的「—」是判不了、不是 0。":
    '"No vote" = a market maker: inventory rebalancing is not a directional view, so it does not count toward consensus / disagreement votes. A dash under Score / Win rate / Net PnL means undecidable, not 0.',
};
