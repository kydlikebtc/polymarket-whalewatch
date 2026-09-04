// glossary 页字典分片 —— 键=中文原文,值=英文译文。由该页改造代理独家填写。
// 覆盖三份数据的全部 UI 串:app/glossary.ts(ICONS/TERMS/WALLET_TAGS —— 全站
// Icon tooltip 与 /discovery 标签弹窗同源)、lib/walletTags 产出的标签 label、
// 以及 /glossary 页面自身文案。术语与 README 英文既有用词对齐(whale fill /
// split-buy / fresh wallet / consensus / disagreement / validation loop /
// admission gate / discovery channels …)。
// 唯一去重纪律:**先行分片已登记的键,此处一律不重复登记** —— glossary 在
// index.ts 里几乎最后合并,重复键会静默覆盖别页选定的译法。已让位的词表串:
//   common/home/alerts/consensus/accumulation → 拆单累计 · 复制 market slug ·
//     战绩 · 净买入 · 距结算 · 跟单空间 · 24h 方向命中
//   discovery → 共识同行 · 拆单建仓 · 内幕签名 · 早期赢家 · 做市机器人 ·
//     全局榜 · 状态 · 标签 · 定义 · 以及 14 个数据侧标签底文(🏆 手动白名单 /
//     🤖 做市机器人 / 🏛 全局榜 / 池成员·来源未知 / 6 类 🏅 分类榜·<cat> /
//     4 渠道 🔭 发现入池·<ch>)
//   wallet → 类别 · PUSD 现金余额;  market → 聪明钱共识 · 聪明钱分歧
// 让位不等于漏译:合并后这些键照样有译文(见 lib/i18n/coverage.test.ts 与
// 本页覆盖率自查),只是属主在别的分片。
export const DICT_GLOSSARY: Record<string, string> = {
  // -------------------------------------------------------- 页面自身文案
  "📖 图标与名词说明": "📖 Icon & term reference",
  "全站所有符号和术语的定义 — 鼠标悬停在任意页面的图标上也能看到同样的解释":
    "Definitions for every symbol and term across the site — hovering any icon on any page shows the same explanation",
  图标标识: "Icons",
  "钱包标签（聪明钱发现 / 钱包档案页）":
    "Wallet tags (smart-money discovery / wallet dossier)",
  核心名词: "Core terms",
  "信号强度速查（由弱到强）": "Signal strength quick map (weakest → strongest)",
  符号: "Symbol",
  名称: "Name",
  含义: "Meaning",
  名词: "Term",
  解释: "Explanation",
  // Etherscan 风版式(设计稿 17):页头小标 / 标题 / 计数描述 + 跳转条 +
  // 五级阶梯卡 + 三组标签卡 + 双栏定义列表。
  "名词级定义 · 板块级见「功能说明书」":
    "Term-level definitions · section-level lives in the feature guide",
  "说明 · 图标与名词": "Reference · icons & terms",
  "{i} 个图标 · {w} 个钱包标签 · {n} 个名词。信号强度五级阶梯在最前，其余按出现顺序排列。":
    "{i} icons · {w} wallet tags · {n} terms. The five-step signal ladder comes first; the rest follow the order they appear in.",
  "共 {n} 条": "{n} entries",
  跳到: "Jump to",
  信号阶梯: "Signal ladder",
  图标: "Icons",
  钱包标签: "Wallet tags",
  "· {n} 个": "· {n} total",
  "· {n} 个 · 按成交 / 结算 / 交互排列":
    "· {n} total · ordered by fill / settlement / interaction",
  信号强度五级阶梯: "Five-step signal strength ladder",
  "· 从「值得看一眼」到「值得停下来」":
    '· from "worth a glance" to "worth stopping for"',
  "单笔达阈值（默认 ≥$10k）":
    "Single fill hits the threshold (≥$10k by default)",
  "单笔 ≥$50k": "Single fill ≥$50k",
  多笔小额累积净买入: "Net buy accumulated from many small fills",
  白名单钱包在场: "A whitelisted wallet is in it",
  "≥2 个白名单同向": "≥2 whitelisted wallets on the same side",
  "阶梯只表示「本站认为该多看一眼」的程度，不表示胜率高低 —— 后者去信号战绩页。":
    "The ladder only ranks how much extra attention this site thinks something deserves — not hit rate. For that, go to the signal record page.",
  "有人下了重注（最基础）": "someone placed a heavy bet (the most basic layer)",
  "有人在刻意隐藏地建仓（绕过单笔监控）":
    "someone is deliberately building a hidden position (dodging single-fill monitoring)",
  甜区赔率: "sweet-spot odds",
  "新钱包在有利赔率上下重注（可疑）":
    "a fresh wallet betting big at favorable odds (suspicious)",
  聪明钱出手: "Smart money steps in",
  "历史高胜率的钱包在买（有战绩背书）":
    "historically high-win-rate wallets are buying (a track record behind them)",
  "多个高胜率钱包独立得出同一结论（最强单一信号）":
    "several high-win-rate wallets independently reaching the same conclusion (the strongest single signal)",
  "无论哪一层，📐 验证列都会在事后告诉你：这个信号最终准不准。":
    "Whichever layer it is, the 📐 validation column tells you after the fact whether the signal actually held up.",

  // ------------------------------------------------ ICONS · 名称 / tip / 详解
  // 💰
  大额成交: "Large trade",
  "大额成交：单笔金额达到告警阈值（默认 ≥$10k）":
    "Large trade: a single fill at or above the alert threshold (default ≥$10k)",
  "单笔名义金额（份额 × 价格）达到告警阈值的成交，默认 ≥$10,000。这是最基础的信号层：钱包一次性打出的大单。":
    "A fill whose notional amount (shares × price) reaches the alert threshold, ≥$10,000 by default. The most basic signal layer: a big order a wallet fires in one shot.",
  // 🐳
  巨鲸单: "Whale fill",
  "巨鲸单：单笔 ≥$50k 的顶级大额成交":
    "Whale fill: a top-tier large trade of ≥$50k in a single fill",
  "单笔 ≥$50,000 的成交，大额成交里的顶级档位。档位按成交额固定判定（看板与 Telegram 推送一致），不随告警阈值配置变化——调低 minUsd 不会让小单变 🐳，调高也不会让每条都是 💰。":
    "A single fill of ≥$50,000 — the top tier of large trades. Tiers are fixed by fill size (dashboard and Telegram pushes agree) and never move with the alert-threshold config: lowering minUsd will not turn small fills into 🐳, and raising it will not make every alert a 💰.",
  // 🧩 (名称「拆单累计」已在 common 分片)
  "拆单累计：多笔小单累积出的净买入（每笔都低于大单阈值）":
    "Split-buy accumulation: a net buy-in built up from many small orders (each below the large-trade threshold)",
  "同一钱包在同一（市场 · 结果）上用多笔小额订单累积出的净买入仓位——每一笔都刻意低于单笔告警阈值，逃过单笔监控。实测单笔监控会漏掉约 60% 的 ≥$10k 累计建仓者，拆单累计榜就是为抓这批人而生。":
    "A net buy-in position one wallet accumulates on one (market · outcome) through many small orders — each deliberately below the single-fill alert threshold, slipping past single-trade monitoring. In live testing, single-trade monitoring missed about 60% of ≥$10k accumulators; the split-buy accumulation board exists to catch exactly them.",
  // 🆕
  新钱包: "Fresh wallet",
  "新钱包：地址年龄 ≤30 天（红色 = <7 天）":
    "Fresh wallet: address age ≤30 days (red = <7 days)",
  "地址年龄 = 该钱包首次 Polymarket 链上活动至今的时长。≤30 天显示确切天数并标 🆕，<7 天红色高亮，<1 天精确到小时/分钟。为一笔交易专门开新钱包是最强的内幕信号之一。年龄永久缓存（出生时间不会变）。":
    "Address age = time since the wallet's first on-chain Polymarket activity. ≤30 days shows the exact day count with a 🆕 badge, <7 days is highlighted red, <1 day is precise to hours/minutes. A wallet created just for one trade is among the strongest insider signals. Age is cached permanently (a birth time never changes).",
  // 🏆
  "聪明钱（白名单）": "Smart money (whitelist)",
  "聪明钱：官方盈利榜自动播种的高盈利白名单钱包":
    "Smart money: high-profit whitelist wallets auto-seeded from the official profit leaderboards",
  "每日自动从 Polymarket 官方盈利排行榜（周榜/月榜/总榜）播种的高盈利钱包池，并用已结算战绩（/closed-positions）富集出 0-100 评分。命中白名单的成交在告警和表格里都会打上 🏆。30 天未再上榜的自动过期；手动加入的永久保留。":
    "A pool of high-profit wallets seeded daily and automatically from Polymarket's official profit leaderboards (weekly / monthly / all-time), enriched with a 0-100 score from the settled track record (/closed-positions). Fills that hit the whitelist get a 🏆 in both alerts and tables. Wallets absent from the boards for 30 days expire automatically; manually added ones are kept forever.",
  // 🔥 (名称「聪明钱共识」已在 market 分片)
  "共识：≥2 个白名单钱包同向买入同一结果":
    "Consensus: ≥2 whitelist wallets buying the same outcome in the same direction",
  "时间窗内 ≥2 个互不相同的白名单钱包，各自净买入 ≥$5,000 同一市场的同一结果。几个高胜率钱包独立得出同一结论，比任何单笔巨鲸单都更有说服力。只在共识形成和升级（又一个钱包加入）时推送，不重复轰炸。":
    "Within the time window, ≥2 distinct whitelist wallets each net-buy ≥$5,000 of the same outcome in the same market. Several high-win-rate wallets independently reaching the same conclusion beats any single whale fill. Pushes only on consensus formation and escalation (another wallet joining) — never repeat-bombing.",
  // ⚖️ (名称「聪明钱分歧」已在 market 分片)
  "分歧：白名单钱包在同一市场的对立结果各自建仓，按质量加权称天平":
    "Split (disagreement): whitelist wallets build positions on opposing outcomes of one market, weighed on a quality-weighted balance",
  "同一市场里白名单聪明钱在对立结果（如 Yes 与 No）都出现实质净买入——这不是共识，是分歧。按'质量加权额'（净买入 × 评分权重）称双方分量，倾斜分档为一边倒 / 势均力敌。同时在两边都净买入的钱包按对冲/做市剔除（见'对冲嫌疑'）。只读事实，不构成投资建议。分歧市场会从共识列表中剔除——同一市场只会归入共识或分歧其一，两者互斥。":
    "Whitelist smart money shows substantial net buys on opposing outcomes (e.g. Yes and No) of the same market — not consensus but disagreement. Both sides are weighed by 'quality-weighted amount' (net buy × score weight), and the tilt is bucketed as lopsided / balanced. Wallets net-buying both sides at once are dropped as hedging/market making (see 'Hedge suspicion'). Read-only facts — not investment advice. A disagreement market is removed from the consensus list: any one market is classified as either consensus or split, never both — the two are mutually exclusive.",
  // ✅
  结算命中: "Settled hit",
  "结算命中：结算价站在成交价的盈利侧（按盈亏方向判定）":
    "Settled hit: the settlement price landed on the profitable side of the fill price (judged by P&L direction)",
  "该告警对应市场已结算，且按盈亏方向押对：BUY 的结算价高于成交价，SELL 的结算价低于成交价。分数结算的市场（结算价不是 0/1）同样按此口径判定——标准 0/1 结算下等价于'BUY 结算 1 / SELL 结算 0'。":
    "The alert's market has settled and the bet was right by P&L direction: a BUY settled above its fill price, a SELL settled below it. Fractionally settled markets (settlement price other than 0/1) are judged on the same basis — under a standard 0/1 settlement this is equivalent to 'BUY settles at 1 / SELL settles at 0'.",
  // ❌
  结算落空: "Settled miss",
  "结算落空：结算价站在成交价的亏损侧（按盈亏方向判定）":
    "Settled miss: the settlement price landed on the losing side of the fill price (judged by P&L direction)",
  "市场已结算且按盈亏方向押错：BUY 的结算价低于成交价，或 SELL 的结算价高于成交价——BUY@0.9 结算 0.6 每份实亏 0.3，即使 0.6 仍高于 0.5 也记落空。与 ✅ 一起构成告警的最终成绩单。":
    "The market has settled and the bet was wrong by P&L direction: a BUY settled below its fill price, or a SELL settled above it — a BUY@0.9 settling at 0.6 loses 0.3 per share and counts as a miss even though 0.6 is still above 0.5. Together with ✅ it forms the alert's final report card.",
  // ➖
  平局结算: "Push settlement",
  "平局：50/50 结算或结算价≈成交价（±0.5¢ 死区），不计入胜率":
    "Push: a 50/50 settlement, or settlement ≈ fill price (±0.5¢ dead zone) — not counted in the win rate",
  "两种情况记平局：市场按规则以 50/50 结算（赛事取消、平局裁决等，双方按 0.5 退款）；或结算价与成交价之差落在 ±0.5¢ 死区内、盈亏可忽略。都不计入命中率统计的分母。":
    "Two cases count as a push: the market settles 50/50 by rule (event canceled, draw ruling, etc., both sides refunded at 0.5); or the settlement-vs-fill difference falls inside the ±0.5¢ dead zone and the P&L is negligible. Neither enters the hit-rate denominator.",
  // 📐
  信号验证: "Signal validation",
  "信号验证：告警发出后 1h/24h 价格走势与结算回填":
    "Signal validation: 1h/24h price follow-through and settlement backfill after each alert",
  "验证闭环：每条告警（含 🔥 共识，按成员加权买入均价与最后一笔成交时间跟踪）自动回填信号发出后 1 小时 / 24 小时的市场价格变化（按方向着色，±0.5¢ 死区内记平推）与最终结算结果。页面顶部按信号类型（💰大单 / 🏆聪明钱 / 🔥共识）分组汇总 1h/24h 方向命中率和已结算胜率，并附 Wilson 95% 区间——区间与'样本不足'的判定都按【市场数】而非告警条数（见「有效样本量（市场聚类）」），扎堆在同一市场的几十条告警只算一个独立观测。让工具为自己的信号打分。数据按需查询公开历史价格，不依赖归档。":
    'The validation loop: every alert (including 🔥 consensus, tracked by member-weighted average entry price and last-fill time) automatically backfills the market\'s price change 1 hour / 24 hours after the signal (direction-colored; flat within the ±0.5¢ dead zone) and the final settlement result. The top of the page aggregates 1h/24h direction hit rates and settled win rates by signal type (💰 large trades / 🏆 smart money / 🔥 consensus) with a Wilson 95% interval — both the interval and the "small sample" cutoff count MARKETS, not alert rows (see "Effective sample size (market clustering)"), so dozens of alerts piled onto one market count as a single independent observation. Letting the tool grade its own signals. Data is fetched on demand from public price history; no archival required.',
  // ↗
  外部跳转: "External links",
  "外部跳转：tx 列跳 Polygonscan；slug 旁跳 wired.fund 交易页":
    "External links: the tx column jumps to Polygonscan; next to the slug, a jump to the wired.fund trade page",
  "外部跳转链接：tx 列的 ↗ 跳转 Polygonscan 查看该笔成交的链上交易哈希；市场副标题行 ⧉ 旁的 ↗ 用 market slug 跳转 wired.fund 的交易页（onchain-dev.wired.fund/polymarket/trade-slug）。悬停可见完整目标。":
    "External jump links: the ↗ in the tx column opens Polygonscan to inspect the fill's on-chain transaction hash; the ↗ next to ⧉ on the market subtitle row uses the market slug to open the wired.fund trade page (onchain-dev.wired.fund/polymarket/trade-slug). Hover to see the full target.",
  // ⧉ (名称「复制 market slug」已在 common 分片)
  "复制该盘口的 market slug 到剪贴板":
    "Copy this market's slug to the clipboard",
  "把该盘口（单个 market）的 slug 复制到剪贴板，如 strait-of-hormuz-traffic-returns-to-normal-by-end-of-june —— 即 gamma /markets?slug= 的查询键，精确定位这一个盘口。注意与事件 slug 的区别：多盘口事件下每个盘口有自己的 market slug（如 …-2026-07-02-che），事件 slug 则指向整个比赛页。复制成功会短暂显示 ✓。":
    "Copies the slug of this market (a single market) to the clipboard, e.g. strait-of-hormuz-traffic-returns-to-normal-by-end-of-june — the query key for gamma /markets?slug=, pinpointing exactly this market. Note the difference from an event slug: under a multi-market event each market has its own market slug (e.g. …-2026-07-02-che), while the event slug points to the whole game page. A brief ✓ confirms the copy.",
  // …
  加载中: "Loading",
  "数据加载中：按需查询上游并缓存，稍候自动补全":
    "Data loading: fetched on demand from upstream and cached — fills in automatically in a moment",
  "该字段正在惰性加载：战绩、地址年龄等数据按需查询 Polymarket 公开 API 并缓存，首次出现的钱包需要几秒，之后即时。":
    "This field is lazy-loading: track records, address ages and similar data are fetched on demand from Polymarket's public APIs and cached — a wallet's first appearance takes a few seconds, then it is instant.",

  // ------------------------------------------------ TERMS · 名词 / 解释
  // 「战绩」「净买入」「距结算」「跟单空间」词条名沿用先行分片译文,此处只补 detail。
  "钱包在已结算市场上的历史表现：胜率（盈利仓位占比）· 已实现盈亏（USD）。悬停可见已结算市场数与 ROI。统计合并两个来源：已平仓/已赎回仓位（/closed-positions），以及已判定但从未平仓的仓位——尤其是持有到归零的亏损单（输光的仓位没有东西可赎回，链上不会产生任何结算记录，只统计前者会把胜率虚推到 100%）。缓存 24 小时。":
    "A wallet's historical performance on settled markets: win rate (share of profitable positions) · realized PnL (USD). Hover to see the settled-market count and ROI. The statistics merge two sources: closed/redeemed positions (/closed-positions), plus resolved positions that were never closed — above all losers held to zero (a wiped-out position has nothing to redeem, so it leaves no settlement record on chain; counting only the former would inflate the win rate to 100%). Cached for 24 hours.",
  "已实现盈亏 ÷ 成本。成本 = 买入份额 × 平均买入价（注意 Polymarket API 的 totalBought 是份额而非美元）。":
    "Realized PnL ÷ cost. Cost = shares bought × average entry price (note that totalBought in the Polymarket API is shares, not dollars).",
  "按（钱包 · 市场 · 结果）聚合。共识/分歧/拆单/发现渠道的门槛、排序与显示金额统一采用成本敞口口径：留存净股数（买入股数 − 卖出股数）× 买入均价——高买低卖等股对倒后真实仓位为 0，不再被'买入额 − 卖出额'的现金流差伪装成净买入。拆单榜净买入列悬停可见窗口现金流（买入额 − 卖出额）对照。注意口径：拆单榜只统计 ≥ 精度 floor 的成交，低于 floor 的卖出在该精度下不可见——净买入应视为上界（表头'毛卖出(≥floor)'即此意）。":
    "Aggregated per (wallet · market · outcome). Thresholds, ranking and displayed amounts across consensus/split/split-buy/discovery all use a cost-basis-exposure basis: retained net shares (shares bought − shares sold) × average buy price — after a buy-high-sell-low equal-share round trip the true position is 0, no longer masquerading as net buying via the cash-flow difference 'buys − sells'. On the accumulation board, hover the net buy-in column to see the window cash flow (buys − sells) for comparison. Mind the basis: the accumulation board counts only fills ≥ the precision floor, and sells below the floor are invisible at that precision — treat net buy-in as an upper bound (that is what the 'Gross Sell (≥floor)' header means).",
  对冲嫌疑: "Hedge suspicion",
  "拆单榜标记：同一钱包在同一市场的对侧结果也有净买入——两边都买没有方向意图，更像对冲/套利而非定向建仓。二元市场会按 1−价格 把对侧买入折算成本方向的等效卖出并给出折算后净买入；多结果市场只打标记不折算（1−价格 恒等式在 >2 个结果间不成立）。带此标记的组默认沉底。":
    "An accumulation-board flag: the same wallet also net-bought the opposing outcome of the same market — buying both sides carries no directional intent, more hedging/arbitrage than directional accumulation. In binary markets the opposing-side buys are converted at 1−price into equivalent sells on this side and an adjusted net buy-in is shown; multi-outcome markets are only flagged, not converted (the 1−price identity does not hold across >2 outcomes). Groups with this flag sink to the bottom by default.",
  做市嫌疑: "Market-making suspicion",
  "拆单榜标记：组内买卖高频交替（换向率 = 换向次数 ÷ (总笔数−1) > 40%）——更像 taker 做市的库存管理而非定向建仓。换向率只统计 ≥ 精度 floor 的可见单，是真实交替频率的下界。带此标记的组默认沉底。":
    "An accumulation-board flag: buys and sells alternate at high frequency within the group (flip rate = direction changes ÷ (total fills − 1) > 40%) — more like taker market-maker inventory management than directional accumulation. The flip rate counts only visible fills ≥ the precision floor, so it is a lower bound on the true alternation frequency. Groups with this flag sink to the bottom by default.",
  "建仓均价（加权均价）": "Entry price (size-weighted average)",
  "按金额加权的平均买入价，即该仓位的平均赔率。0.5–0.9 区间是内幕资金最偏好的甜区——赔率有利且事件尚未定局。":
    "The size-weighted average buy price — the position's average odds. The 0.5–0.9 band is insider money's favorite sweet spot: favorable odds while the event is still undecided.",
  "占24h量（冲击占比）": "Share of 24h volume (impact ratio)",
  "该笔金额 ÷ 市场 24 小时成交量。$15k 打进日成交 $30k 的冷门市场（50%）远比 $100k 打进大选主市场（<1%）有信息量——衡量'这笔钱对这个市场意味着什么'。":
    "This fill's amount ÷ the market's 24-hour volume. $15k into a niche market trading $30k/day (50%) carries far more information than $100k into the election main market (<1%) — it measures 'what this money means to this market'.",
  流动性: "Liquidity",
  "市场当前的挂单深度（来自 Gamma API），金额相同冲击占比越高越异常。":
    "The market's current order-book depth (from the Gamma API); for the same amount, the higher the impact ratio the more anomalous the fill.",
  "距市场结束时间的剩余小时数。内幕信息的价值随结算临近急剧升值，知情者常在最后几小时突击进场——告警条件里可设'距结算 ≤N 小时'。":
    "Hours left until the market's end time. Insider information appreciates sharply as resolution nears, and the informed often storm in during the final hours — the alert conditions support 'time to resolution ≤N hours'.",
  "现价 − 聪明钱建仓均价。差距 ≤5¢ 显示'仍可跟'（还能以接近聪明钱的成本跟进），更大显示'已跑'（价格已被推走）。市场已结算时改为显示'已结算 ✓ 命中 / ✗ 落空'——即这次共识最终对没对。":
    "Current price − smart money's average entry. A gap ≤5¢ reads 'followable' (you can still get in near smart money's cost); anything larger reads 'gone' (the price has been pushed away). Once the market settles it shows 'settled ✓ hit / ✗ missed' instead — whether this consensus turned out right.",
  "评分（0-100）": "Score (0-100)",
  "聪明钱综合评分：盈利规模最多 40 分（$1m+ 满分）+ 资金效率最多 30 分（优先用已结算 ROI，10%+ 满分，区分真信号与高频做市；无战绩时回退榜单同期 pnl/vol）+ 已结算胜率最多 30 分（胜率 100% 或战绩被截断时按 0.9 保守折价——仅含已结算仓位，死扛型胜率被高估）。可解释、非黑盒。":
    "The composite smart-money score: profit size up to 40 points ($1m+ maxes it) + capital efficiency up to 30 points (settled ROI preferred, 10%+ maxes it — separating real signal from high-frequency market making; falls back to same-period leaderboard pnl/vol when there is no record) + settled win rate up to 30 points (a 100% win rate or a truncated record is conservatively discounted by 0.9 — settled positions only, where hold-to-the-end diehards' win rates read inflated). Explainable — no black box.",
  "共识形成 / 升级": "Consensus formation / escalation",
  "首次凑齐 N 个白名单钱包同向买入为'形成'，之后又有钱包加入为'升级'——只在这两种时刻推送告警；同一共识 6 小时内不重复提醒。":
    "'Formation' is the first time N whitelist wallets line up buying the same direction; 'escalation' is another wallet joining afterwards — alerts fire only at these two moments, and the same consensus is not re-announced within 6 hours.",
  "质量加权（天平）": "Quality weighting (the balance)",
  "分歧天平的秤砣：每笔净买入按钱包评分加权，权重 = 0.2 + 0.8 × 评分/100——顶级评分（100）满权重 1.0，新钱包或无战绩钱包只留 0.2 底权。所以天平反映的是'谁在买'而非单纯'买了多少'：一个高分钱包的 $10k 可以压过一个新钱包的 $20k。双方质量加权额之比即天平的倾斜。":
    "The weights on the disagreement balance: each net buy is weighted by the wallet's score, weight = 0.2 + 0.8 × score/100 — a top score (100) gets full weight 1.0, while a fresh or no-record wallet keeps only the 0.2 floor. The balance therefore reflects 'who is buying', not merely 'how much': a top-scored wallet's $10k can outweigh a fresh wallet's $20k. The ratio of the two sides' quality-weighted amounts is the balance's tilt.",
  "一边倒 / 势均力敌": "Lopsided / Balanced",
  "分歧市场的倾斜分档：占比高的一侧质量加权额 ≥70% 记'一边倒'（表面对立、实为聪明钱压倒性偏向一边）；50%–70% 记'势均力敌'（连聪明钱都真分裂，结果最不确定）。只描述天平事实，不给出跟或不跟的建议。":
    "The tilt buckets for a split market: when the heavier side holds ≥70% of the quality-weighted amount it reads 'lopsided' (opposition on the surface, but smart money overwhelmingly leans one way); 50%–70% reads 'balanced' (even smart money is genuinely divided — the most uncertain outcome). It states the balance as fact and never advises following or skipping.",
  // 词条名「24h 方向命中」已在 alerts 分片。
  "信号发出 24 小时后价格是否朝该方向移动（BUY 后上涨 / SELL 后下跌 = 命中）。变化在 ±0.5¢ 死区内记平推，不计入命中率的分子分母。绿色 = 方向正确，红色 = 方向错误。1h 方向命中口径完全相同，只是标记时点更早。":
    "Whether the price moved the signal's way 24 hours after it fired (up after a BUY / down after a SELL = a hit). Changes inside the ±0.5¢ dead zone count as flat and enter neither numerator nor denominator of the hit rate. Green = right direction, red = wrong direction. The 1h direction hit uses exactly the same basis, just marked earlier.",
  "剔除运气后至少 X%（Wilson 下界）/ 样本不足":
    "At least X% net of luck (Wilson lower bound) / insufficient sample",
  "Telegram 推送里的『剔除运气后至少 X%』= 命中率的 Wilson 95% 置信下界：小样本下表面命中率极不可靠——3/3 显示 100%，剔除运气后其实只能保证约 44%；同样 65% 的表面命中率，26 个样本只能保证 46%，260 个样本能保证 59%。样本越多、下界越接近表面值。宁可把话说小：展示的是有 95% 把握守得住的下限，不是最好看的点估计。看板汇总条的样本量按【市场数】计（见「有效样本量（市场聚类）」），<10 个市场时置灰标'样本不足'（推送按条数 <5 时同理）——40 条告警若全落在 3 个市场上，那就是 3 个样本的估计，不该显示一条紧致的区间。":
    "'At least X% net of luck' in the Telegram pushes = the Wilson 95% confidence lower bound of the hit rate. On small samples the surface hit rate is wildly unreliable — 3/3 reads 100%, yet net of luck only about 44% can be guaranteed; the same 65% surface rate guarantees just 46% on 26 samples but 59% on 260. The more samples, the closer the bound gets to the surface value. Better to understate: what is shown is the floor we are 95% confident of holding, not the prettiest point estimate. The dashboard strip counts its sample in MARKETS (see \"Effective sample size (market clustering)\") and grays out as 'insufficient sample' below 10 markets (pushes do the same below 5 rows) — 40 alerts all landing on 3 markets is a 3-sample estimate and has no business showing a tight interval.",
  "有效样本量（市场聚类）": "Effective sample size (market clustering)",
  "命中率的 95% 区间按【市场数】而非【告警条数】计算：同一市场的每条告警共享该市场唯一的结算结果，它们是一次随机事件的 N 份副本，不是 N 个独立观测。本项目历史库实测：3852 条已结算告警只落在 669 个市场上，单个市场最多 201 条（一场球赛的大额单），按条数算会把误差低估约 1.9 倍，且多个分组结论的正负号会被少数扎堆市场直接带反。点估计（发了多少条 · 对了多少条）仍按告警计——那是一句真话；只有区间需要校正。聚类键取市场（conditionId）而不含结果方向：二元市场买 Yes 与买 No 的输赢完全互补，当成两个独立观测会凭空翻倍样本量。结算维度上组内相关性恰为 1，有效样本量正好等于市场数；1h/24h 方向维度相关性略低于 1，沿用市场数是刻意保守——区间偏宽只是低估信心，偏窄则是伪造信心。":
    "A hit rate's 95% interval is computed on the number of MARKETS, not the number of alert rows: every alert on one market shares that market's single settlement, making them N copies of one random draw rather than N independent observations. Measured on this project's own history: 3852 settled alerts landed on just 669 markets, with up to 201 on a single market (the big fills on one football match). Counting rows understates the error by roughly 1.9× — and flips the sign of several per-bucket conclusions, because a handful of heavily-alerted markets dominate the naive average. The point estimate (how many fired · how many were right) still counts alerts; that sentence is simply true. Only the interval needs correcting. The clustering key is the market (conditionId) and deliberately excludes the outcome side: in a binary market, buying Yes and buying No settle in exact opposition, so treating them as two independent observations would double the sample out of thin air. For the settled win rate the within-market correlation is exactly 1, so the effective sample size equals the market count precisely; for the 1h/24h direction marks it is slightly below 1, and reusing the market count there is deliberately conservative — too wide an interval merely understates confidence, while too narrow a one manufactures it.",
  内幕猎杀组合: "Insider-hunt combo",
  "价格 0.5–0.9 + 地址年龄 ≤7 天的筛选组合（可再叠加距结算 ≤N 小时）：异常内幕资金倾向于用新钱包、在有利赔率、临近结算时买入——三个条件叠加能把成交洪流收敛成一张嫌疑名单。":
    "The filter combo of price 0.5–0.9 + address age ≤7 days (optionally stacked with time to resolution ≤N hours): abnormal insider money tends to buy with fresh wallets, at favorable odds, close to settlement — stacking the three conditions collapses the trade firehose into a short suspect list.",
  // 词条名「PUSD 现金余额」已在 wallet 分片。
  "PUSD 是 Polymarket 的美元抵押代币（充值经 CollateralOnramp 铸造，1 PUSD ≈ $1）。钱包档案页显示的余额是该地址链上实时的 PUSD 持有量，即账户内尚未下注的可用现金——余额大说明弹药充足，随时可能继续加仓。":
    "PUSD is Polymarket's dollar-collateral token (minted via CollateralOnramp on deposit, 1 PUSD ≈ $1). The balance on the wallet dossier is the address's live on-chain PUSD holding — the account's available cash not yet wagered. A large balance means plenty of ammunition, ready to add at any moment.",
  "类型（市场类别）": "Type (market category)",
  "来自 Polymarket 事件标签的市场大类（体育/政治/加密/经济等），扫描器可按类型筛选。标签取事件 tags 中的主类别标签；没有可识别标签的归入'其他'。":
    "The market's top-level category from Polymarket event tags (sports/politics/crypto/economy etc.); the scanner can filter by type. The label takes the main category tag from the event's tags; markets with no recognizable tag fall under 'Other'.",
  "信号密度（条/$1M）/ 新证据": "Signal density (alerts/$1M) / new evidence",
  "发现页的 14 天趋势表，覆盖两个信号面：左侧列跟踪共识信号引擎——每日共识推送数 ÷ 当日平均 6 小时窗口成交量（按 $1M 归一）；『新证据』列跟踪发现渠道——四条渠道（共识同行/拆单建仓/内幕签名/早期赢家）当日首次入账的候选证据行数。所有共识/拆单阈值（2 钱包 / $5k / 6h …）都隐含『当前成交量水位』假设——预测市场热度是周期性的，大盘量退潮后要么信号荒（共识永不成组）要么被迫降阈值引入噪声。密度随热度同跌 = 市场自身降温；热度稳定而密度独跌 = 阈值漂移需要重校。注意窗口每 5 分钟滚动、彼此重叠，成交量不能跨轮求和，取当日平均窗口量作为热度代理。":
    "The discovery page's 14-day trend table, covering two signal surfaces. The left columns track the consensus signal engine — daily consensus pushes ÷ that day's average 6-hour-window volume (normalized per $1M). The 'new evidence' column tracks the discovery channels — candidate evidence rows first recorded that day across the four channels (consensus echo / split-buy entry / insider signature / early winner). Every consensus/split-buy threshold (2 wallets / $5k / 6h …) implicitly assumes 'the current volume level' — prediction-market heat is cyclical, and when overall volume ebbs you get either a signal drought (consensus never forms) or forced threshold cuts that let in noise. Density falling with heat = the market itself cooling; density falling alone while heat holds = threshold drift needing recalibration. Note the windows roll every 5 minutes and overlap, so volume cannot be summed across cycles; the day's average window volume serves as the heat proxy.",
  聪明钱发现渠道: "Smart-money discovery channels",
  "白名单之外的聪明钱来源。官方榜单只按规模（盈利/成交额）排名，会系统性漏掉『有本事但资金不大』的钱包。发现页汇聚四条渠道的候选：🔁 共识同行（与白名单共识同一结果同向净买 ≥$2k）、🧩 拆单建仓（≥3 笔低于 $10k 的拆单净买 ≥$5k 且无对冲/做市嫌疑）、🕵️ 内幕签名（账龄 ≤7 天新地址单笔 ≥$5k 买 0.5–0.9 价带）、🎯 早期赢家（在已结算市场提前 ≥24 小时以 ≤40¢ 买中获胜结果——衡量技能而非规模）。另有 🏅 分类榜专家经每日播种进入准入审查（详见「分类榜专家」词条）。每个标签的完整定义见本页「钱包标签」一节。":
    "Sources of smart money beyond the whitelist. The official leaderboards rank by size (profit/volume) only, so they structurally miss skilled-but-small wallets. The discovery page pools candidates from four channels: 🔁 consensus echo (net-buying ≥$2k of the same outcome, same direction as a whitelist consensus), 🧩 split-buy entry (≥3 sub-$10k split orders netting ≥$5k with no hedge/market-making suspicion), 🕵️ insider signature (an address ≤7 days old with a single ≥$5k buy in the 0.5–0.9 price band), 🎯 early winner (bought the winning outcome of a settled market ≥24 hours before resolution at ≤40¢ — measuring skill, not size). 🏅 category-board specialists additionally enter admission review via daily seeding (see the 'Category-board specialist' entry). Full definitions of every tag are in the 'Wallet tags' section on this page.",
  "分类榜专家（渠道③）": "Category-board specialist (channel ③)",
  "Polymarket 官方排行榜的类别切分维度：sports / politics / crypto / culture / tech / finance 六类（实测有效值），每类按『该类别市场内』的盈利独立排名。它解决全局榜的结构性盲区——全局榜只看总盈利规模，体育大户天然霸榜，其他赛道的专家再准也进不了前 100（实测同一周：politics 分类榜第 1 名盈利 $3.8 万，全局榜第 1 名 $810 万，差 200 多倍）。系统每日抓取每类周榜/月榜前 25 名、只收全局榜之外的钱包。三条纪律：①类内口径警示——分类榜的盈利/成交额只统计该类别市场，与全局榜的全账户口径不同基，两者绝不混算，富化后一律以官方全账户净盈亏为准；②榜尾不是质量保证——实测 culture 周榜第 25 名当周仅赚 $1,899，故分类榜钱包必须通过与发现渠道完全相同的准入战绩审查才能入池（实测约七成被拒）；③入池后 source 记为 category:<类别>，与其他来源同规则：每日重认证、30 天不再合格自动出池。":
    "The category dimension of Polymarket's official leaderboards: six classes — sports / politics / crypto / culture / tech / finance (verified live) — each ranked independently by profit within that category's markets. It fixes the global boards' structural blind spot: the global boards look only at total profit size, sports whales naturally dominate, and specialists in other verticals can never crack the top 100 however accurate they are (verified in the same week: the politics #1 earned $38k while the global #1 earned $8.1M — a 200×+ gap). The system fetches each category's weekly/monthly top 25 daily and takes only wallets absent from the global boards. Three disciplines: ① in-category basis warning — a category board's profit/volume counts only that category's markets, a different base from the global boards' whole-account figures; the two are never mixed, and after enrichment the official whole-account net PnL prevails; ② the board's tail is no quality guarantee — verified: the culture weekly #25 earned just $1,899 that week — so category-board wallets must pass exactly the same admission track-record review as the discovery channels before entering the pool (about seven in ten are rejected in practice); ③ once admitted, source reads category:<category>, under the same rules as every other source: daily re-certification, automatic removal after 30 days of no longer qualifying.",
  准入闸门: "Admission gate",
  "候选进入白名单池的唯一通道，分类榜专家也走同一道质量闸（全局榜的 top-100 本身就是它的门槛，故豁免）。闸门三关：①复发——30 天内证据广度 ≥3（各渠道内去重市场数之和；同一市场被两个渠道独立命中计两次——两种独立行为签名强于一种）；②战绩审查——结算胜率 ≥55% 且 ≥10 个已结算市场，或净盈亏为正、ROI ≥5% 且 ≥5 个已结算市场（刻意不用 0-100 评分做门槛：其利润轴会重新引入渠道要逃离的规模偏置）；③做市机器人（≥1000 市场）硬拒且判定永久生效。入池后与榜单钱包同规则：在池成员每日按战绩重新认证（复发只把守首次入池——入池后探测器不再对其取证），不再合格即停止续期、30 天后自动出池。每个成员的 source 字段记录首发渠道，为后续按渠道评估有效性留好归因。":
    "The only path by which a candidate enters the whitelist pool; category-board specialists pass the same quality gate (the global boards' top-100 is a threshold in itself, hence exempt). Three checks: ① recurrence — evidence breadth ≥3 within 30 days (the sum of deduplicated market counts within each channel; the same market hit independently by two channels counts twice — two independent behavior signatures beat one); ② track-record review — settled win rate ≥55% over ≥10 settled markets, or positive net PnL with ROI ≥5% over ≥5 settled markets (deliberately not the 0-100 score as the bar: its profit axis would re-import the size bias the channels exist to escape); ③ market-maker bots (≥1000 markets) are hard-rejected with a permanent verdict. Once admitted, the same rules as leaderboard wallets apply: pool members are re-certified daily on their track record (recurrence guards first admission only — once in the pool, the detectors stop collecting evidence on them); those no longer qualifying stop being renewed and age out after 30 days. Each member's source field records its first channel, laying the groundwork for scoring channel effectiveness later.",
  颜色语义: "Color semantics",
  "全站统一：绿色 = 买入 / 上涨 / 盈利，红色 = 卖出 / 下跌 / 亏损，琥珀色 = 赔率与警示信息。":
    "Sitewide convention: green = buy / rising / profit, red = sell / falling / loss, amber = odds and warnings.",
  "策略中心（原「纸面跟单」）": "Strategy Center (formerly 'paper following')",
  "不动真金的模拟跟单：只跟 15 分钟内新形成的共识（新鲜度按「形成时刻」锚定，不被后续加仓/卖单续命），以当时现价、按固定 $/信号纸面买入，持有到市场结算才平仓——只结算真实盈亏，期间不计浮盈。⚠️ 「当时现价」是 CLOB 最近成交价快照，非盘口可成交价：买卖价差、盘口深度等执行成本未建模，纸面盈亏相对实盘系统性偏乐观。分歧市场（聪明钱两边都买）不跟——与共识/分歧看板的市场级互斥口径一致。用来诚实检验「跟着共识买」这套策略在本窗口到底赚不赚钱，而无需真的下注。/follow 看板每张策略卡即一组阈值（≥N 钱包 · 每钱包 ≥$X · $Y/信号）的独立纸面战绩。":
    "Paper following with zero real money: it only follows consensus newly formed within 15 minutes (freshness anchored to the 'formation time', never kept alive by later add-ons or sells), buys on paper at the then-current price for a fixed $/signal, and holds to market settlement before closing — only real P&L is settled, no unrealized gains along the way. ⚠️ The 'then-current price' is a CLOB last-trade snapshot, not an executable book price: execution costs such as the bid-ask spread and book depth are unmodeled, so paper P&L is systematically optimistic versus live trading. Split markets (smart money buying both sides) are not followed — consistent with the market-level mutual exclusion on the consensus/split board. It exists to honestly test whether 'buy what the consensus buys' actually makes money in this window, without placing a single bet. On the /follow board each strategy card is the independent paper record of one threshold set (≥N wallets · ≥$X per wallet · $Y/signal).",
  "形成时刻 / 形成价": "Formation time / formation price",
  "形成时刻 = 第 N 个白名单钱包净买入最后一次跨过策略门槛的那一刻——共识从「不成立」变「成立」的瞬间；形成价 = 那一刻的市场价。跟单的新鲜度闸门（15 分钟内新形成才跟）与进场偏离护栏（|进场价 − 形成价| 超阈不跟）都锚定于形成时刻/形成价，不会被后续加仓或卖单「续命」成新鲜。形成价只用于归因展示（延迟成本、markout），绝不参与盈亏计算。":
    "Formation time = the moment the Nth whitelist wallet's net buy last crossed the strategy threshold — the instant the consensus flips from 'not holding' to 'holding'; formation price = the market price at that moment. The follow engine's freshness gate (only follow consensus formed within 15 minutes) and entry-deviation guardrail (skip when |entry price − formation price| exceeds the bound) are both anchored to formation time/price, and later add-ons or sells can never 'revive' it back to fresh. The formation price is used for attribution display only (latency cost, markout) and never enters P&L calculation.",
  延迟成本: "Latency cost",
  "进场价 − 形成价（¢）。买入成本可分解为三段：聪明钱均价 →（信息租金，人家买得早/便宜，拿不到别追）→ 形成价 →（延迟成本）→ 进场价。延迟成本是共识形成后到我们实际进场之间价格的漂移，即系统检测 + 执行延迟造成的、工程上可优化的那一段成本。与「追价成本」（vs 聪明钱均价、含拿不到的信息租金）口径不同：追价成本大而延迟成本小，说明贵在信息租金而非系统慢。老仓位/取价失败无形成价时显示 —，不进均值样本；|¢| 超过进场偏离护栏阈（默认 10¢）时琥珀警示。":
    "Entry price − formation price (¢). Buy-in cost decomposes into three legs: smart-money average → (information rent — they bought earlier/cheaper; unattainable, don't chase it) → formation price → (latency cost) → entry price. Latency cost is the price drift between consensus formation and our actual entry — the leg caused by detection + execution delay, the one engineering can optimize. A different basis from 'chase cost' (vs the smart-money average, information rent included): a big chase cost with a small latency cost means the expense is information rent, not a slow system. Legacy positions / failed price fetches with no formation price show — and stay out of the average; when |¢| exceeds the entry-deviation guardrail (default 10¢) it warns in amber.",
  "追价成本（旧称跟单滑点）": "Chase cost (formerly 'follow slippage')",
  "份额 ×（自己入场价 − 聪明钱建仓均价）。共识形成后我们才现价跟进：入场价高于均价（追高）时为正，是多付出的成本、拖累收益。⚠️ 负值并不等于「买得更便宜」——当入场价远低于聪明钱均价，往往是行情在其建仓后已大幅反向、共识论点可能已被推翻（接飞刀），务必结合「已实现盈亏」一起看。入场价越低份额越膨胀，美元绝对值可能超过本金，因此更宜看「¢ 差」而非美元金额——看板即按 ¢ 差主显示，美元值退居次要。⚠️ 它也不是交易执行意义上的「滑点」：纸面入场价取自 CLOB 最近价格点（约 10 分钟颗粒的成交价快照），按快照成交、不吃盘口——买卖价差、盘口深度、快照滞后等执行成本完全未计入，纸面盈亏因此相对实盘系统性偏乐观（共识盘 $500 单约 1¢/仓 量级；in-play 体育/薄盘可能更大）。注意口径：追价成本 vs 聪明钱均价，含拿不到的信息租金；系统可优化的部分见「延迟成本」（vs 形成价）。策略默认带 10¢ 进场偏离护栏：现价偏离形成价超阈直接不跟（形成价缺失时回退聪明钱均价基准），宁可错过也不追高 / 接飞刀。累计追价成本把每一仓（含持仓中）的差价加总。":
    "Shares × (our entry price − smart money's average entry). We only follow at the current price after consensus forms: positive when our entry is above the average (chasing high) — extra cost paid, a drag on returns. ⚠️ A negative value does NOT mean 'bought cheaper' — an entry far below the smart-money average usually means the price has reversed hard since they built the position and the consensus thesis may already be broken (catching a falling knife); always read it together with realized PnL. The lower the entry price, the more the share count balloons, so the dollar absolute value can exceed the principal — better to read the '¢ gap' than the dollar figure, and the board leads with the ¢ gap, dollars secondary. ⚠️ Nor is it 'slippage' in the execution sense: the paper entry price comes from the CLOB's latest price point (a fill-price snapshot at roughly 10-minute granularity), executed at the snapshot without eating the book — the bid-ask spread, book depth and snapshot lag are entirely uncounted, so paper P&L is systematically optimistic versus live trading (on the order of ~1¢/position for $500 consensus fills; potentially more for in-play sports / thin books). Mind the basis: chase cost is vs the smart-money average and includes the unattainable information rent; for the part engineering can optimize see 'Latency cost' (vs the formation price). Strategies ship with a 10¢ entry-deviation guardrail by default: when the current price deviates from the formation price beyond the bound, the signal is simply skipped (falling back to the smart-money-average baseline when the formation price is missing) — better to miss than to chase high / catch the knife. Cumulative chase cost sums the gap across every position, open ones included.",
  "协议费（taker fee）": "Protocol fee (taker fee)",
  "Polymarket 向吃单方收取的协议手续费。⚠️ 本项目早期把「Polymarket 零手续费」当作既定事实，2026-08-04 实测推翻：按 24h 量降序取头部 100 个开放市场，72 个 feesEnabled=true、合计占 24h 总成交量的 57.8%，且横跨 7 个品类（体育 / 政治 / 加密 / 天气 / 文化 / 经济 / 金融），不是只有体育收。公式 fee = 份额 × rate × p ×(1−p)，实测 rate 在 0.04–0.07 之间、exponent 恒为 1、takerOnly。⚠️ 反直觉的一点：p×(1−p) 在 0.5 处最大，但那是「每股」的形状；对固定金额的买单，份额 = 金额 ÷ p 会随 p 变小而膨胀，两个效应合并后 fee = 金额 × rate ×(1−p)，随成交价单调递减——$500 在 0.2 要 $20（名义额 4%），在 0.5 只要 $12.5（2.5%），在 0.9 只要 $2.5（0.5%）。冷门票才是相对最贵的那一批。跟单引擎恒为吃单方，故必然计费。这一项通常远大于盘口执行滑点（实测同一笔 $500 单：盘口滑点 $0.00、协议费约 2.5%），是执行成本里最大的一项。口径纪律：费用只在开仓收一次（结算是赎回、不是成交，不再收费）；未知一律留白而不是显示 $0（收费但费率表拿不到、或 exponent 不是 1 的未观测形态）；费率表是当前值而非成交时刻值，因此老仓不回填，看板用 n= 如实标注覆盖率。":
    "The protocol fee Polymarket charges the taker side. ⚠️ This project once took 'Polymarket has zero fees' as established fact; live testing on 2026-08-04 overturned it: of the top 100 open markets by 24h volume, 72 had feesEnabled=true, together 57.8% of total 24h volume, spanning 7 categories (sports / politics / crypto / weather / culture / economy / finance) — it is not just sports. Formula: fee = shares × rate × p × (1−p); measured rate ranges 0.04–0.07, exponent is always 1, takerOnly. ⚠️ The counterintuitive part: p × (1−p) peaks at 0.5, but that is the per-share shape; for a fixed-dollar buy, shares = amount ÷ p balloon as p falls, and the two effects combine into fee = amount × rate × (1−p), monotonically decreasing in the fill price — $500 costs $20 at 0.2 (4% of notional), only $12.5 at 0.5 (2.5%), and $2.5 at 0.9 (0.5%). Longshot tickets are the relatively most expensive batch. The follow engine is always the taker, so the fee always applies. This item usually dwarfs order-book execution slippage (measured on the same $500 order: book slippage $0.00, protocol fee ~2.5%) — the largest piece of execution cost. Basis discipline: the fee is charged once at open only (settlement is redemption, not a trade — no second charge); unknowns are left blank rather than shown as $0 (fee-enabled but rate table unavailable, or unobserved shapes where the exponent is not 1); the rate table holds current values, not at-fill values, so old positions are not backfilled and the board labels coverage honestly with n=.",
  "三档口径（纸面 / 含追价成本 / 含协议费）":
    "Three bases (paper / after chase cost / after protocol fee)",
  "跟单战绩同时给出三个数，因为它们回答三个不同的问题。① 纸面：只按报价快照成交算的已实现盈亏，回答「这个信号选对方向了吗」。② 含追价成本：再减去份额 ×（入场价 − 聪明钱均价），回答「等我们能跟的时候，还剩多少空间」。③ 含协议费：再减去开仓时的协议 taker 费，是三档里最接近实盘的一档。为什么不直接把费用并进已实现盈亏：费率表只能拿到当前值，历史仓无法精确回填，硬并进去会静默重写已经对外发布过的数字，且此后再也分不清亏损来自判断错误还是执行成本。所以账本口径不变、费用单列，读者自己看得见每一层吃掉了多少。第三档的口径范围要特别注意：三项（已实现盈亏 / 追价成本 / 协议费）都**只在「协议费已知」的那批已结算仓上计算**，页面同时标出「覆盖 n/m 仓」。为什么不用全量：协议费自 2026-08 起才采集且老仓不回填，若规定「有一个未知就整档留白」，这个指标会因为历史仓的存在而永远不亮；而拿部分覆盖的费用去减全量盈亏，又会得到一个介于两档之间、无法解释的数。限定同一子集后三项口径一致、数字自洽，且随着老仓陆续结算完毕会自然收敛到全量。同理，看板顶部那个「累计追价成本」覆盖全部仓位（含持仓中），与这一档用的口径不同——追价成本在进场即产生，但只有已结算的那部分才该与已实现盈亏相减。":
    "The follow record shows three numbers at once because they answer three different questions. ① Paper: realized P&L executed purely at quote snapshots — answers 'did this signal pick the right direction'. ② After chase cost: further subtracts shares × (entry price − smart-money average) — answers 'how much room is left by the time we can follow'. ③ After protocol fee: further subtracts the taker fee charged at open — the closest of the three to live trading. Why not fold the fee straight into realized P&L: the rate table only offers current values, history cannot be backfilled precisely, folding it in would silently rewrite numbers already published — and afterwards you could never tell whether a loss came from bad judgment or execution cost. So the ledger basis stays put and fees are listed separately; readers see exactly what each layer ate. Mind the third tier's scope: all three items (realized P&L / chase cost / protocol fee) are computed **only over the settled positions whose protocol fee is known**, and the page labels 'covering n/m positions' alongside. Why not the full set: protocol fees have only been collected since 2026-08 and old positions are not backfilled; a rule of 'blank the whole tier if anything is unknown' would keep this metric dark forever because history exists, while netting partially covered fees against full-set P&L yields an unexplainable number sitting between two bases. Restricted to one subset, the three items share one basis, the numbers are self-consistent, and as old positions finish settling it naturally converges to the full set. Likewise, the 'cumulative chase cost' at the top of the board covers every position (open ones included) — a different basis from this tier: chase cost is incurred at entry, but only the settled part should be netted against realized P&L.",
  "峰值占用 / 平均年化": "Peak capital usage / average annualized",
  "峰值占用 = 历史上任一时刻同时持有仓位的本金峰值（扫描线口径：开仓 +$、结算 −$，同一时刻先入后出，持仓中的仓占用至结算才释放）——即照此策略实盘「恰好每笔都接住」所需的最小本金。平均年化 =（结算净值 ÷ 峰值占用）×（365 ÷ 运行天数），把策略当一只小基金、自成立日（含无信号空窗）折算年化。⚠️ 运行天数很短时年化会被极度放大，只宜横向对比、不可外推；无结算仓或运行不足 1 天显示 —。峰值/年化只做展示归因，不参与开仓与结算。":
    "Peak capital usage = the historical peak of principal held in open positions at any one moment (sweep-line basis: open +$, settle −$; at the same instant entries before exits; an open position occupies capital until settlement releases it) — the minimum bankroll needed to 'catch every single signal' running this strategy live. Average annualized = (settled net P&L ÷ peak usage) × (365 ÷ days running), treating the strategy as a small fund annualized from inception (signal-free gaps included). ⚠️ With very few days running the annualized figure gets wildly inflated — for side-by-side comparison only, never extrapolation; with no settled positions or under 1 day running it shows —. Peak/annualized are display attribution only and never join opening or settlement.",
  执行滑点: "Execution slippage",
  "真实执行成本的实测估计——补上买入成本分解的最后一段：聪明钱均价 →（信息租金）→ 形成价 →（延迟成本）→ 报价入场 →（执行滑点）→ 可执行成交价。做法：开仓瞬间抓 CLOB 订单簿快照，按本仓名义金额（$/信号）从最优卖价逐档模拟市价吃单，得到模拟成交均价；执行滑点 = 模拟成交均价 − 报价入场价（¢），含跨买卖价差与吃穿深度两部分。盘口深度吃不满名义金额时按已成交部分计并琥珀标「薄」（薄盘警示）。⚠️ 仍是估计而非真实成交：快照与真实下单之间有时差，他人抢单/撤单不可见；且订单簿只有当下、没有历史，故仅执行层上线后的新开仓有值，历史仓位显示 —。红线：仅归因展示，不参与开仓判定与盈亏计算（纸面盈亏口径不变，仍按报价快照）。":
    "A measured estimate of true execution cost — the final leg of the buy-in cost decomposition: smart-money average → (information rent) → formation price → (latency cost) → quoted entry → (execution slippage) → executable fill price. Method: at the instant of opening, grab a CLOB order-book snapshot and simulate a market-order sweep of this position's notional ($/signal) down the levels from the best ask, yielding a simulated average fill; execution slippage = simulated average fill − quoted entry price (¢), covering both crossing the bid-ask spread and eating through depth. When book depth cannot absorb the full notional, it is computed over the filled portion and amber-tagged 'thin' (thin-book warning). ⚠️ Still an estimate, not a real fill: there is a time gap between snapshot and an actual order, and others' order-sniping/cancellations are invisible; and the order book exists only in the present with no history, so only positions opened after the execution layer went live have values — historical positions show —. Red line: attribution display only; it never joins the entry decision or P&L calculation (the paper-P&L basis is unchanged, still the quote snapshot).",
  "账户推演 / 建议跟单额度": "Account replay / suggested follow bankroll",
  "回答「跟这条策略该在账户里备多少钱」（Polymarket 无杠杆，保证金实质 = 账户备付现金）。因为每仓固定 $/信号且仓位互相独立，「若账户只备 $X」可以对历史做精确反事实回放：按开仓顺序重演，资金不够就错过该信号、结算即释放资金——错过哪几仓、少赚/少亏多少是精确值而非估计。推演表列出 0.25/0.5/0.75/1/1.25 × 峰值五档的接住·错过/落袋/年化/效率，取舍（少备钱=踩不满信号 vs 多备钱=闲置拖累）一目了然。建议跟单额度 = 历史峰值占用（恰好接住全部信号的最小资金）× 1.25 冗余、按单仓金额向上取整——冗余吸收未来峰值抬升，但仍是历史窗口口径、非承诺。使用效率 = 时间加权平均占用 ÷ 账户额（含零仓闲置期）——衡量账上的钱有多大比例真的在干活。":
    "Answers 'how much money should the account hold to follow this strategy' (Polymarket has no leverage; margin is effectively the account's standby cash). Because every position is a fixed $/signal and positions are independent, 'what if the account held only $X' can be replayed against history as an exact counterfactual: replay in opening order, a signal is missed when funds run short, settlement releases funds — which positions were missed and how much less was won/lost are exact values, not estimates. The replay table lists five tiers at 0.25/0.5/0.75/1/1.25 × peak with caught·missed / banked / annualized / efficiency, laying the trade-off bare (less cash = missing signals vs more cash = idle drag). Suggested follow bankroll = historical peak usage (the minimum that catches every signal) × 1.25 headroom, rounded up to whole per-position amounts — the headroom absorbs future peak rises, but it remains a historical-window figure, not a promise. Utilization = time-weighted average usage ÷ account size (idle zero-position periods included) — how much of the money on the account is actually working.",
  净值曲线: "Equity curve",
  "某策略已结算仓位按结算时间累计的已实现盈亏走势，画成阶梯折线——每结算一仓就抬升或下探一格。多策略叠加时用实线 / 虚线区分而非颜色（避免与绿涨红跌语义打架）。只画已结算点，不含持仓中的浮盈，反映的是真正落袋的钱。":
    "A strategy's cumulative realized P&L over its settled positions, ordered by settlement time and drawn as a step line — each settlement steps it up or down one notch. Overlaid strategies are told apart by solid/dashed lines rather than color (avoiding a clash with the green-up/red-down semantics). Only settled points are drawn — no unrealized gains from open positions; it shows money genuinely banked.",
  最大回撤: "Max drawdown",
  "净值曲线从某一峰值回落到后续谷底的最大跌幅（峰值 − 谷底，单位美元）。衡量策略中途最难熬的一段亏损，回撤越小越平稳。只在真实结算点之间计算，不引入隐性 0 起点。":
    "The equity curve's largest fall from a peak to a later trough (peak − trough, in dollars). It measures the strategy's most painful losing stretch along the way — the smaller the drawdown, the smoother the ride. Computed only between real settlement points, with no implicit 0 starting point.",

  // -------------------------------------- WALLET_TAGS · kind / 名称 / tip / 定义
  // kind「状态」已在 discovery 分片(候选漏斗状态列)。
  来源: "Source",
  渠道证据: "Channel evidence",
  // 🤖 bot(名称「做市机器人」已在 discovery 分片)
  "交易过 ≥1000 个不同市场的高频做市账户——赚价差不赌方向，胜率无意义":
    "A high-frequency market-making account that has traded ≥1000 distinct markets — earns the spread, doesn't bet direction; win rate is meaningless",
  "该地址交易过 ≥1,000 个不同市场（实测人群断层：方向性交易者 2–192 个市场，机器人 1,077 起跳，中间是空档，误判几乎不可能）。做市商赚的是买卖价差而非方向判断，胜率既算不动也无意义，系统对其停算胜率、准入闸门直接硬拒且判定永久生效（交易市场数只增不减）。":
    "This address has traded ≥1,000 distinct markets (a measured population gap: directional traders span 2–192 markets while bots start at 1,077, with a void in between — misclassification is all but impossible). Market makers earn the bid-ask spread, not directional judgment, so a win rate is both uncomputable and meaningless: the system stops computing it for them, and the admission gate hard-rejects them with a permanent verdict (a wallet's market count only ever grows).",
  // 🏆 whitelist
  手动白名单: "Manual whitelist",
  "人工钉住的钱包——重播种不覆盖、永不过期":
    "A manually pinned wallet — reseeding never overwrites it, and it never expires",
  "人工标记的白名单成员。与自动入池的钱包不同：每日重播种不会覆盖该标记，30 天老化清扫也永远不会移除它。":
    "A manually flagged whitelist member. Unlike auto-admitted wallets, the daily reseeding never overwrites the flag and the 30-day aging sweep never removes it.",
  // 🏛 src:leaderboard(名称「全局榜」已在 discovery 分片)
  "来自官方全局盈利榜（周/月/全期前 100）":
    "From the official global profit leaderboards (weekly/monthly/all-time top 100)",
  "该钱包由 Polymarket 官方全局盈利排行榜播种入池：每日抓取周榜/月榜/全期榜各前 100 名合并（同钱包保留最佳盈利板的成对数字）。全局榜前 100 本身就是门槛，故此来源不再过准入战绩审查。注意榜单盈利是含未实现浮盈的 mark-to-market 口径。":
    "This wallet was seeded into the pool from Polymarket's official global profit leaderboards: the weekly/monthly/all-time top 100 are fetched daily and merged (a wallet keeps the paired figures from its most profitable board). The global top 100 is a threshold in itself, so this source skips the admission track-record review. Note that leaderboard profit is a mark-to-market figure including unrealized gains.",
  // 🏅 src:category:
  分类榜专家: "Category-board specialist",
  "称霸某个垂类榜（体育/政治/加密/文娱/科技/金融）但进不了全局榜前 100 的赛道专家":
    "A vertical specialist who dominates one category board (sports/politics/crypto/culture/tech/finance) but never cracks the global top 100",
  "Polymarket 官方排行榜有按类别切分的维度（sports / politics / crypto / culture / tech / finance 六类，实测有效），按『该类别市场内』的盈利排名。全局榜只看总盈利规模——体育大户天然霸榜，其他赛道的专家再准也挤不进前 100（实测同一周：politics 分类榜第 1 名盈利 $3.8 万，全局榜第 1 名 $810 万）。渠道③每日抓取每类周榜/月榜前 25 名，只收全局榜之外的钱包，来源记为 category:<类别>。两个关键限定：①分类榜的盈利/成交额是类内口径（只统计该类别市场），与全局榜的全账户口径不同基，故富化后以全账户净盈亏为准；②分类榜排名本身不是质量保证（实测 culture 周榜第 25 名当周仅赚 $1,899）——分类榜钱包必须通过与发现渠道相同的准入战绩审查（见「准入闸门」）才能入池，实测约七成被闸门拒掉。":
    "Polymarket's official leaderboards carry a category dimension (six classes: sports / politics / crypto / culture / tech / finance, verified live), ranked by profit within that category's markets. The global boards look only at total profit size — sports whales naturally dominate, and specialists in other verticals can never squeeze into the top 100 however accurate they are (verified in the same week: the politics #1 earned $38k vs the global #1's $8.1M). Channel ③ fetches each category's weekly/monthly top 25 daily, takes only wallets absent from the global boards, and records the source as category:<category>. Two key caveats: ① a category board's profit/volume is an in-category basis (that category's markets only), a different base from the global boards' whole-account figures, so after enrichment the whole-account net PnL prevails; ② a category-board rank is no quality guarantee in itself (verified: the culture weekly #25 earned just $1,899 that week) — category-board wallets must pass the same admission track-record review as the discovery channels (see 'Admission gate') before entering the pool; in practice about seven in ten are rejected by the gate.",
  // 🔭 src:discovered:
  发现入池: "Discovered",
  "经发现渠道积累证据、通过准入闸门全流程入池的钱包（后缀=首发渠道）":
    "A wallet that accumulated evidence through the discovery channels and passed the full admission gate into the pool (suffix = first channel)",
  "该钱包不是来自任何榜单，而是被发现渠道从成交流/已结算市场中挖出：30 天内在 ≥3 个不同市场留下行为证据（复发），经战绩富化审查（结算胜率 ≥55% 且 ≥10 结算，或净盈亏为正且 ROI ≥5% 且 ≥5 结算），做市机器人硬拒后入池。标签后缀是首发渠道（如『发现入池·拆单建仓』）——记录哪条渠道最先发现它，是后续按渠道评估有效性的归因依据。在池期间每日按战绩重新认证，不再合格即停止续期、30 天后自动出池。":
    "This wallet came from no leaderboard — the discovery channels dug it out of the trade firehose / settled markets: behavior evidence in ≥3 distinct markets within 30 days (recurrence), an enrichment track-record review (settled win rate ≥55% over ≥10 settlements, or positive net PnL with ROI ≥5% over ≥5 settlements), market-maker bots hard-rejected, then admitted. The tag suffix is the first discovery channel (e.g. 'Discovered · split-buy entry') — recording which channel found it first, the attribution basis for scoring channel effectiveness later. While in the pool it is re-certified daily on its track record; once it stops qualifying, renewal stops and it ages out after 30 days.",
  // 🔁 ch:echo(渠道名「共识同行」已在 discovery 分片)
  "在白名单共识形成的同一（市场·结果）上同向净买 ≥$2k 的池外钱包":
    "A non-pool wallet net-buying ≥$2k of the same (market · outcome), same direction, where a whitelist consensus formed",
  "渠道①子信号：当 ≥2 个白名单钱包形成共识时，该池外钱包也在同一（市场·结果）上同向净买 ≥$2,000（净额=买入−卖出；同市场净买两个对立结果的对冲者剔除；≥95¢ 的近确定性买入不计——那是资金停车不是观点）。×N 表示 30 天内在 N 个不同市场留下此类证据。":
    "A channel-① sub-signal: while ≥2 whitelist wallets were forming a consensus, this non-pool wallet also net-bought ≥$2,000 of the same (market · outcome) in the same direction (net = buys − sells; hedgers net-buying both opposing outcomes of one market are dropped; near-certainty buys at ≥95¢ don't count — that is parked money, not a view). ×N means such evidence in N distinct markets within 30 days.",
  // 🧩 ch:splitter(渠道名「拆单建仓」已在 discovery 分片)
  "用 ≥3 笔低于 $10k 的小单拆着建仓、净买 ≥$5k 的池外钱包":
    "A non-pool wallet building a position in ≥3 sub-$10k split orders, netting ≥$5k",
  "行为标签，池内外通用：钱包在同一（市场·结果）上用 ≥3 笔每笔低于 $10,000 的订单累积净买入 ≥$5,000——刻意躲开单笔大额监控的建仓方式。有对冲嫌疑（同市场买对立面）或做市嫌疑（买卖高频翻转）的组不算；≥95¢ 的近确定性买入不算。对池外钱包它是候选证据（进发现漏斗），对池内成员它只是行为标注（不触发任何准入流程）。×N 表示 30 天内在 N 个不同市场留下此类证据。":
    "A behavior tag, applied inside and outside the pool alike: the wallet accumulated ≥$5,000 net buy-in on one (market · outcome) through ≥3 orders each below $10,000 — position building that deliberately dodges single-fill large-trade monitoring. Groups with hedge suspicion (buying the opposite side of the same market) or market-making suspicion (high-frequency buy-sell flipping) don't count; nor do near-certainty buys at ≥95¢. For a non-pool wallet it is candidate evidence (feeding the discovery funnel); for a pool member it is a behavior annotation only (triggering no admission flow). ×N means such evidence in N distinct markets within 30 days.",
  // 🕵️ ch:insider(渠道名「内幕签名」已在 discovery 分片)
  "账龄 ≤7 天的新地址单笔 ≥$5k 买入 0.5–0.9 价带":
    "An address ≤7 days old making a single ≥$5k buy in the 0.5–0.9 price band",
  "渠道①子信号：注册不足 7 天的新地址，单笔 ≥$5,000 买入 0.5–0.9 价带（有利赔率）——『内幕猎杀组合』的自动化版本：异常内幕资金倾向用新钱包、在有利赔率果断下注。×N 表示 30 天内在 N 个不同市场命中此签名。":
    "A channel-① sub-signal: a fresh address under 7 days old makes a single ≥$5,000 buy in the 0.5–0.9 price band (favorable odds) — the automated version of the 'insider-hunt combo': abnormal insider money tends to bet decisively with fresh wallets at favorable odds. ×N means this signature hit in N distinct markets within 30 days.",
  // 🎯 ch:early_winner(渠道名「早期赢家」已在 discovery 分片)
  "在已结算市场提前 ≥24 小时以 ≤40¢ 买中获胜结果——衡量技能而非规模":
    "Bought the winning outcome of a settled market ≥24 hours early at ≤40¢ — measuring skill, not size",
  "行为标签，池内外通用：回溯刚结算的市场（成交量 ≥$1 万、生命周期 ≥24 小时），找出在结算前 ≥24 小时就以 ≤40¢ 买入获胜结果、累计 ≥$500 的钱包——当时市场认为不足四成概率的事，TA 提前一天以上重仓买对了。24 小时提前量排除盘中价格摆动和临场狙击（后者归内幕签名管）；两边都买的排除。对池外钱包它是候选证据，对池内成员它是最有分量的技能标注。×N 表示在 N 个已结算市场留下此战绩。":
    "A behavior tag, applied inside and outside the pool alike: sweeping freshly settled markets (volume ≥$10k, lifetime ≥24 hours) for wallets that bought the winning outcome at ≤40¢, ≥24 hours before resolution, for ≥$500 cumulative — something the market then priced below a 40% chance, and they bought it right more than a day ahead, in size. The 24-hour lead excludes intraday price swings and last-minute sniping (the latter belongs to the insider signature); both-sides buyers are excluded. For a non-pool wallet it is candidate evidence; for a pool member it is the weightiest skill annotation. ×N means this record in N settled markets.",
  // ⏳ status:candidate
  "候选中（状态）": "Candidate (status)",
  "池外钱包，已有渠道证据但尚未通过准入——复发不足或战绩未达标":
    "A non-pool wallet with channel evidence that has not yet passed admission — recurrence short or track record below the bar",
  "候选漏斗状态列：该钱包在池外、已在发现渠道留下证据，但尚未入池——或 30 天证据广度不足 3，或战绩审查未通过（每天会用最新战绩重评一次）。候选身份不影响任何下游信号。候选一旦通过准入即从候选漏斗移入白名单池 tab（其渠道证据标签随行显示），不再在漏斗中重复出现。":
    "The candidate funnel's status column: this wallet is outside the pool with evidence on the discovery channels but not yet admitted — either 30-day evidence breadth below 3, or the track-record review not yet passed (re-evaluated daily with the latest record). Candidacy affects no downstream signal. Once a candidate passes admission it moves from the candidate funnel into the whitelist-pool tab (its channel-evidence tags riding along) and never reappears in the funnel.",

  // ------------------------------ lib/walletTags 派生 label(chips 显示端拆译)
  // 状态/来源两类底文(🏆 手动白名单 · 🤖 做市机器人 · 🏛 全局榜 ·
  // 池成员·来源未知 · 6 类 🏅 分类榜·<cat> · 4 渠道 🔭 发现入池·<ch>)由
  // discovery 分片登记,此处只补它没有的渠道证据底文 —— 渠道 chip 的
  // label 带语言中立的 ×N 数量后缀(🔁 共识同行 ×3),显示端摘掉后缀再查
  // 这四个键(见 app/walletTagChips.tsx),故键里不含 ×N。英文用词与
  // discovery 分片的渠道名保持一致。
  "🔁 共识同行": "🔁 Consensus echo",
  "🧩 拆单建仓": "🧩 Split-buy entry",
  "🕵️ 内幕签名": "🕵️ Insider signature",
  "🎯 早期赢家": "🎯 Early winner",
};
