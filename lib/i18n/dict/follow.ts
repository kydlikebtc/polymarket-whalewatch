// follow 页字典分片 —— 键=中文原文,值=英文译文。由该页改造代理独家填写。
// 覆盖 app/follow/page.tsx(策略中心):策略卡/列表、结算净值曲线、赛道 ×
// 策略优势矩阵、仓位明细两张表、详情弹窗六个 tab(总览/深度分析/成本分解/
// 账户推演/操作历史/仓位明细)。
//
// 三类"数据即键"也收在此片(渲染处 t() 回查):
//   · 19 档策略名 —— 英文名与 lib/xComposer.ts STRATEGY_EN 逐字一致,
//     𝕏 播报与网页不能出现两套译名;
//   · 信号族 FAMILY_META 的 title/blurb(blurb 是源码里多段字符串拼接后的
//     整串,键必须是拼接结果);
//   · CROSS_TIER_CAVEAT 跨档相加口径声明。
// 「共识」「分歧」「策略」「胜率」「时间」「价格」等跨页共用词由更早/更晚
// 合并的分片(common/consensus/deep/glossary…)持有,此处不重复建键——
// 重复会被 dict/index.ts 的合并顺序静默覆盖。
export const DICT_FOLLOW: Record<string, string> = {
  // ------------------------------------------------ 格式化 / 执行层单元格
  "{n} 小时": "{n} h",
  "{n} 天": "{n} d",
  "盘口深度不足:${total} 名义只能成交 ${filled},均价按已成交部分计":
    "Insufficient book depth: only ${filled} of the ${total} notional could fill; the average price covers the filled portion only",
  "(薄)": "(thin)",

  // ------------------------------------------------------ 档位参数展示口径
  " · 信号触发时买对面(反向对照)":
    " · buys the opposite side when the signal fires (inverse control)",
  "≥{n} 钱包": "≥{n} wallets",
  "每钱包 ≥${v}": "≥${v} per wallet",
  "钱包评分≥{n}": "wallet score ≥{n}",
  "聪明钱总投入 ≥${v}": "smart-money total ≥${v}",
  "单笔 ≥${v}": "single fill ≥${v}",
  "一边倒分歧 · 主导边占比≥{pct}%": "lopsided split · dominant side ≥{pct}%",
  "分歧解除 · 少数边由净买转净卖":
    "standoff resolved · minority side flips from net buy to net sell",
  单钱包信号: "single-wallet signal",
  "净买≥${v}": "net buy ≥${v}",
  早期赢家渠道钱包: "early-winner channel wallets",
  "source={s}(未接入展示层)": "source={s} (not wired into the display layer)",
  持有到结算: "hold to settlement",
  "${v}/信号": "${v}/signal",
  "偏离≤{n}¢": "deviation ≤{n}¢",
  "新鲜度≤{n}分": "freshness ≤{n} min",
  "价格≤{n}¢": "price ≤{n}¢",

  // -------------------------------------------------------- 结算净值曲线
  "暂无已结算仓位 — 有策略平仓后这里会画出结算净值曲线":
    "No settled positions yet — once a strategy closes one out, the settled equity curve is drawn here",
  "各策略结算净值(累计已实现盈亏)平滑曲线,标记点为真实结算点":
    "Smoothed settled-equity (cumulative realized PnL) curve per strategy; the markers are actual settlement points",
  按信号族筛选净值曲线: "Filter the equity curves by signal family",
  "点选或用 Tab 聚焦任意结算点,查看该笔的日期与净值":
    "Click or Tab-focus any settlement point to see its date and equity",
  "唯一一笔已结算:{v}": "Only one settlement so far: {v}",
  "结算于 {d},净值 {v}": "Settled {d}, equity {v}",
  "结算净值走势,当前 {v}": "Settled equity curve, now {v}",
  "结算于 {d},当时净值 {v}": "Settled {d}, equity then {v}",

  // --------------------------------------------- 策略卡:标签 / 空态 / KPI
  反向对照: "Inverse control",
  本窗口领先: "Leading this window",
  已停用: "Disabled",
  尚无已结算仓位: "No settled positions yet",
  "持有 {n} 仓 · 等待首次结算": "{n} open · awaiting the first settlement",
  尚无仓位: "No positions yet",
  等待信号命中: "Awaiting a signal hit",
  结算净值: "Settled equity",
  "已结算仓位累计已实现盈亏(不含持仓浮盈)":
    "Cumulative realized PnL of settled positions (no unrealized PnL on open ones)",
  "结算净值 ÷ 已投入本金(仅已结算仓)":
    "Settled equity ÷ capital deployed (settled positions only)",
  平均年化: "Avg annualized",
  "结算净值 ÷ 峰值占用资金 × 365 ÷ 运行天数。把策略当一只小基金:按历史峰值备足本金、自成立日起折算年化。短窗口/小样本外推极不可靠,仅供横向对比;无结算仓或运行不足 1 天显示 —":
    "Settled equity ÷ peak capital in use × 365 ÷ days running. Treat the tier as a small fund: bankroll it to the historical peak and annualize from inception. Extrapolating a short window or a small sample is highly unreliable — use it for cross-tier comparison only; shown as — with no settled positions or under one day running",
  结算胜率: "Settled win rate",
  "盈利仓 ÷(盈利+亏损)仓 · Wilson 95% 置信区间;平局不计入分母":
    "Winning ÷ (winning + losing) positions · Wilson 95% confidence interval; pushes stay out of the denominator",
  "净值曲线从峰值到后续谷底的最大跌幅(美元)":
    "Largest peak-to-trough fall of the equity curve (USD)",
  建议跟单额度: "Suggested copy size",
  "= 历史峰值占用 × 1.25(按单仓金额向上取整),即恰好接住全部历史信号的最小资金 + ~25% 冗余;历史窗口口径,未来峰值可能更高。推导细节与五档精确回放见「查看详情 → 账户推演」":
    "= historical peak capital in use × 1.25 (rounded up to a whole position) — the smallest bankroll that catches every historical signal, plus ~25% headroom. Historical-window basis; future peaks may run higher. Derivation and the five-step replay live under View details → Account sizing",
  "已结算 {n} 仓": "{n} settled",
  "持有 {n}": "{n} open",
  "运行 {n} 天": "{n} days running",
  "已结算 · 持有": "Settled · Open",
  "已结算平仓数 · 当前持仓待结算数":
    "Settled closed positions · open positions awaiting settlement",

  // -------------------------------------------- 战绩全景:执行成本三件套
  累计追价成本: "Cumulative chase cost",
  "旧称「累计滑点」。份额 ×(自己入场价 − 聪明钱建仓均价)之和(美元)。正=追高多付的成本;负≠捡便宜(常是行情已反向/接飞刀)。注意:这不是盘口执行滑点——纸面按报价快照成交,价差/深度等执行成本未计入。中性展示,请结合单仓 ¢ 差与已实现盈亏一起看":
    "Formerly 'cumulative slippage'. Sum of shares × (our entry price − smart money's average entry), in USD. Positive = what chasing the move cost us; negative ≠ a bargain (usually the price already turned — catching a falling knife). Note: this is not order-book execution slippage — paper fills use the quote snapshot, so spread and depth costs are excluded. Shown neutral; read it alongside the per-position ¢ gap and realized PnL",
  "均 {c}/仓": "avg {c}/pos",
  "协议费(taker)": "Protocol fee (taker)",
  "开仓瞬间按 gamma feeSchedule 算的协议 taker 费之和(仅已结算仓)。公式 fee = 份额 × rate × p ×(1−p);对定额买单等价于 金额 × rate ×(1−p) —— 随成交价单调递减,冷门票才是相对最贵的($500 @0.2 约 4%、@0.5 约 2.5%、@0.9 约 0.5%)。「Polymarket 零手续费」已于 2026-08-04 实测作废:头部 100 市场 72 个收费、占 24h 量 57.8%,横跨 7 个品类。这一项通常远大于盘口执行滑点。费率表是当前值,老仓不回填,故带 n= 覆盖率":
    "Sum of the protocol taker fee computed from the gamma feeSchedule at entry (settled positions only). fee = shares × rate × p × (1−p); for a fixed-dollar buy that is equivalent to amount × rate × (1−p) — monotonically decreasing in fill price, so longshots are the relatively most expensive ($500 @0.2 ≈ 4%, @0.5 ≈ 2.5%, @0.9 ≈ 0.5%). 'Polymarket charges no fees' was falsified by measurement on 2026-08-04: 72 of the top 100 markets charge, covering 57.8% of 24h volume across 7 categories. This item is usually far larger than order-book execution slippage. The fee table holds current values and is not backfilled onto old positions, hence the n= coverage note",
  " · {n} 仓未知": " · {n} unknown",
  "净盈亏(含追价+协议费)": "Net PnL (after chase cost + protocol fee)",
  "三档口径里最接近实盘的一档:已实现盈亏 − 追价成本 − 协议费。上面的「已实现盈亏」是纸面档,不含任何执行成本。⚠️ 口径范围:三项都只在【协议费已知】的那批已结算仓上计算,而不是拿部分覆盖的费用去减全量盈亏(那会得到一个介于两档之间、无法解释的数)。协议费自 2026-08 起才采集、老仓不回填,所以这一档目前只覆盖一个子集;随着老仓陆续结算完毕会自然收敛到全量":
    "The closest of the three bases to live trading: realized PnL − chase cost − protocol fee. The Realized PnL above is the paper basis and carries no execution cost at all. ⚠️ Scope: all three terms are computed only over settled positions whose protocol fee is known, rather than subtracting partially covered fees from full PnL (which would yield an uninterpretable number sitting between the two bases). Protocol fees have only been collected since 2026-08 and are not backfilled, so this basis currently covers a subset; it converges to the full set as older positions settle out",
  "覆盖 {a}/{b} 仓": "covers {a}/{b} positions",
  均延迟成本: "Avg latency cost",
  "有形成价的仓位的(进场价 − 形成价)¢ 算术平均。正=共识形成后我们追贵了 —— 检测+执行延迟造成的可优化成本;与「累计追价成本」(vs 聪明钱均价、含拿不到的信息租金)口径不同。老仓位无形成价,不进样本":
    "Arithmetic mean of (entry price − formation price) in ¢ over positions that have a formation price. Positive = we paid up after the consensus formed — the optimizable cost of detection plus execution latency. Different basis from Cumulative chase cost (which is measured against smart money's average entry and includes information rent we can never capture). Older positions have no formation price and stay out of the sample",
  均执行滑点: "Avg execution slippage",
  "有盘口快照的仓位的(模拟成交均价 − 报价入场价)¢ 算术平均 —— 真实执行成本(跨价差+吃深度)的实测估计。开仓瞬间抓 CLOB 订单簿、按本仓名义金额模拟市价吃单;盘口无历史,执行层上线前的老仓不进样本":
    "Arithmetic mean of (simulated fill price − quoted entry price) in ¢ over positions that have a book snapshot — a measured estimate of true execution cost (crossing the spread plus eating depth). The CLOB order book is captured at entry and a market order for this position's notional is simulated against it. The book has no history, so positions opened before the execution layer shipped stay out of the sample",

  // -------------------------------------------------- 战绩全景:基金式档案
  开始时间: "Inception",
  "策略上线(成立)日期;运行时间与年化都以此为锚。老库缺创建时间时回退首仓开仓日":
    "The strategy's go-live (inception) date; running time and annualized return are both anchored to it. When the legacy database has no creation time we fall back to the first position's entry date",
  运行时间: "Running time",
  "自开始时间至今的时长(策略持续在跑,含无信号的空窗期)":
    "Time since inception (the strategy keeps running, quiet windows with no signals included)",
  最大占用资金: "Peak capital in use",
  "历史上任一时刻同时持有仓位的本金峰值(扫描线口径,open 仓占用至结算才释放)。即照此策略实盘需准备的本金,也是「平均年化」的分母":
    "Peak principal held simultaneously at any point in history (scanline basis — an open position stays locked up until it settles). This is the bankroll the tier would need live, and the denominator of Avg annualized",
  "平均持有 {d} 天": "avg hold {d} d",

  // ------------------------------------------------------ 成本四段分解
  "只看已结算仓。链尾净盈亏只计入追价成本与协议费,延迟成本 / 执行滑点是归因诊断读数,不重复计入。":
    "Settled positions only. The net P&L at the end of the chain counts chase cost and protocol fee alone — latency cost and execution slippage are attribution diagnostics and are not counted twice.",
  追价成本: "Chase cost",
  "已结算仓的追价成本合计:份额 ×(自己入场价 − 聪明钱建仓均价)之和(美元)。链的起点——我们比聪明钱买贵了多少,含拿不到的信息租金。口径与战绩全景「累计追价成本」相同但只算已结算仓,为了能与下面的协议费、净盈亏在同一批仓上相减。中性色:是成本不是盈亏":
    "Total chase cost across settled positions: sum of shares × (our entry price − smart money's average entry), in USD. The start of the chain — how much more we paid than smart money, information rent we can never capture included. Same basis as Cumulative chase cost in the record snapshot, but restricted to settled positions so it can be netted against the protocol fee and net PnL below over the same set. Neutral color: this is a cost, not PnL",
  "→ 延迟成本": "→ Latency cost",
  "有形成价的仓位的(进场价 − 形成价)¢ 算术平均。正=共识形成后我们追贵了 —— 检测+执行延迟造成的可优化成本;与「追价成本」(vs 聪明钱均价、含拿不到的信息租金)口径不同。老仓位无形成价,不进样本":
    "Arithmetic mean of (entry price − formation price) in ¢ over positions that have a formation price. Positive = we paid up after the consensus formed — the optimizable cost of detection plus execution latency. Different basis from Chase cost (measured against smart money's average entry, information rent included). Older positions have no formation price and stay out of the sample",
  "→ 执行滑点": "→ Execution slippage",
  "→ 协议费": "→ Protocol fee",
  "开仓瞬间按 gamma feeSchedule 算的协议 taker 费之和(仅已结算仓)。公式 fee = 份额 × rate × p ×(1−p);对定额买单等价于 金额 × rate ×(1−p) —— 随成交价单调递减,冷门票才是相对最贵的($500 @0.2 约 4%、@0.5 约 2.5%、@0.9 约 0.5%)。「Polymarket 零手续费」已于 2026-08-04 实测作废:头部 100 市场 72 个收费、占 24h 量 57.8%,横跨 7 个品类。费率表是当前值,老仓不回填,故带 n= 覆盖率":
    "Sum of the protocol taker fee computed from the gamma feeSchedule at entry (settled positions only). fee = shares × rate × p × (1−p); for a fixed-dollar buy that is equivalent to amount × rate × (1−p) — monotonically decreasing in fill price, so longshots are the relatively most expensive ($500 @0.2 ≈ 4%, @0.5 ≈ 2.5%, @0.9 ≈ 0.5%). 'Polymarket charges no fees' was falsified by measurement on 2026-08-04: 72 of the top 100 markets charge, covering 57.8% of 24h volume across 7 categories. The fee table holds current values and is not backfilled onto old positions, hence the n= coverage note",
  "⇒ 净盈亏(含追价成本+协议费)": "⇒ Net PnL (after chase cost + protocol fee)",

  // ----------------------------------------------------- 详情弹窗:框架
  "总览(净值走势 · 战绩全景) · 深度分析 · 成本分解 · 账户推演 · 操作历史 · 仓位明细":
    "Overview (equity curve · record snapshot) · Deep analysis · Cost breakdown · Account sizing · Action log · Position detail",
  查看详情: "View details",
  "{name} · 策略详情": "{name} · strategy details",
  策略详情分区: "Strategy detail sections",
  总览: "Overview",
  深度分析: "Deep analysis",
  成本分解: "Cost breakdown",
  账户推演: "Account sizing",
  操作历史: "Action log",
  仓位明细: "Position detail",
  净值走势: "Equity curve",
  "暂无已结算仓位 — 有仓位结算后这里会画出净值走势":
    "No settled positions yet — the equity curve is drawn here once positions settle",
  战绩全景: "Record snapshot",
  "该档暂无账户推演数据(尚无仓位,或建议额度不可用)":
    "No account-sizing data for this tier yet (no positions, or no suggested size available)",
  该策略尚无已结算的纸面仓位:
    "This strategy has no settled paper positions yet",
  该策略当前没有持仓中的纸面仓位:
    "This strategy currently holds no open paper positions",

  // -------------------------- 仓位明细工具条(详情弹窗与首页副 tab 共用)
  仓位状态: "Position status",
  "已结算 · 落袋({n})": "Settled · realized ({n})",
  "持有中 · 待结算({n})": "Open · awaiting settlement ({n})",
  不显示浮盈: "Unrealized PnL not shown",

  // ------------------------------------------------------- 账户推演
  按此额度年化: "Annualized at this size",
  "= 历史峰值占用 ${v} + ~25% 冗余(历史窗口口径,未来峰值可能更高)":
    "= historical peak capital in use ${v} + ~25% headroom (historical-window basis; future peaks may run higher)",
  "账户推演 · 该备多少钱": "Account sizing · how much to fund",
  "平均占用 ${v}": "avg in use ${v}",
  " · 峰值额度下使用效率 {pct}": " · utilization at the peak size {pct}",
  "若账户只备这么多钱(0.25/0.5/0.75/1/1.25 × 峰值占用)":
    "If the account only holds this much (0.25/0.5/0.75/1/1.25 × peak capital in use)",
  若账户: "Account size",
  "按开仓顺序回放:资金不足即错过该信号":
    "Replayed in entry order: if cash runs short, that signal is missed",
  "接住 · 错过": "Caught · Missed",
  "接住且已结算仓位的已实现盈亏合计(不含浮盈)":
    "Total realized PnL of caught positions that have settled (no unrealized PnL)",
  "落袋 ÷ 账户额 × 365 ÷ 运行天数;无结算仓或运行不足 1 天为 —":
    "Realized ÷ account size × 365 ÷ days running; — with no settled positions or under one day running",
  年化: "Annualized",
  "时间加权平均占用 ÷ 账户额(含零仓闲置期)":
    "Time-weighted average capital in use ÷ account size (idle zero-position stretches included)",
  效率: "Utilization",
  建议: "Suggested",
  恰接住: "Exact fit",
  "回放是精确值不是估计:每仓固定 $/信号且互相独立,资金不够即错过、结算即释放。":
    "The replay is exact, not an estimate: every position is a fixed $/signal and independent of the others — a short account misses the signal, settlement releases the capital.",

  // ------------------------------------------------------- 操作历史
  "{a} 次买入 · {b} 次兑现 · 仅记录已执行动作,被护栏 / 新鲜度闸门拦下的信号不在此列":
    "{a} buys · {b} exits · only executed actions are logged — signals stopped by the guardrails or the freshness gate are not listed",
  "动作发生时刻(本地时区),悬停看完整时间":
    "When the action happened (local time zone); hover for the full timestamp",
  动作: "Action",
  "买入行 = 进场价,下附信号形成时间与检测延迟;兑现行 = 结算价,下附持有时长":
    "Buy rows show the entry price with the signal formation time and detection lag beneath; exit rows show the settlement price with the holding time beneath",
  "买入行 = 投入本金;兑现行 = 已实现盈亏":
    "Buy rows show the principal deployed; exit rows show realized PnL",
  "金额 / 盈亏": "Amount / PnL",
  兑现: "Exit",
  "信号 {d} · 延迟 {n} 分": "signal {d} · lag {n} min",
  "持有 {v}": "held {v}",

  // ------------------------------------------------------- 策略列表视图
  暂无启用中的跟单策略: "No active copy strategies",
  "结算净值 ÷ 峰值占用资金 × 365 ÷ 运行天数。短窗口/小样本外推极不可靠,仅供横向对比":
    "Settled equity ÷ peak capital in use × 365 ÷ days running. Extrapolating a short window or a small sample is highly unreliable — use it for cross-tier comparison only",
  "= 历史峰值占用 × 1.25(按单仓金额向上取整);推导细节与五档精确回放见「详情 → 账户推演」":
    "= historical peak capital in use × 1.25 (rounded up to a whole position); derivation and the five-step replay live under Details → Account sizing",
  建议额度: "Suggested size",
  "当前持仓待结算数 / 策略运行天数":
    "Open positions awaiting settlement / days the strategy has been running",
  "持有 / 运行": "Open / Running",
  领先: "Leading",
  操作: "Actions",
  详情: "Details",

  // ------------------------------------------------- 仓位明细:已结算表
  尚无已结算的纸面仓位: "No settled paper positions yet",
  "现价进场 → 结算价(美分)": "Live-price entry → settlement price (cents)",
  "进价→结算价": "Entry→Settle",
  "旧称「滑点」。入场价 − 聪明钱建仓均价(¢ 差,括号内为美元口径)。正=追高;负≠捡便宜(常是行情已反向);|¢差|>10 琥珀警示。口径含聪明钱的信息租金(他们买得早/便宜,拿不到别追)—— 与「延迟成本」(vs 形成价)不同;也不是盘口执行滑点(纸面按报价快照成交,不吃盘口)":
    "Formerly 'slippage'. Entry price − smart money's average entry (¢ gap, USD in brackets). Positive = we chased; negative ≠ a bargain (usually the price already turned); |¢ gap| > 10 turns amber. This basis includes smart money's information rent (they bought earlier and cheaper — if you cannot get that price, do not chase) and so differs from Latency cost (measured against the formation price); it is also not order-book execution slippage, since paper fills use the quote snapshot and never eat the book",
  "进场价 − 形成价(¢)。形成价=第 N 个白名单钱包到位那一刻的市价;正=共识形成后追贵了,是系统检测+执行延迟造成的可优化成本(不含信息租金,与「追价成本」口径不同)。老仓位/取价失败显示 —;|¢|>10 琥珀,与进场偏离护栏阈一致":
    "Entry price − formation price (¢). The formation price is the market price at the moment the Nth whitelisted wallet arrived. Positive = we paid up after the consensus formed — the optimizable cost of detection plus execution latency (no information rent, unlike Chase cost). Older positions and failed price fetches show —; |¢| > 10 turns amber, matching the entry-deviation guardrail threshold",
  "开仓瞬间抓 CLOB 盘口快照,按本仓名义金额模拟市价吃单:模拟成交均价 − 报价入场价(¢)。真实执行成本(跨价差+吃深度)的实测估计;琥珀(薄)=盘口深度不足只能部分成交。盘口无历史,仅新开仓有值,老仓显示 —":
    "The CLOB book is snapshotted at entry and a market order for this position's notional is simulated against it: simulated fill price − quoted entry price (¢). A measured estimate of true execution cost (crossing the spread plus eating depth); amber (thin) = the book was too shallow to fill in full. The book has no history, so only newly opened positions carry a value and older ones show —",
  "markout:形成后 2 小时市价 − 形成价(¢),衡量共识形成后还有没有肉。涨绿跌红(±0.5¢ 死区记平推);形成价或 2h 回填价缺失显示 —":
    "Markout: market price two hours after formation − formation price (¢) — is there still meat on the bone once the consensus forms. Green up, red down (a ±0.5¢ dead zone counts as flat); shown as — when the formation price or the 2h backfill is missing",
  形成后2h: "2h markout",
  持有期: "Held",
  已实现: "Realized",
  // 卡底琥珀条:降级态用最短句式列全(触屏读不到列头 title);配色语义留在
  // 各列头的 (?) 里,不在表下重复。
  "⚠️「—」= 判不了,不是 0:延迟成本 / 形成后2h = 老仓无形成价 · 执行滑点 = 盘口无历史 · 结算价 = 无读数;「薄」= 盘口吃不满本仓,均价按已成交部分计。":
    "⚠️「—」means undecidable, not 0: latency cost / 2h markout = an old position with no formation price · execution slippage = the book has no history · settlement price = no reading. 「thin」 = the book could not fill this position's notional, so the average price covers the filled portion only.",
  "取价失败,或该市场暂无可用的近期行情数据":
    "Price fetch failed, or this market has no recent quote data available",

  // ------------------------------------------------- 仓位明细:持仓中表
  当前没有持仓中的纸面仓位: "No open paper positions right now",
  "现价进场价(美分)": "Live-price entry (cents)",
  进价: "Entry",
  "当前市价快照(括号内为相对进场价的 ¢ 差,涨绿跌红),仅供参考——不进 ROI/胜率/年化等任何战绩口径;本页所有指标均为结算口径(只记结算盈亏,不做浮盈)。前端惰性加载,取价失败或该 token 暂无行情数据显示 —":
    "Snapshot of the current market price (the brackets hold the ¢ gap versus entry, green up and red down). Reference only — it feeds no record metric: not ROI, win rate or annualized return. Every figure on this page is on a settlement basis (realized PnL only, no unrealized). Loaded lazily on the client; a failed fetch or a token with no quote data shows —",
  当前价: "Now",
  已持有: "Held",
  待结算: "Awaiting settlement",
  // 卡底琥珀条(持仓中表):三处「—」+ 一个「…」中间态 + 一句「不进战绩」。
  "⚠️「—」= 判不了,不是 0:当前价 = 缺 asset 或取价失败(取价中显示「…」)· 延迟成本 = 老仓无形成价 · 执行滑点 = 盘口无历史;「薄」= 盘口吃不满本仓,均价按已成交部分计。当前价仅供参考,不进任何战绩口径。":
    "⚠️「—」means undecidable, not 0: Now = the asset id is missing or the fetch failed (a fetch in flight shows 「…」) · latency cost = an old position with no formation price · execution slippage = the book has no history. 「thin」 = the book could not fill this position's notional, so the average price covers the filled portion only. The current price is reference only and feeds no record metric.",

  // ------------------------------------------ 赛道 × 策略优势矩阵(副 tab)
  "暂无已结算仓位 — 有仓位结算后这里会给出「哪类信号在哪个赛道有 edge」的透视矩阵":
    "No settled positions yet — once positions settle, this becomes a pivot of which signal type holds an edge on which track",
  "格子 = edge(实际胜率 − 隐含胜率)· 胜率 · 仓数 · 落袋;「全部」行跨档聚合,样本含重复下注。":
    "Each cell holds the edge (actual win rate − implied win rate) · win rate · position count · realized P&L. The 「All」 row is a cross-tier aggregate, so its sample contains duplicate bets.",

  // -------------------------------------------------- 页头 / 加载 / 空态
  "最后刷新 {time}": "Last refreshed {time}",
  "📡 真实数据": "📡 Real data",
  "真实市场行情 · 真实聪明钱成交 · 真实结算价——策略吃的是市场当时的真实报价,不是模拟盘口":
    "Real market quotes · real smart-money fills · real settlement prices — the strategy trades against the market's actual quote at that moment, not a simulated book",
  "🧪 模拟策略": "🧪 Simulated strategy",
  "策略本身不动真金:按报价快照纸面成交,不产生真实订单,用来检验「跟着信号买」这套策略有没有 alpha":
    "The strategy itself risks no real money: paper fills against the quote snapshot, no real orders placed. It exists to test whether 'buy what the signal says' carries any alpha",
  "加载失败: {msg}": "Load failed: {msg}",
  "正在加载策略中心战绩…": "Loading the Strategy Center record…",
  "暂无启用中的跟单策略 — 引擎播种聪明钱白名单并跑通一轮跟单后,这里会按信号族出现各档的纸面战绩":
    "No active copy strategies — once the engine seeds the smart-money whitelist and completes a copy cycle, each tier's paper record shows up here by signal family",

  // ------------------------------------------------------- 视图 / 副 tab
  展示方式: "Display mode",
  卡片: "Cards",
  列表: "List",
  "各档持仓重叠,战绩不可跨档相加":
    "tiers hold overlapping positions — records cannot be summed across tiers",
  数据区切换: "Data view",
  结算净值曲线: "Settled equity curve",
  "赛道 × 策略优势矩阵": "Track × strategy edge matrix",
  "仓位明细({n})": "Position detail ({n})",
  "累计已实现盈亏 · 实线/虚线区分策略":
    "Cumulative realized PnL · solid and dashed lines distinguish strategies",
  按策略筛选仓位: "Filter positions by strategy",
  全部策略: "All strategies",
  "对当前筛选的全部历史下注做六维度可视化分析:下注质量 · 赔率带校准 · 盈亏分布 · 时间走势 · 持有时长 · 赛道细分":
    "Run a six-view visual analysis over every historical bet in the current filter: bet quality · odds-band calibration · PnL distribution · time trend · holding duration · track breakdown",
  "深度分析({name})": "Deep analysis ({name})",
  "深度分析(全部策略)": "Deep analysis (all strategies)",
  "深度分析 · {name}": "Deep analysis · {name}",
  "全部策略聚合:多档会跟进同一信号,样本含跨档重复下注,不是相互独立的下注":
    "All-strategy aggregate: several tiers follow the same signal, so the sample contains cross-tier duplicate bets and is not a set of independent bets",
  "「{name}」策略尚无已结算的纸面仓位":
    "Strategy “{name}” has no settled paper positions yet",
  "「{name}」策略当前没有持仓中的纸面仓位":
    "Strategy “{name}” currently holds no open paper positions",

  // --------------------------------- 信号族 FAMILY_META(title + 拼接 blurb)
  "N 个聪明钱同时看多同一边,值不值得跟。":
    "N smart-money wallets take the same side at once — is that worth following.",
  异常大额: "Outsized fills",
  "一笔巨额单本身算不算信号(不等第 N 人到位)。「反巨鲸」「反超级巨鲸」「反巨鲸精英」是对应正向档的反向对照:同一笔单、同一时刻买对面 —— 正向档持续亏而反向档持续赢,说明巨鲸大单在这个市场结构里更像流动性需求方而非信息方,该反着用;两边都亏,则是执行成本在吃双边。":
    "Is one huge fill a signal on its own, without waiting for an Nth wallet. Inverse Whale, Inverse Mega Whale and Inverse Elite Whale are the inverse controls of the matching forward tiers: same fill, same moment, opposite side. If the forward tier keeps losing while the inverse keeps winning, whale-sized orders in this market structure behave more like liquidity demand than information and should be read backwards; if both sides lose, execution cost is eating both.",
  '聪明钱意见不一致时,跟主导边还是少数边——「一边倒分歧」跟多数、「逆势少数边」跟少数,同一批市场、同一个形成时刻的一组对照,不是两个独立策略:主导边持续赢说明质量权重判据有效,少数边持续赢则提示评分体系可能有盲区,或少数派掌握了权重算法看不见的信息。「反分歧解除」(v4)同理是「分歧解除」的镜像:少数边认输时,正向跟主导边,反向买被放弃的那一边 —— 验证"认输"到底是趋势确认还是底部信号。':
    "When smart money disagrees, follow the dominant side or the minority. Lopsided Majority follows the majority, Contrarian Minority follows the minority — the same markets at the same formation moment, one control pair rather than two independent strategies. If the dominant side keeps winning, the quality-weighting criterion works; if the minority keeps winning, the scoring system may have a blind spot, or the minority holds information the weighting algorithm cannot see. Inverse Standoff Resolved (v4) mirrors Standoff Resolved the same way: when the minority capitulates, the forward tier follows the dominant side while the inverse buys the abandoned one — testing whether capitulation confirms the trend or marks the bottom.",
  钱包画像: "Wallet profile",
  "一个足够好的钱包,一个人说了算吗。「反高分独狼」「反早期赢家」是对应正向档的反向对照:同一个钱包信号、同一时刻买对面 —— 画像档持续亏而反向档持续赢,说明该画像筛出的是反向指标人群,信号仍有价值,只是方向用反了。":
    "Can one good enough wallet call it alone. Inverse Lone Wolf and Inverse Early Winner are the inverse controls of the matching forward tiers: same wallet signal, same moment, opposite side. If the profile tier keeps losing while the inverse keeps winning, the profile is selecting a contrarian-indicator crowd — the signal still has value, it was just pointed the wrong way.",
  其它: "Other",
  "尚未归入以上四族的信号源。":
    "Signal sources not yet assigned to the four families above.",
  "各档持仓存在重叠(同一市场可能同时命中多个信号源——例如「激进」的持仓是「保守」的超集、「巨鲸精英」是「巨鲸」的子集)。每一档的战绩都是「只跟这一档」的独立假设下算出的,不可跨档相加;同理,每张卡的「建议跟单额度」也是单档口径——12 档一起跟所需的总资金,不是 12 个峰值之和。":
    "Tiers hold overlapping positions — one market can trigger several signal sources at once (Aggressive Consensus is a superset of Conservative Consensus, Elite Whale a subset of Whale Follow). Every tier's record is computed under the standalone assumption of following that tier only, so records cannot be summed across tiers. The same goes for each card's Suggested copy size: it is a single-tier figure, and the bankroll needed to run all 12 tiers together is not the sum of 12 peaks.",

  // ------------------- 19 档策略名(与 lib/xComposer.ts STRATEGY_EN 一致)
  保守: "Conservative Consensus",
  激进: "Aggressive Consensus",
  精英共识: "Elite Consensus",
  重仓共识: "Heavy Consensus",
  首发共识: "First-Mover Consensus",
  巨鲸: "Whale Follow",
  超级巨鲸: "Mega Whale",
  巨鲸精英: "Elite Whale",
  一边倒分歧: "Lopsided Majority",
  分歧解除: "Standoff Resolved",
  高分独狼: "Lone Wolf",
  早期赢家跟投: "Early Winner",
  逆势少数边: "Contrarian Minority",
  反巨鲸: "Inverse Whale",
  反超级巨鲸: "Inverse Mega Whale",
  反巨鲸精英: "Inverse Elite Whale",
  反分歧解除: "Inverse Standoff Resolved",
  反高分独狼: "Inverse Lone Wolf",
  反早期赢家: "Inverse Early Winner",
  // 容量标尺(第一梯队五件套,2026-08-28)
  "容量(+1¢) ~${a}": "Depth(+1¢) ~${a}",
  "容量(+1¢ · +3¢)": "Capacity (+1¢ · +3¢)",
  "开仓瞬间盘口 +1¢ 带内深度的中位数 —— 跟随资金把成交价推高 1¢ 之前最多能吃的金额。详情面板有 +3¢ 档与覆盖率":
    "Median in-band book depth (+1¢) at entry — the most follower money could absorb before pushing the fill 1¢ past best ask. The detail panel adds the +3¢ band and coverage",
  "开仓瞬间 ask 簿的带内深度中位数:把成交价推出最优价 +1¢/+3¢ 之前,跟随资金最多能吃的美元额。回答「这个信号能装下多少钱」—— 信号是真的但只有 $3k 深,跟随者必须知道。中位数抗离群(一次厚簿会把均值拉爆);盘口无历史,2026-08-28 前的老仓无此快照,故带 n= 覆盖率。纯归因展示,不参与开仓与盈亏":
    'Median in-band ask-book depth at entry: the max USD follower money could absorb before pushing the fill past best ask +1¢/+3¢. Answers "how much money fits this signal" — a real signal that is only $3k deep is something a follower must know. Median resists outliers (one thick book would blow up the mean); books have no history, so positions before 2026-08-28 carry no snapshot — hence the n= coverage. Attribution display only, never enters entries or P&L',
  // 衰变哨兵(第一梯队五件套,2026-08-28)
  "⚠ 疑似衰变": "⚠ Possible decay",
  衰变观察: "Decay watch",
  衰变哨兵: "Decay sentinel",
  健康: "Healthy",
  // 「样本不足」沿用 alerts 分片既有译文("small sample")—— 跨分片同键
  // 必须同值,这里不重复登记。
  "市场点 {n}(需 ≥15)": "{n} market points (needs ≥15)",
  "基线 {a}¢ → 近端 {b}¢ · 市场点 {n}":
    "Baseline {a}¢ → recent {b}¢ · {n} market points",
  "序贯监控这档策略是否在失效:已结算仓折成市场级观察点(同市场多仓共享同一次结算,只算一点),前段做基线,后段跑单侧 CUSUM 盯下行漂移。观察线 2.5σ、报警线 4σ;逐仓贡献与 walk-forward 同口径((已实现−协议费)÷份额,概率点)。哨兵只亮牌,不自动停用任何档 —— 生产参数永不自动改":
    "Sequentially monitors whether this tier is decaying: settled positions fold into market-level observation points (positions in one market share a single settlement — one point), the earlier stretch forms the baseline, and a one-sided CUSUM watches the rest for downward drift. Watch line 2.5σ, alarm line 4σ; per-position contribution matches walk-forward ((realized − fee) ÷ shares, probability points). The sentinel only raises flags — it never auto-disables a tier; production parameters are never auto-modified",
  // ============================================================ Etherscan 风
  // 换皮那一轮新增的文案(页头小标 / 卡内标题条的口径半句 / 卡底说明条 /
  // 徽章与空态)。键=中文原文,与 app/follow/page.tsx 的 t() 字面量逐字一致。
  "📈 模拟策略 · 不动真金": "📈 Simulated strategies · no real money",
  "各档纸面策略的战绩:现价进场 · 持有到结算 · 固定 $/信号 · 仅结算盈亏(不做浮盈)。":
    "Every tier's paper record: enters at market · holds to settlement · fixed $/signal · settled P&L only (no unrealized).",
  "⚠️ 纸面成交不含盘口执行成本(价差 / 深度),盈亏偏乐观 —— 实测见「执行滑点」列。":
    "⚠️ Paper fills exclude book execution cost (spread / depth), so P&L reads optimistic — the measured estimate is in the 「Execution slippage」 column.",
  "族序 = 信息强度递减 · 可多选叠画":
    "Families run in decreasing information strength · multi-select to overlay",
  按策略筛选: "Filter by strategy",
  "{n} 档": "{n} tiers",
  "盈利仓 ÷(盈利+亏损)仓 · Wilson 95% 置信区间与已结算样本量。50% / 8 仓 和 58% / 24 仓不该长得一样重,区间宽度就是这份轻重;平局不计入分母":
    "Winning positions ÷ (winning + losing) positions · Wilson 95% confidence interval plus the settled sample size. 50% over 8 positions and 58% over 24 should not carry the same weight — the interval width is that weight; pushes are excluded from the denominator",
  "样本不足 · {n} 仓": "Small sample · {n} settled",
  // 「{n} 仓」由 deep 分片持有("{n} pos"),跨分片同键必须同值 —— 这里
  // 不重复建键,列表视图胜率格直接复用它。
  "备付现金 · 无杠杆": "Cash on hand · no leverage",
  "容量(+1¢) ~${a} · n={n}": "Depth(+1¢) ~${a} · n={n}",
  "序贯监控这档策略是否在失效:已结算仓折成市场级观察点,前段做基线,后段跑单侧 CUSUM 盯下行漂移。哨兵只亮牌,不自动停用任何档":
    "Sequentially monitors whether this tier is decaying: settled positions fold into market-level observation points, the earlier stretch forms the baseline, and a one-sided CUSUM watches the rest for downward drift. The sentinel only raises flags — it never auto-disables a tier",
  "push 不进分母": "pushes excluded from the denominator",
  平均年化的分母: "the denominator of Avg annualized",
  "成本三项(追价 / 协议费 / 容量)是成本不是盈亏,一律中性色;带 n= 的读数须连样本量一起读。":
    "The three cost readings (chase / protocol fee / capacity) are costs, not P&L, and are always neutral in color; readings carrying n= must be read together with their sample size.",
  "链的起点 · 已结算仓口径": "Start of the chain · settled-positions basis",
  "n={n} · 检测 + 执行延迟": "n={n} · detection + execution latency",
  "n={n} · 跨价差 + 吃深度": "n={n} · crossing the spread + eating depth",
  "⚠️ 三项只在协议费已知的那批已结算仓上计算(覆盖率见 n=),不是拿部分费用去减全量盈亏。":
    "⚠️ All three are computed only over the settled positions whose protocol fee is known (coverage is the n=), not by subtracting partially covered fees from full P&L.",
  "错过 {n}": "{n} missed",
  错过的钱: "Money missed",
  "资金不够而错过的那些信号,事后按已结算口径合计的盈亏 —— 中性色:是「没接住」,不是亏损":
    "Settled-basis P&L of the signals that were missed for lack of funds — neutral in color: this is money not caught, not a loss",
  "该策略尚无操作历史 —— 信号命中并开出第一仓后,这里会按时间倒序记录买入与兑现":
    "No action history for this tier yet — once a signal hits and the first position opens, buys and settlements are logged here newest-first",
  "买入 = 信号触发后现价开仓(绿);兑现 = 市场结算平仓(蓝)。输赢由右侧「金额 / 盈亏」的颜色回答,不由动作徽章回答":
    "Buy = opened at market after the signal fired (green); Settle = closed at market resolution (blue). Win or loss is answered by the color of 「Amount / P&L」 on the right, not by the action badge",
  "· 累计已实现盈亏 · 不含持仓浮盈":
    "· cumulative realized P&L · excludes unrealized",
  "结算点才是真实数据,曲线只是连接方式 —— 净值只在结算这一刻变化。":
    "The settlement points are the real data; the curve is only how they are joined — equity changes only at the moment of settlement.",
  "· 四项口径不同,不是同口径数字的简单相加":
    "· the four use different bases — they are not a like-for-like sum",
  "· 建议 ${v} · Polymarket 无杠杆":
    "· suggested ${v} · Polymarket has no leverage",
  "· 倒序 · 纸面模拟,无真实成交":
    "· newest first · paper simulation, no real fills",
  // 列表视图恢复单行密度后的文案（见 app/follow/page.tsx StrategyListRow）
  等待命中: "Awaiting a hit",
  等待结算: "Awaiting settlement",
  "盈利仓 ÷(盈利+亏损)仓;平局不计入分母":
    "Winning positions ÷ (winning + losing); ties are excluded from the denominator",
  "盈利仓 ÷(盈利+亏损)仓,括号内为已结算样本量(样本不足前面加 ⚠);平局不计入分母。Wilson 95% 置信区间在「详情」里 —— 区间文本挤不进表格一行":
    "Winning positions ÷ (winning + losing); the number in parentheses is the settled sample size (prefixed with ⚠ when the sample is small). Ties are excluded from the denominator. The Wilson 95% interval lives in Details — the interval text does not fit on one table row",
};
