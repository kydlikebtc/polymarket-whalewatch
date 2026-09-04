// discovery 页字典分片 —— 键=中文原文,值=英文译文。由该页改造代理独家填写。
// 术语沿用 README 既有英文:discovery channels / admission gate / candidate
// funnel / recurrence / track-record review / category boards / echo /
// splitter / insider signature / early winner。
// 注意:WALLET_TAGS 词表定义串(name/kind/detail)不在此分片 —— glossary
// 分片是唯一属主;此处只收 discovery 页与 WhitelistDialog 自有文案,外加
// lib/walletTags 产出的标签底文(滤掉 ×N 后缀后的可枚举全集,筛选 chips 用)。
export const DICT_DISCOVERY: Record<string, string> = {
  // 渠道效果记分卡(2026-08-28)
  渠道记分卡: "Channel scorecard",
  "分类榜·{cat}": "Category board · {cat}",
  "回声(echo)": "Echo",
  "拆单(splitter)": "Splitter",
  "新钱包(insider)": "Insider",
  未归因: "Unattributed",
  "已离池(来源失联)": "Departed (source lost)",
  "全局榜·做市商": "Global board · market makers",
  "全局榜·非做市商": "Global board · humans",
  "✅ 显著为正": "✅ Significantly positive",
  "❌ 显著为负": "❌ Significantly negative",
  "○ 不显著": "○ Not significant",
  "· 市场数不足": "· Too few markets",
  告警行: "Graded rows",
  费用: "Fees",
  "净 edge ±95%(聚类)": "Net edge ±95% (clustered)",
  判定: "Verdict",
  "smart {s} 条 · 共识成员 {c} 条": "{s} smart · {c} consensus-member rows",
  "记分卡数据不可用(旧部署或接口错误)。":
    "Scorecard unavailable (stale deployment or API error).",
  // 渠道口径与逐行贡献公式从正文灰框搬进了对应列头的 (?)
  "smart / 共识告警只对在池钱包触发，每条已结算告警都是该钱包在池期间的一次前向实验；按首发渠道(source)归组。":
    "smart / consensus alerts only fire for pool members, so every graded alert is a forward experiment made while the wallet was in the pool; grouped by first-discoverer source.",
  "逐行贡献 = 结算胜负 − 入场隐含 − 协议费(概率点/行)；区间为市场聚类稳健口径。":
    "Per-row contribution = settlement result − entry implied − protocol fee (probability points); intervals are market-clustered robust.",
  "全局榜 × 做市商横切": "Global board × market-maker split",
  "官方榜不区分做市商，该不该留由数据说话。":
    "The official leaderboard doesn't separate market makers — let the data decide whether they belong.",
  "已打分告警 {a} 条 → {r} 行；费用不可定价剔除 {f} 行（绝不当 0）；已离池 {o} 行 = 幸存者盲区读数。":
    "{a} graded alerts → {r} rows; {f} rows dropped for unpriceable fees (never guessed as 0); {o} departed rows = the survivorship blind-spot reading.",
  "本表 {g} 个分组，α=0.05 下期望假阳性 ≈ {e} 个 —— 单组「显著」在独立时间段复现前只是候选假设。":
    "{g} groups here, so ~{e} false positives are expected at α=0.05 — any single significant group is a candidate hypothesis until it replicates in an independent period.",

  // 渠道名(CHANNEL_META,证据子表渠道列 / ch: 筛选 chips 共用)
  共识同行: "Consensus echo",
  拆单建仓: "Split-buy entry",
  内幕签名: "Insider signature",
  早期赢家: "Early winner",

  // 相对时间
  "{n} 分钟前": "{n} min ago",
  "{n} 小时前": "{n} h ago",
  "{n} 天前": "{n} d ago",

  // 候选状态
  做市机器人: "Market-maker bot",
  "做市机器人 · 硬拒": "Market-maker bot · rejected",
  候选中: "Candidate",

  // 证据明细子表
  "近 30 天无渠道证据 —— 经榜单播种入池（全局榜/分类榜），或证据已滚出 30 天窗口":
    "No channel evidence in the last 30 days — seeded into the pool from a leaderboard (global/category board), or the evidence rolled out of the 30-day window",
  渠道: "Channel",
  证据: "Evidence",
  "市场 · 结果": "Market · Outcome",
  金额: "Amount",
  价格: "Price",
  时间: "Time",
  "旧证据行未存市场详情 — 引擎会从 gamma 自动回填（启动后约 1 分钟），个别已下架市场保持空缺":
    "Legacy evidence rows stored no market details — the engine backfills them from gamma automatically (about 1 minute after startup); a few delisted markets stay blank",

  // 页头 / 错误
  "加载失败：{msg}": "Failed to load: {msg}",

  // 页头（Etherscan 皮：12px 小标 + 24/600 标题 + 14px 描述）—— 描述压到
  // 一句话；入池口径全文只在 /guide#discovery（页头右侧动作钮）。
  白名单之外的候选漏斗: "The candidate funnel beyond the whitelist",
  "候选须 30 天内证据广度 ≥3 且通过战绩审查才入池。":
    "A candidate needs evidence breadth ≥3 within 30 days and must pass the track-record review to enter the pool.",

  // 漏斗 KPI 四格（Etherscan 皮：01–04 编号取代了原来的 ①②③④ + 箭头）
  "01 · 30 天证据": "01 · 30-day evidence",
  "02 · 候选钱包": "02 · Candidate wallets",
  "03 · 准入闸门": "03 · Admission gate",
  "04 · 共识白名单池": "04 · Consensus whitelist pool",
  "复发 ≥3": "Recurrence ≥3",
  "{n} 榜": "{n} from boards",
  "{n} 发现": "{n} discovered",

  // 漏斗（KPI 四格的辅助文案 / 入口 title；①②③④ 那版竖排漏斗条已下线，
  // 「聚合」「通过」两键留给其他页面的动态 t()）
  发现漏斗: "Discovery funnel",
  "成交流涌现 + 结算回溯": "Firehose emergence + settlement sweep",
  聚合: "Aggregate",
  查看候选漏斗列表: "View the candidate funnel list",
  "纯观察 · 不进任何信号": "Watch-only · feeds no signals",
  "机器人硬拒 · 分类榜旁路": "Bots hard-rejected · category-board bypass",
  通过: "Pass",
  "查看全局榜成员（top-100 自带门槛，免审查）":
    "View global-board members (top-100 is its own bar — review waived)",
  全局榜: "Global board",
  "查看发现渠道产出的成员（分类榜专家 + 漏斗毕业生）":
    "View members produced by the discovery channels (category-board specialists + funnel graduates)",
  发现渠道: "Discovery channels",

  // 信号密度趋势（三列口径挂在各自表头的 (?) 上，不再有常驻说明框）
  信号密度: "Signal density",
  "信号密度（14 天） · 共识推送 ÷ 平均窗口量 + 发现渠道日产出":
    "Signal density (14d) · consensus alerts ÷ avg window volume + daily discovery output",
  日期: "Date",
  共识轮: "Cycles",
  平均窗口量: "Avg window vol",
  "当日平均 6h 窗口成交量 —— 窗口滚动重叠不能求和，平均窗口量是热度的无偏代理":
    "That day's average 6h-window volume — rolling windows overlap so volumes must not be summed; average window volume is an unbiased heat proxy",
  原始组: "Raw groups",
  分歧剔除: "Contested dropped",
  推送: "Fired",
  "推送 ÷ 平均窗口量（条/$1M）；随热度同跌 = 市场降温，热度稳定而密度独跌 = 阈值需重校":
    "Fired ÷ avg window volume (alerts/$1M); falling together with heat = the market cooled, falling alone under stable heat = thresholds need retuning",
  密度: "Density",
  "发现渠道（共识同行/拆单建仓/内幕签名/早期赢家）当日首次入账的证据行数":
    "Evidence rows first recorded that day by the discovery channels (consensus echo / split-buy entry / insider signature / early winner)",
  新证据: "New evidence",
  "{n} 条/$1M": "{n}/$1M",

  // 页头右侧动作钮 —— 跳 /guide#discovery 的漏斗口径全文
  漏斗规则全文: "Full funnel rules",

  // 控件区
  视图切换: "View switch",
  "候选漏斗 ({n})": "Candidate funnel ({n})",
  "白名单池 ({n})": "Whitelist pool ({n})",
  "搜索地址 / 市场 / 标签…": "Search address / market / tag…",
  搜索: "Search",
  "查看全部钱包标签的定义（与说明页同一数据源）":
    "See every wallet-tag definition (same data source as the glossary page)",
  标签说明: "Tag guide",
  "{shown}/{total} 条匹配": "{shown}/{total} matched",
  清除: "Clear",

  // 标签筛选 chips
  标签筛选: "Tag filters",
  "{label} — {n} 个钱包": "{label} — {n} wallets",
  "（点击取消）": " (click to clear)",
  // lib/walletTags 产出的标签底文(数据侧字符串,滤 ×N 后缀后的可枚举全集;
  // 未来新增类别/渠道自动回退中文,不会空串)
  "🤖 做市机器人": "🤖 Market-maker bot",
  "🏆 手动白名单": "🏆 Manual whitelist",
  "🏛 全局榜": "🏛 Global board",
  "池成员·来源未知": "Pool member · unknown source",
  "🏅 分类榜·sports": "🏅 Category board · sports",
  "🏅 分类榜·politics": "🏅 Category board · politics",
  "🏅 分类榜·crypto": "🏅 Category board · crypto",
  "🏅 分类榜·culture": "🏅 Category board · culture",
  "🏅 分类榜·tech": "🏅 Category board · tech",
  "🏅 分类榜·finance": "🏅 Category board · finance",
  "🔭 发现入池·共识同行": "🔭 Discovered · consensus echo",
  "🔭 发现入池·拆单建仓": "🔭 Discovered · split-buy entry",
  "🔭 发现入池·内幕签名": "🔭 Discovered · insider signature",
  "🔭 发现入池·早期赢家": "🔭 Discovered · early winner",

  // 候选漏斗表
  钱包: "Wallet",
  标签: "Tags",
  "各渠道去重市场数之和（同一市场被两个渠道命中计两次——两种独立行为签名强于一种）":
    "Sum of distinct evidence markets across channels (a market hit by two channels counts twice — two independent behavior signatures beat one)",
  复发广度: "Recurrence breadth",
  最近证据: "Latest evidence",
  状态: "Status",
  点击展开证据明细: "Click to expand the evidence detail",
  "暂无候选 —— 证据由共识循环（每 5 分钟）与每日已结算市场扫描持续积累":
    "No candidates yet — evidence accrues from the consensus loop (every 5 minutes) and the daily settled-market sweep",
  "无匹配 —— 试试清除搜索或标签筛选":
    "No matches — try clearing the search or tag filters",
  "仅加载复发广度前 {n} 名（30 天窗口内共 {m} 个候选钱包）":
    "Showing the top {n} by recurrence breadth ({m} candidate wallets in the 30-day window)",

  // 白名单池表
  评分: "Score",
  胜率: "Win rate",
  净盈亏: "Net PnL",
  "最近一次通过播种/重认证确认资格的时间；30 天不再合格自动出池":
    "When membership was last confirmed by seeding/re-certification; ages out after 30 days without re-qualifying",
  最近确认: "Last confirmed",
  "暂无 —— 候选通过准入审查（复发 ≥3 + 战绩闸）或分类榜播种后出现在这里":
    "Empty — wallets appear here after a candidate passes admission (recurrence ≥3 + the track-record gate) or a category board seeds them",
  // 卡底琥珀条压到一行：两种 — 成因用最短句式列全
  "— 是「判不了」不是零：评分 / 胜率 / 净盈亏 = 尚无战绩快照；最近确认 = 来源未记录时间。":
    "A — means “can't be judged”, not zero: score / win rate / net PnL = no track-record snapshot yet; last confirmed = the source recorded no time.",

  // 标签说明弹窗(词表正文 name/kind/detail 的译文由 glossary 分片供给)
  钱包标签说明: "Wallet tag guide",
  类别: "Category",
  定义: "Definition",

  // 白名单弹窗(WhitelistDialog;「聪明钱白名单」标题键由 common 分片供给)
  " · {n} 个钱包": " · {n} wallets",
  共识白名单池: "Consensus whitelist pool",
  "{n} 个钱包": "{n} wallets",
  "其中 {n} 个无投票权": "{n} of them carry no vote",
  // emoji 留在徽章上，正文里只引用文字名（readme §1：emoji 不进正文句中）。
  "「无投票权」= 做市机器人（成交市场数 ≥1000）：保留池成员资格以积累战绩数据，但做市流是库存再平衡、不是方向性观点，因此不计入共识 / 分歧投票。评分 / 胜率 / 净盈亏的 — 是「判不了」，不是零。":
    "“No vote” = market-maker bot (≥1000 markets traded): it keeps pool membership so track-record data keeps accruing, but market-making flow is inventory rebalancing rather than a directional view, so it never counts toward consensus / split votes. A — under score / win rate / net PnL means “can't be judged”, not zero.",
  "搜索地址…（0x…）": "Search address… (0x…)",
  搜索白名单地址: "Search whitelist addresses",
  "加载中…": "Loading…",
  "白名单为空（引擎首次播种约需 1 分钟）":
    "Whitelist is empty (first seeding takes about 1 minute after engine start)",
  无匹配地址: "No matching addresses",
  地址: "Address",
  手动: "manual",
  // 手动白名单行(is_whitelist=1)不参与 30 天老化清退 —— 灰底名称标签写全
  // 这层含义，比只写「手动」多一条读者真正关心的信息。
  "手动 · 永不过期": "Manual · never expires",
  "做市机器人（成交市场数 ≥1000）：保留池成员资格积累战绩数据，但不计入共识/分歧投票——做市流是库存再平衡，不是方向性观点":
    "Market-maker bot (≥1000 markets traded): keeps pool membership to accrue track-record data, but never votes in consensus/split — market-making flow is inventory rebalancing, not a directional view",
  无投票权: "no vote",
  // 名人堂/反指(第二梯队八件套,2026-08-28)
  "👑 名人堂": "👑 Hall of fame",
  // 视图切换的按钮文案 —— emoji 不上按钮(readme §1),👑 只留在 12px 小标。
  名人堂: "Hall of fame",
  "名人堂数据缺失（接口错误兜底）。":
    "League data missing (API error fallback).",
  "代号 / 钱包": "Codename / wallet",
  "代号是确定性哈希的纯趣味展示，地址才是身份。":
    "Codenames are deterministic-hash fun only — the address is the identity.",
  "样本 n（市场）": "n (markets)",
  "净 edge（点/仓）": "Net edge (pts/fill)",
  "逐行贡献 = 结算(0/1) − 入场隐含 − 每股协议费；区间按市场聚簇（CRVE）。":
    "Per-row contribution = settlement (0/1) − entry implied − per-share protocol fee; intervals are market-clustered (CRVE).",
  "最佳 / 最惨一战": "Best / worst call",
  "👑 名人堂 · 前向净 edge 显著为正":
    "👑 Hall of fame · forward net edge significantly positive",
  "暂无净 edge 显著为正的钱包（≥10 市场才发判定）。":
    "No wallet with significantly positive net edge yet (verdicts need ≥10 markets).",
  "🪞 反指名单 · 前向净 edge 显著为负":
    "🪞 Fade list · forward net edge significantly negative",
  "暂无净 edge 显著为负的钱包——逆势少数边暂时还是孤例。":
    "No wallet with significantly negative net edge yet — the contrarian-minority tier remains a lone example for now.",
  "共检验 {w} 个 ≥10 市场的钱包，区间未做 Bonferroni 校正 —— 两张名单是研究线索，不是交易结论。":
    "{w} wallets with ≥10 markets were tested and the intervals carry no Bonferroni correction — both lists are research leads, not trading conclusions.",
};
