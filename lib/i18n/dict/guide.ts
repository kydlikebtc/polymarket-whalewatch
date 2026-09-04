// /guide 功能说明书分片 —— 键=中文原文,值=英文译文。
// 数据源是 app/guide.ts(中文唯一源);本分片完整性由 app/guide.test.ts
// 的机器闸保证(数据层每段中文必须在合并字典有键)。板块 title(24h 扫描/
// 拆单累计/…)复用各页分片的既有键,不在此重复(同键同值纪律)。
export const DICT_GUIDE: Record<string, string> = {
  // -------- 页面骨架
  功能说明书: "Feature guide",
  目录: "Contents",
  // Etherscan 风版式(设计稿 16):页头小标 + 一句话描述 + 计数钮 + 左侧锚点轨。
  // 克制表达(2026-09-04):页头描述只留「这页是什么」,方法论那半句删;末尾
  // 那条自述版式的脚注整条删 —— 随之零引用的键一并删掉,不留死键。
  "板块级说明 · 名词级见「说明」":
    "Section-level guide · term-level lives in Glossary",
  "每个板块三件事：这是什么、怎么使用、怎么解读。":
    "Three things per section: what it is, how to use it, how to read it.",
  "共 {n} 节": "{n} sections",
  锚点目录: "On this page",
  这是什么: "What it is",
  怎么使用: "How to use",
  怎么解读: "How to read",
  "打开 →": "open →",
  "本页是各板块口径的摘要；与代码 / 测试冲突时以后者为准。":
    "This page digests each section's basis — where it conflicts with the code or tests, they win.",

  // -------- 新板块 title(NAV 之外)
  钱包档案: "Wallet dossier",
  // 「系统状态」与 status 分片同键 —— 值必须一致(跨分片同键同值闸)。
  系统状态: "System Status",
  "订阅方 API": "Subscriber API",
  运营管理: "Operations",
  嵌入卡与站外出口: "Embed cards & outlets",

  // -------- 24h 扫描
  "全市场大额成交的过去 24 小时切片——一切监控的原始面。":
    "The past-24h slice of large trades across the whole market — the raw surface everything else monitors.",
  "实时拉取全市场 ≥ 阈值的成交流，每行带市场标题、结果方向、赔率、金额，以及钱包徽章：🏆 聪明钱、🆕 新地址、🤖 高频做市。":
    "Live feed of market-wide trades above the threshold; each row carries the market title, outcome side, odds, size, and wallet badges: 🏆 smart money, 🆕 fresh address, 🤖 HF market maker.",
  "战绩列惰性加载每个钱包的已结算胜率与净盈亏（官方口径），来自 /closed-positions 与 user-pnl 的缓存富集。":
    "The record column lazily loads each wallet's settled win rate and net P/L (official basis), enriched from cached /closed-positions and user-pnl data.",
  "筛选六轴：金额下限、买/卖方向、时间窗、价格（赔率）区间、地址年龄、事件赛道（体育细拆到联盟）。":
    "Six filter axes: minimum size, buy/sell side, time window, price (odds) band, address age, and event category (sports drilled to league level).",
  "组合筛选器缩小目标——经典组合「价格 0.50-0.90 + 地址年龄 ≤7 天」专抓为一笔交易新开的钱包（最强内幕形态之一）。":
    'Combine filters to narrow in — the classic "price 0.50-0.90 + address age ≤7 days" combo hunts wallets opened for a single trade (one of the strongest insider shapes).',
  "点击钱包短地址进档案页，点击「市场信号卡」看该市场的全部信号聚合；筛选状态写进 URL，可直接分享复现。":
    'Click a short address for the wallet dossier, or "market signal card" for everything on that market; filter state lives in the URL and shared links reproduce the view.',
  "「金额大 = 聪明钱」已被本站 edge 体检证伪——大额是关注的起点，不是结论；结合徽章与战绩列再下判断。":
    '"Big size = smart money" has been falsified by this site\'s edge audit — a large trade is where attention starts, not a conclusion; judge with the badges and record column.',
  "战绩列「—」不是零：它是「判不了」（战绩被截断或高频做市商），与「测过了是零」严格分家。":
    'A "—" in the record column is not zero: it means "unjudgeable" (truncated record or HF market maker), strictly distinct from "measured and got zero".',
  "单笔视角天然漏掉拆单建仓（实测漏约六成 ≥$10k 的累计买家）——要看全貌需配合拆单累计榜。":
    "The single-fill view inherently misses split-order accumulation (measured: ~60% of ≥$10k cumulative buyers slip through) — pair it with the accumulation board for the full picture.",

  // -------- 拆单累计
  "抓「每一笔都低于告警线」的隐蔽建仓——单笔监控的盲区补全。":
    "Catches stealth accumulation where every order stays under the alert line — the blind-spot complement to single-fill monitoring.",
  "把同一钱包在同一（市场 · 结果）上的多笔小单聚合成净买入仓位，按净额排序，附规模加权均价与地址年龄。":
    "Aggregates one wallet's many small orders on one (market · outcome) into a net buy-in position, sorted by net size, with size-weighted average odds and address age.",
  "每行可展开，看到堆出这个仓位的全部底单（时间、单笔金额、价格）。":
    "Every row expands to show the underlying orders that built the position (time, per-order size, price).",
  "精度 floor 可调（$500 / $1k / $2k）：越低越灵敏也越吵；默认 $2k 适合日常巡视。":
    "The precision floor is adjustable ($500 / $1k / $2k): lower is more sensitive but noisier; the $2k default suits daily patrol.",
  "看到可疑聚合后点进钱包档案页核战绩，再用市场信号卡看同市场还有谁在动。":
    "On a suspicious aggregate, open the wallet dossier to check the record, then the market signal card to see who else is moving in that market.",
  "口径是 NET 净买入（买减卖），同钱包对倒不会虚增仓位。":
    "The basis is NET buy-in (buys minus sells) — self-matching by the same wallet cannot inflate a position.",
  "拆单是行为形态不是罪名——做市商与量化钱包也会小单执行；结合 🏆/🆕 徽章与战绩再定性。":
    "Splitting is a behaviour shape, not an accusation — market makers and quant wallets also execute small; qualify it with the 🏆/🆕 badges and the record.",

  // -------- 市场卡
  "单个市场的信号聚合页——这个盘上都发生过什么。":
    "The per-market signal aggregation page — everything that has happened on this market.",
  "汇总该市场的共识/分歧状态、聪明钱敞口、拆单累计、新钱包动向与历史告警战绩。":
    "Aggregates the market's consensus/disagreement state, smart-money exposure, split-buy accumulation, fresh-wallet activity and historical alert record.",
  "复盘时光机：已结算市场可点击加载完整时间线——价格曲线 × 本站告警时点 × 结算结果。":
    "Replay time machine: for settled markets, click to load the full timeline — price curve × this site's alert moments × settlement.",
  "从任意表格行的「市场信号卡」链接进入，或在 /market 索引页搜索；URL 可直接分享。":
    'Enter from any table row\'s "market signal card" link, or search on the /market index; URLs are directly shareable.',
  "复盘时点击「加载回放」——曲线按需拉取，不点不花预算。":
    'Click "load replay" to fetch the curve on demand — no click, no budget spent.',
  "回放里的告警点是本站当时真实发出的信号（存证台账），不是事后标注——这正是复盘的意义。":
    "The alert points in a replay are signals this site actually published at the time (evidence ledger), not hindsight annotations — that is the whole point of a replay.",
  "分歧只有告警时点可回放，连续状态轨迹刻意不落库（存储红线）；两个告警点之间的空白 ≠ 没有分歧。":
    "Disagreement replays only at alert moments; the continuous state trajectory is deliberately not stored (storage red line). A gap between two alert points ≠ no disagreement.",

  // -------- 市场脉搏
  "每日市场聚合的异常日榜——从「谁在买」抬头看「市场怎么了」。":
    'Daily anomaly boards over market aggregates — lifting the gaze from "who is buying" to "what is the market doing".',
  "异常榜：量能/钱包数异动的市场日榜，小单 vs 鲸鱼的方向分歧榜。":
    "Anomaly board: daily rankings of volume/wallet-count outliers, plus the small-vs-whale directional divergence board.",
  "无鲸异动榜：价格移动 ≥10¢ 但窗口内没有对应大单——要么簿子薄，要么蚂蚁搬家。":
    "Ghost-move board: price moved ≥10¢ with no matching large fill in the window — either a thin book or ant-style accumulation.",
  "洗量榜：同钱包当日在同一市场配对买卖的量占比（双腿口径），占比 ≥20% 且量 ≥$10k 入榜。":
    "Wash board: the share of volume matched between buys and sells by the same wallet in the same market that day (both legs counted); a market ranks at ≥20% share and ≥$10k volume.",
  "品类确信指数：阵营对峙 + 对立度 + 价格动荡 + 量能异动四分量的每日加权求和（0.30/0.30/0.20/0.20），高 = 激辩，低 = 确信（VIX 语义）。":
    "Category conviction index: a daily weighted sum of four components — contest + opposition + price churn + volume surge (0.30/0.30/0.20/0.20); high = contention, low = conviction (VIX semantics).",
  "按日期翻页看历史；榜单行点入市场卡追根；确信指数按品类切换。":
    "Page through days for history; board rows link into the market card; the conviction index switches by category.",
  "洗量分是结构描述不是指控——高分说「这个盘的成交结构可疑」，不点名任何钱包作弊。":
    'The wash score describes structure, it does not accuse — a high score says "this market\'s fill structure looks suspicious", it names no cheater.',
  "老日期的空列是「当时没采这个维度」：不知道 ≠ 没有鲸；空值不进榜也不画图。":
    'Empty columns on old dates mean "this dimension wasn\'t collected then": not knowing ≠ no whale; nulls never rank and never chart.',
  "确信指数是现有数据的纯投影，不是预测器——它总结昨天，不预言明天。":
    "The conviction index is a pure projection of existing data, not a predictor — it summarises yesterday, it does not forecast tomorrow.",

  // -------- 市场校准
  "Polymarket 价格本身准不准——按赔率带对比隐含概率与实际发生率。":
    "Is the Polymarket price itself calibrated — implied probability vs realised frequency, by odds band.",
  "把本站观察时点的市场价格当预测，与最终结算对比，按赔率带汇总隐含均值、实际发生率与聚簇 95% 区间。":
    "Treats the market price at this site's observation moments as a forecast, compares it with final settlement, and aggregates per odds band: implied mean, realised rate, clustered 95% interval.",
  "总体与分品类两个视角，样本随结算回填每日增长。":
    "Overall and per-category views; the sample grows daily as settlements backfill.",
  "读「偏差」列：正 = 该价位历史上被低估（便宜），负 = 被高估；切品类看结构差异。":
    'Read the "gap" column: positive = historically underpriced (cheap) at that level, negative = overpriced; switch categories for structural differences.',
  "这不是本站信号的战绩页——它回答的是市场价格本身的校准度，与我们的告警准不准无关。":
    "This is not this site's signal record — it answers how calibrated the market price itself is, independent of whether our alerts are any good.",
  "选择偏差声明：样本 = 告警触发时点的价格观察（大额/聪明钱活动时刻，非随机抽样），结论只主张到这个样本。":
    "Selection-bias statement: the sample is price observations at alert moments (times of large/smart-money activity, not random sampling); conclusions claim only this sample.",
  "只有隐含均值落在聚簇 95% 区间之外，偏差才谈得上统计显著；区间按市场数聚簇，同市场多条观察是同一事件的复制品。":
    "A gap is only statistically meaningful when the implied mean falls outside the clustered 95% interval; intervals cluster by market count — observations in one market are replicas of a single event.",

  // -------- 共识 / 分歧
  "白名单钱包的集体行为：同向 = 共识，对立 = 分歧，撤出 = 离场。":
    "Collective behaviour of whitelist wallets: same side = consensus, opposite sides = disagreement, selling out = exits.",
  "共识：时间窗内 ≥2 个互不相同的白名单钱包各自净买入 ≥$5k 同一结果——几个高胜率钱包独立得出同一结论。":
    "Consensus: within the window, ≥2 distinct whitelist wallets each net-buy ≥$5k of the same outcome — several high-win-rate wallets independently reaching one conclusion.",
  "分歧：同一市场两侧都有白名单仓位时按质量（评分×金额）加权称天平——与共识互斥，分歧市场绝不冒充共识。":
    "Disagreement: when both sides of a market hold whitelist positions, a quality-weighted (score × size) balance is struck — mutually exclusive with consensus; a contested market never masquerades as consensus.",
  "离场：池内钱包的卖侧镜像聚合（净卖出份额 × 均卖价），「白名单正在集体撤出」可能比进场更有信息量。":
    'Exits: the sell-side mirror aggregation for pool wallets (net shares sold × average sell price) — "the whitelist is collectively leaving" can carry more information than entries.',
  "每组附现价与跟单空间（现价 − 共识均价的 ¢ 差）：|差| ≤5¢ 记「仍可跟」，正向超出记「已跑」，负向超出记「已反向」。":
    'Each group carries the current price and follow room (current price − consensus average, in ¢): |gap| ≤5¢ reads "followable", above that on the upside "gone", below it on the downside "reversed".',
  "三个 tab 切换共识/分歧/离场；行展开看每个成员的建仓明细。":
    "Three tabs switch consensus / disagreement / exits; rows expand into each member's entry detail.",
  "Telegram 推送只在共识形成与升级（又一个钱包加入）时发，不重复轰炸。":
    "Telegram pushes fire only on consensus formation and upgrades (another wallet joining) — no repeat bombardment.",
  "分歧市场里的「共识」是假共识，检测层已剔除——看到共识组即代表该市场当时没有权重可比的反向白名单仓位。":
    '"Consensus" inside a contested market is fake consensus and the detector drops it — a consensus group you see means no comparably-weighted opposing whitelist position existed at the time.',
  "高频做市商不投票：他们的成交是库存调平不是方向观点（口径红线）。":
    "HF market makers don't vote: their fills are inventory rebalancing, not directional opinion (a basis red line).",
  "共识形成价 ≠ 你的进场价：跟单空间列就是这段距离——「已反向」不是折扣，是共识论点可能已被推翻，进场即接飞刀。":
    'Formation price ≠ your entry price: the follow-room column is exactly that distance — "reversed" is not a discount, it means the consensus thesis may already be broken and entering is catching the knife.',

  // -------- 聪明钱发现
  "聪明钱从哪来：证据漏斗 → 准入闸 → 白名单池，全程可审计。":
    "Where smart money comes from: evidence funnel → admission gate → whitelist pool, auditable end to end.",
  // 🥇 而非 🎯 —— 一符两义裁决(2026-09-04):🎯 归「冷门猎手」与市场信号卡。
  "四条发现渠道积累 30 天证据：🔁 同行（反复与已知聪明钱同侧）、🧩 拆单老手、🕵️ 内幕形态（新钱包+甜区重注）、🥇 早期赢家。":
    "Four discovery channels accumulate 30 days of evidence: 🔁 echo (repeatedly siding with known smart money), 🧩 splitter veterans, 🕵️ insider shape (fresh wallet + sweet-spot heavy bet), 🥇 early winners.",
  "准入闸：复发广度（30 天 ≥3 个不同市场）+ 战绩闸（已结算 ≥10 且胜率 ≥55% 且净盈亏为正，或 ≥5 且 ROI ≥5%）双合格才入池。":
    "The admission gate: recurrence breadth (≥3 distinct markets in 30 days) + the track-record gate (≥10 settled with ≥55% win rate and positive net P/L, or ≥5 settled with ≥5% ROI) — both required to enter the pool.",
  "渠道效果记分卡：每条已评级告警都是池成员的前向实验——按来源渠道算净 edge ± 聚簇区间，含离池桶与做市商横切。":
    "Channel scorecard: every graded alert is a forward experiment by a pool member — net edge ± clustered interval per source channel, with a departed-wallet bucket and a market-maker split.",
  "名人堂与反指名单：逐钱包 CRVE 战绩，反向对照与多重比较披露同框；行为指纹给出「和他风格最像的钱包」。":
    'Hall of fame and fade list: per-wallet CRVE records with reverse controls and multiplicity disclosure in the same frame; behavioural fingerprints surface "wallets most similar in style".',
  "漏斗行展开看候选钱包的全部证据明细；池表按评分/胜率/净盈亏排序。":
    "Funnel rows expand into a candidate's full evidence detail; the pool table sorts by score / win rate / net P/L.",
  "手动白名单在此管理（需管理令牌）：手动成员永不自动过期。":
    "Manual whitelisting is managed here (admin token required): manual members never auto-expire.",
  "记分卡是前向实验不是回测：入池那天起的告警才计入该渠道战绩，没有事后挑样本的空间。":
    "The scorecard is a forward experiment, not a backtest: only alerts from the day a wallet entered the pool count toward its channel — there is no room to cherry-pick samples after the fact.",
  "反指名单带 Bonferroni 纪律——单个钱包「稳定错」要过多重比较闸才上榜；显著 ≠ 可交易。":
    'The fade list carries Bonferroni discipline — a wallet must clear the multiple-comparison gate to be listed as "reliably wrong"; significant ≠ tradeable.',
  "离池成员的战绩留在独立桶里，防幸存者偏差：池的历史成绩不因清退差生而变好看。":
    "Departed members' records stay in a separate bucket against survivorship bias: purging underperformers never beautifies the pool's history.",

  // -------- 聪明钱自测
  "把你自己的钱包放进同一把尺子——按池准入口径领一份判决书。":
    "Put your own wallet under the same yardstick — get a verdict against the pool-admission basis.",
  "粘贴任意钱包地址，得到三件事：过没过池准入的战绩闸、在当前池成员里的三轴分位（胜率/净盈亏/评分）、一张可分享的嵌入判决卡。":
    "Paste any wallet address and get three things: whether it clears the pool's track-record gate, three percentile axes vs current pool members (win rate / net P/L / score), and a shareable embed verdict card.",
  "判决口径与池准入完全同源（同一个函数），「未过闸」与「样本不可判」严格分家。":
    'The verdict basis is identical to pool admission (the same function); "below bar" and "unjudgeable" are strictly separate verdicts.',
  "首测新地址要拉全量已结算持仓（约几秒）；重测走 24 小时判决缓存即时返回。":
    "A first test on a new address pulls the full settled history (a few seconds); re-tests hit the 24-hour verdict cache and return instantly.",
  "「复制嵌入卡代码」拿 iframe 片段贴进论坛/X；钱包档案页底部也有点击加载的判决块。":
    '"Copy embed code" gives an iframe snippet for forums/X; the wallet dossier also carries a click-to-load verdict block at the bottom.',
  "判决是按本站准入口径的战绩体检——不是资质认证，不是投资建议，也不是入池申请。":
    "The verdict is a track-record checkup against this site's admission basis — not certification, not investment advice, and not a pool application.",
  "池准入另有「30 天 ≥3 市场」复发证据要求（发现渠道专属），自测不考：自测通过 ≠ 自动入池。":
    "Pool admission additionally requires recurrence evidence (≥3 markets in 30 days, a discovery-channel requirement) that the self-test does not examine: passing ≠ automatic pool entry.",
  "战绩被截断（已结算超约 1000 仓）时胜率/ROI 显示「—」且判决降级「样本不可判」——绝不显示错数。":
    'When the record is truncated (over ~1000 settled positions), win rate/ROI show "—" and the verdict degrades to "unjudgeable" — a wrong number is never shown.',

  // -------- 实时告警
  "告警台账 + 验证闭环：每条信号都要事后被自己的验证打分。":
    "The alert ledger + validation loop: every signal gets graded afterwards by its own validation.",
  "全部已发告警的台账：大额/聪明钱/共识分组，每条带 1h/24h 价格跟随与最终结算结果的回填。":
    "The ledger of every alert sent: grouped large / smart / consensus, each backfilled with 1h/24h price follow-through and the final settlement result.",
  "顶部按信号类型汇总方向命中率与已结算胜率，附 Wilson 95% 区间（按市场聚簇）。":
    "The header aggregates directional hit rate and settled win rate per signal type, with Wilson 95% intervals (clustered by market).",
  "价格影响持久性：第四条带回答「这个钱包的告警发出后，市场保住那 10 分钟的移动了吗」。":
    'Price-impact persistence: the fourth strip answers "after this wallet\'s alerts, did the market keep the 10-minute move?"',
  "告警条件配置面板（需令牌）：金额、方向、价格区间、地址年龄、赛道、仅聪明钱等。":
    "The alert-condition panel (token required): size, side, price band, address age, category, smart-only, and more.",
  "改阈值即时生效（写入配置历史可审计）；Telegram 凭证可选——不配也全量落库，配了才推送。":
    "Threshold changes apply immediately (written to the auditable config history); Telegram credentials are optional — without them everything still lands in the ledger, with them it also pushes.",
  "验证列用来复盘：先看命中率区间再决定信不信这类信号。":
    "Use the validation columns for review: check the hit-rate interval before deciding how much to trust a signal class.",
  "命中率的置信区间按市场数聚簇：同一市场几十条告警是同一个随机事件的复制品，按条数算区间会假精确约 1.9 倍。":
    "Hit-rate confidence intervals cluster by market count: dozens of alerts in one market are replicas of a single random event — per-alert intervals would be ~1.9× falsely precise.",
  "±0.5¢ 死区内记平推不记命中——微小波动不该给任何方向记功。":
    "Moves inside the ±0.5¢ dead zone score as a push, not a hit — tiny wiggles credit no direction.",
  "「样本不足」的判定也按市场数——别把 200 条告警当 200 个独立证据。":
    '"Insufficient sample" is also judged by market count — don\'t treat 200 alerts as 200 independent pieces of evidence.',

  // -------- 策略中心
  "19 档纸面策略的诚实账本——含执行成本、含反向对照、含自我怀疑。":
    "The honest ledger of 19 paper strategies — execution costs included, reverse controls included, self-doubt included.",
  "19 档策略并行前向记账（含 6 个反向对照档），每档净值阶梯、回撤、Wilson 区间、按赛道拆分。":
    "19 strategy tiers keep forward books in parallel (including 6 reverse controls), each with an equity staircase, drawdown, Wilson interval, and per-category splits.",
  "订单簿执行建模：进场按当时盘口吃单计价，含协议费；形成价/延迟成本/进场价三段分解。":
    "Order-book execution modelling: entries priced by eating the book at the time, protocol fees included; the formation price / latency cost / entry price three-way decomposition.",
  "深度分析面板六维度与退出反事实（「如果按规则 X 离场会怎样」）；逐信号盘口容量（+1¢/+3¢ 带内深度中位数）。":
    'The six-dimension deep-analysis panel and exit counterfactuals ("what if we had exited under rule X"); per-signal book capacity (median in-band depth at +1¢/+3¢).',
  "CUSUM 衰变哨兵 7×24 盯每档实盘偏离，显著衰变自动亮牌。":
    "A CUSUM decay sentinel watches each tier's live deviation 7×24 and flags significant decay automatically.",
  "先看策略卡的已结算样本量与区间，再看净值形状；展开深度分析看该档的赛道/赔率带结构。":
    "Read a strategy card's settled sample size and interval before its equity shape; expand deep analysis for the tier's category/odds-band structure.",
  "容量列回答「这个信号能容纳多少跟随资金」——超过容量的跟随会自己吃穿簿子。":
    'The capacity column answers "how much follow money this signal can hold" — following beyond capacity eats through the book yourself.',
  "全部是纸面模拟，非投资建议；净值已含执行成本与协议费，但真实滑点仍可能更差。":
    "Everything is paper simulation, not investment advice; equity includes execution costs and protocol fees, yet real slippage can still be worse.",
  "|超额| < 2σ 的档位必须读成「仍在运气范围内」——运气范围措辞是本站红线不是谦辞。":
    'A tier with |excess| < 2σ must be read as "still within luck\'s range" — that phrasing is a site red line, not modesty.',
  "反向对照档存在的意义是打自己的脸：正向档显著而对照档不显著，结论才立得住。":
    "Reverse-control tiers exist to slap our own face: only when the forward tier is significant and its control is not does the conclusion stand.",

  // -------- 信号战绩
  "对外公开的 30 天信号战绩——带每日存证链，欢迎对账。":
    "The public 30-day record of published signals — with a daily evidence chain, reconciliation welcome.",
  "已发布信号按档位汇总 30 天战绩：条数、命中、对市场超额与 σ。":
    "Published signals aggregate into a 30-day record per tier: count, wins, excess vs market, and σ.",
  "每日 digest 存证链：当天信号集合的哈希尾巴公开可见，事后无法悄悄改历史。":
    "The daily digest chain: the hash tail of each day's signal set is public — history cannot be quietly rewritten afterwards.",
  "订阅方对账：拿存证尾巴与 API 返回比对；嵌入卡 /embed/record 可贴进任何页面。":
    "Subscribers reconcile by comparing the digest tail with API responses; the /embed/record card drops into any page.",
  "wins/implied/excess 全是条数量纲的价格调整口径——不是「买了就赚这么多」。":
    'wins/implied/excess are all in per-signal price-adjusted units — not "buy and earn this much".',
  "|excess| < 2×sd 的档位页面自己会写「仍在运气范围内」——这行字消失才值得警惕。":
    'Tiers with |excess| < 2×sd say "still within luck\'s range" on the page itself — worry when that line disappears.',

  // -------- 钱包档案
  "任意地址的完整画像——战绩、持仓、行为指纹与判决。":
    "The full picture of any address — record, holdings, behavioural fingerprint, and verdict.",
  "KPI 五卡：已结算胜率、净盈亏（官方口径）、已结算 ROI、链上 PUSD 闲置现金、近窗买卖与拆单倾向。":
    "Five KPI cards: settled win rate, net P/L (official basis), settled ROI, on-chain idle PUSD cash, and window buys/sells with split tendency.",
  "当前持仓表（活仓市值与浮盈）、赔率带直方图、专攻类别、价格影响判词、相似钱包、最近成交。":
    "Current-positions table (live value and unrealised P/L), odds-band histogram, category focus, price-impact verdict, similar wallets, recent trades.",
  "底部聪明钱自测判决块（点击加载）。":
    "A click-to-load smart-money self-test verdict block at the bottom.",
  "从任何表格的钱包短地址点入（无独立索引页）；限流或上游故障时自动降级到本地留存数据并倒计时重试。":
    "Enter from any table's short address (there is no index page); on rate limits or upstream failure it degrades to locally stored data and auto-retries on a countdown.",
  "净盈亏是 Polymarket 官方口径（已实现 + 持仓浮动），与主页 Profit/loss 一致——不是已结算之和。":
    "Net P/L is Polymarket's official basis (realised + unrealised on open positions), matching the profile's Profit/loss — not a sum of settled positions.",
  "「—」= 判不了：战绩截断（只能取到按盈亏排序的赢家切片）或高频做市商（胜率口径无意义）。":
    '"—" = unjudgeable: a truncated record (only the profit-sorted winner slice was reachable) or an HF market maker (win-rate basis meaningless).',
  "降级横幅出现时你看的是本地缓存快照，不是实时数据——横幅消失前别当最新读。":
    "When the degradation banner shows, you are looking at a local cached snapshot, not live data — don't read it as current until the banner clears.",

  // -------- 说明(glossary)
  "全站符号与名词的唯一定义表——悬停提示与它同源。":
    "The single definition table for every symbol and term — hover tips share its source.",
  "三张表：图标标识（💰🐳🧩🆕🏆🔥⚖️…）、钱包标签（发现渠道与行为标签）、核心名词（形成价、延迟成本、聚簇区间…）。":
    "Three tables: icon marks (💰🐳🧩🆕🏆🔥⚖️…), wallet tags (discovery channels and behaviour tags), core terms (formation price, latency cost, clustered interval…).",
  "信号强度速查：从大额到共识的强度阶梯。":
    "A signal-strength quick map: the ladder from large trades up to consensus.",
  "任何页面悬停图标即见同一份解释；拿不准一个词先来这里查。":
    "Hover any icon on any page for the same explanation; unsure about a term, look here first.",
  "每个术语都有精确口径，拿日常语义猜是最常见的误读来源——例如「已结算胜率」只含已结算仓位、死扛中的浮亏不在内。":
    'Every term has a precise basis, and guessing by everyday meaning is the most common misreading — e.g. "settled win rate" covers only settled positions; unrealised losses being ridden down are not in it.',
  "词表与悬停提示同一数据源，永不漂移——若页面措辞与词表冲突，以词表为准并请报告（那是 bug）。":
    "The table and hover tips share one data source and can never drift — if page wording conflicts with the table, the table wins; please report it (that's a bug).",

  // -------- 系统状态
  "引擎还活着吗——公开的心跳与 30 天连续性时钟。":
    "Is the engine alive — the public heartbeat and the 30-day continuity clock.",
  "各轮询循环的心跳、最近周期指标、停跳点名；连续覆盖天数时钟（30 天闸门达成记录）。":
    "Heartbeats of every polling loop, recent cycle metrics, stalled-loop callouts; the continuous-coverage clock (with the 30-day gate achievement on record).",
  "不进导航（避免拿绿灯占注意力），从 /manage 或直接输 URL 进入；嵌入卡 /embed/status 可外挂到监控墙。":
    "Not in the nav (a green light shouldn't occupy attention) — enter via /manage or the URL directly; the /embed/status card mounts on any monitoring wall.",
  "连续性时钟是数据资格声明：战绩类结论的样本从时钟起点起算——断档期间的信号不是没发，是不计入连续记录。":
    "The continuity clock is a data-qualification statement: record-type conclusions sample from the clock's start — signals during outages weren't unsent, they just don't count toward the continuous record.",

  // -------- 订阅方 API
  "把信号接进你自己的系统——API key、webhook、数据集与 MCP。":
    "Pipe the signals into your own system — API keys, webhooks, the dataset, and MCP.",
  "信号总线两条事件线（原始事件/策略事件）+ 折叠视图；API key 分层（实时/延迟）与范围控制。":
    "Two signal-bus event lines (raw events / strategy events) plus collapsed views; tiered API keys (realtime/delayed) with scope control.",
  "HMAC 签名 webhook 推送、每日摘要存证链、公开 CSV 数据集（CC BY 4.0）、MCP server（npm run mcp）。":
    "HMAC-signed webhook delivery, the daily digest evidence chain, the public CSV dataset (CC BY 4.0), and an MCP server (npm run mcp).",
  "先读 /api-docs 的端点总览与可靠性承诺表；令牌在 /manage 签发；webhook 配好后用测试事件验签。":
    "Start with the endpoint overview and reliability-promise table on /api-docs; keys are issued in /manage; after wiring a webhook, verify the signature with a test event.",
  "推荐消费模式「事件做触发、视图做渲染」——把每条共识升级事件当独立信号计数是唯一的坑（一个组会被数成多个）。":
    'The recommended consumption pattern is "events trigger, views render" — counting each consensus-upgrade event as an independent signal is the one trap (one group gets counted many times).',
  "延迟档 key 拿到的是同一份数据的延迟视图,不是降质数据——口径完全一致。":
    "A delayed-tier key gets a delayed view of the same data, not degraded data — the basis is identical.",

  // -------- 运营管理
  "站长驾驶舱——信号线、投递通道、密钥与阈值重推，全在令牌门后。":
    "The operator's cockpit — signal lines, delivery channels, keys and threshold re-derivation, all behind the token gate.",
  "信号线与管线总览、路由矩阵、告警规则、Telegram 目标、𝕏 账号、API key 与 webhook 管理、市场深度卡预算、walk-forward 阈值重推（🧪）。":
    "Signal-line and pipeline overviews, the routing matrix, alert rules, Telegram targets, 𝕏 accounts, API-key and webhook management, market-depth-card budget, and walk-forward threshold re-derivation (🧪).",
  "整页在管理令牌门后（页面结构本身就是运营情报）；唯一例外是引擎健康度——它公开在 /status。":
    "The whole page sits behind the admin-token gate (the page structure itself is operational intelligence); the one exception is engine health — public on /status.",
  "输入 ADMIN_TOKEN 解锁（只存本浏览器）；顶部状态条异常项可一键跳到对应区块。":
    "Unlock with the ADMIN_TOKEN (stored only in this browser); anomalies on the status strip jump straight to their section.",
  "walk-forward 重推只出建议、永不自动改参是硬纪律——生产参数每次变更都走配置历史，可审计可回滚。":
    "Walk-forward re-derivation only recommends and never auto-applies — a hard discipline; every production-parameter change goes through the auditable, revertible config history.",
  "「Workers Builds」类外部集成红灯与本站引擎健康无关——引擎状态只看 /status。":
    'Red lights from external integrations like "Workers Builds" have nothing to do with engine health — for the engine, /status is the only reference.',

  // -------- 嵌入卡与站外出口
  "把可验证的战绩带出站——嵌入卡、Telegram 频道与 𝕏 播报。":
    "Take the verifiable record off-site — embed cards, the Telegram channel, and 𝕏 broadcasting.",
  "三张零脚本嵌入卡：/embed/record（战绩）、/embed/status（状态）、/embed/selftest（自测判决）——自包含 HTML、60 秒缓存、带署名回链。":
    "Three zero-script embed cards: /embed/record (record), /embed/status (status), /embed/selftest (self-test verdict) — self-contained HTML, 60-second cache, attribution backlink.",
  "Telegram 频道实时推送分档信号；𝕏 自动播报带结算自回复、每日战报榜与周报卡（默认关，后台开关）。":
    "The Telegram channel pushes tiered signals in real time; 𝕏 auto-broadcasting carries settlement self-replies, a daily card and a weekly report card (off by default, toggled in ops).",
  "嵌入卡复制 iframe 片段即用，theme=dark 换暗色；Telegram 从导航顶栏进频道。":
    "Embed cards work by copying the iframe snippet; theme=dark switches the palette; the Telegram channel is reachable from the top nav.",
  "嵌入卡刻意 noindex——它是分发面不是搜索位；卡上的「Data as of」是数据时刻,别当实时读。":
    "Embed cards are deliberately noindex — they are a distribution surface, not a search slot; the card's \"Data as of\" is the data moment, don't read it as live.",
  "𝕏 播报的每条结算自回复都是公开的自我打分——错了也回帖,这是频道存在的前提而非缺陷;自回复是挂在原帖下的凭证,每日战报榜才是让它被看见的那一层。":
    "Every settlement self-reply on 𝕏 is public self-grading — wrong calls get replied to as well; that is the channel's premise, not a defect. The self-reply is the receipt pinned under the original post; the daily card is the layer that makes it visible.",
};
