// deep 页字典分片 —— 键=中文原文,值=英文译文。由该页改造代理独家填写。
// 覆盖 app/follow/DeepAnalysis.tsx(策略深度分析面板):六维度图表 + 缺陷
// 诊断 + 反事实剔除。赛道名(lib/categoryLabel 输出)与时长桶名
// (lib/followAnalysis DURATION_BOUNDS)由渲染处 t() 回查,键也收在此片。
export const DICT_DEEP: Record<string, string> = {
  // ---------------------------------------------------- 通用量词 / 战绩
  "{n} 仓": "{n} pos",
  "{w}胜{l}负": "{w}W {l}L",
  "{p}平": " {p}P",
  " · 样本不足": " · low sample",
  "(样本不足)": "(low sample)",
  无仓位: "No positions",
  // 表头位(th/data-label)统一 Title case:胜率/落袋 在 consensus·discovery·
  // follow 三页也是表头,本片在 index.ts 里排在它们之后会覆盖它们的值 ——
  // 与既有 "Win rate" 对齐,免得深度分析一上线把别的页表头改成小写。
  // 行内读数位(实际/隐含/均入场)保持小写,句中更自然。
  胜率: "Win rate",
  均入场: "avg entry",
  实际: "actual",
  隐含: "implied",
  落袋: "Realized",
  仓数: "Pos count",
  策略: "Strategy",
  赛道: "Track",
  持有时长: "Duration",
  赔率带: "Odds band",
  聚合: "Aggregate",
  未细分: "Unspecified",
  " · 不足": " · low",
  "样本不足,读数仅供方向参考": "Low sample — directional read only",

  // ------------------------------------- 赛道名(lib/categoryLabel 输出)
  政治: "Politics",
  选举: "Elections",
  体育: "Sports",
  电竞: "Esports",
  加密: "Crypto",
  经济: "Economy",
  金融: "Finance",
  商业: "Business",
  科技: "Tech",
  科学: "Science",
  文娱: "Pop culture",
  国际: "World",
  天气: "Weather",
  游戏: "Games",
  其他: "Other",
  足球: "Soccer",
  网球: "Tennis",
  高尔夫: "Golf",
  拳击: "Boxing",
  综合格斗: "MMA",
  板球: "Cricket",
  橄榄球: "Rugby",
  大学橄榄球: "College Football",
  大学篮球: "College Basketball",
  英雄联盟: "League of Legends",
  无畏契约: "Valorant",
  比特币: "Bitcoin",
  以太坊: "Ethereum",
  狗狗币: "Dogecoin",
  地缘政治: "Geopolitics",

  // ------------------------- 持有时长桶(lib/followAnalysis DURATION_BOUNDS)
  "<6 小时": "<6 h",
  "6–24 小时": "6–24 h",
  "1–3 天": "1–3 d",
  "3–7 天": "3–7 d",
  "≥7 天": "≥7 d",

  // ---------------------------------------------- 面板头部 / 空态 / 警示
  "暂无已结算仓位 — 深度分析基于落袋结果,有仓位结算后这里会给出 赔率校准/盈亏分布/时间走势/缺陷诊断等七个维度":
    "No settled positions yet — deep analysis runs on realized outcomes. Once positions settle, seven views appear here: odds calibration / PnL distribution / time trend / weakness diagnosis and more",
  "(当前持有中 {n} 仓)": "(currently holding {n} open)",
  "已结算纸面口径(不含浮盈,不含成本 — 成本见「成本分解」)· 平局 (push)不进胜率分母 · 持有中 {n} 仓不计入下方读数":
    "Settled paper basis (no unrealized PnL, no costs — see Cost breakdown) · pushes excluded from the win-rate denominator · {n} open positions not counted below",
  "小样本:仅 {n} 仓已结算(阈值 {m})。下面的全部读数只够看方向,不够下结论 —— 胜率带 Wilson 区间、期望带 t 值,请一起读。":
    "Small sample: only {n} settled (threshold {m}). Every read below is directional at best — take the win rate with its Wilson interval and the expectancy with its t-stat.",

  // ----------------------------------------------- ① 下注质量体检(KPI)
  "期望 / 仓": "Expectancy / pos",
  "全部已结算仓(含平局)单仓盈亏的算术平均。t 值 = 均值 ÷ 标准误:|t|≥2 约等于「均值显著异于 0」(95% 置信);胜率的 Wilson 区间管不了赔率不对称,期望的不确定性要看这里":
    "Arithmetic mean of per-position PnL across all settled positions (pushes included). t = mean ÷ standard error; |t|≥2 roughly reads as 'mean significantly different from 0' (95% confidence). The Wilson interval on win rate cannot capture odds asymmetry — expectancy uncertainty lives here",
  "赢仓 ÷(赢仓+输仓),平局不进分母;括号内为 Wilson 95% 区间 —— 小样本下区间比点估计诚实":
    "Wins ÷ (wins + losses); pushes stay out of the denominator. The CI is the Wilson 95% interval — on a small sample the interval is more honest than the point estimate",
  利润因子: "Profit factor",
  "总盈利 ÷ 总亏损。>1 才在赚钱;1.5 以上通常才值得认真对待。无亏损仓时不给 ∞,显示 —":
    "Gross profit ÷ gross loss. >1 means net positive; above 1.5 is usually where it deserves attention. With no losing positions we show — rather than ∞",
  "无亏损仓 · 总盈${a}": "no losing pos · gross win ${a}",
  "总盈${a} / 总亏${b}": "gross win ${a} / gross loss ${b}",
  盈亏比: "Payoff ratio",
  "均盈利仓 ÷ 均亏损仓。固定 $/仓下这主要由入场赔率结构决定:买冷门票赢一次抵几次亏,买热门票反过来 —— 与胜率合起来才是期望":
    "Average winning position ÷ average losing position. At fixed $ per position this is mostly set by the entry-odds structure: longshots pay for several losses with one win, favorites the reverse — only combined with win rate does it become expectancy",
  "均盈{a} / 均亏{b}": "avg win {a} / avg loss {b}",
  "最长连胜 · 连败": "Longest win · loss streak",
  "按结算时间排序的最长连续段(平局跳过不打断)。连败长度是实盘跟单的心理承受力与风控参考":
    "Longest runs in settlement-time order (pushes skipped, streaks unbroken). Max losing streak is the psychological-tolerance and risk-control reference for live copying",
  当前无连续段: "no active streak",
  "当前 {n} 连赢中": "currently on a {n}-win streak",
  "当前 {n} 连输中": "currently on a {n}-loss streak",
  "Top3 盈利占比": "Top-3 win share",
  "最大三笔盈利仓占总盈利的比例,以及把这三笔去掉后的净盈亏 —— 检验「是不是几笔大的撑起来的」。占比越高、去掉后转负,说明战绩越依赖尾部运气":
    "Share of gross profit from the three largest winners, plus net PnL once they are removed — a test of whether a few big hits carry the record. The higher the share (worse if removal flips the net negative), the more the record leans on tail luck",
  "去掉后 {a}": "without them {a}",
  " · Top3 亏损占 {b}": " · top-3 losses {b}",

  // -------------------------------------------------- ② 赔率带校准
  "赔率带校准 — 运气还是本事": "Odds-band calibration — luck or skill",
  "入场价本身就是市场定价的获胜概率(隐含胜率)。每档赔率带对比「实际胜率(蓝)vs 隐含胜率(灰)」:实际持续高于隐含(edge>0)才是可复制的优势;只在某一档赔率带赚钱,也说明策略的钱从哪来":
    "The entry price is itself the market-priced probability of winning (implied win rate). Each odds band compares actual win rate (blue) vs implied (grey): actual persistently above implied (edge>0) is the repeatable advantage; profiting in only one band also tells you where the strategy's money comes from",
  实际胜率: "actual win rate",
  "隐含胜率(均入场价)": "implied win rate (avg entry)",
  "右列 = edge 与该档落袋": "right columns = edge and per-band realized PnL",
  "edge = 实际胜率 − 隐含胜率(该桶均入场价)。入场价本身就是市场定价的获胜概率,持续为正才是可复制的优势,而不是运气":
    "edge = actual win rate − implied win rate (the bucket's average entry price). The entry price is itself the market-priced probability of winning; a persistently positive edge is a repeatable advantage, not luck",

  // -------------------------------------------------- ③ 单仓盈亏分布
  单仓盈亏分布: "Per-position PnL distribution",
  "每个点是一笔已结算仓(绿=赢,红=输,灰=平;同值垂直堆叠)。分布形态直接可读:输的一侧是不是都贴着整仓亏光、赢的一侧靠不靠离群大单":
    "Each dot is one settled position (green=win, red=loss, grey=push; equal values stack vertically). The shape reads directly: whether losses cluster at full-stake wipeout, and whether wins lean on outlier big hits",
  "点选或用 Tab 聚焦任意点,查看该仓的市场、盈亏与入场价":
    "Click or Tab-focus any dot to see that position's market, PnL and entry price",
  " · 入场 ": " · entry ",
  单仓盈亏分布散点带: "Per-position PnL dot strip",
  最佳: "best",
  最差: "worst",

  // -------------------------------------------------- ④ 时间走势
  "时间走势 — 优势在衰减吗": "Time trend — is the edge decaying",
  "周度已实现盈亏(UTC 周,绿盈红亏,灰短桩=空窗/打平周);下方把全部结算按时间对半切,前半 vs 后半的胜率与落袋对比是小样本下最诚实的衰减检测":
    "Weekly realized PnL (UTC weeks; green profit, red loss, grey stubs = empty/flat weeks). Below, all settlements are split in half by time — first-half vs second-half win rate and realized PnL is the most honest decay test on a small sample",
  "{d} 那周": "week of {d}",
  "{n} 仓结算": "{n} settled",
  "{d} 那周 · {pnl} · {n} 仓结算": "week of {d} · {pnl} · {n} settled",
  "{d} 那周 {pnl},{n} 仓结算": "week of {d} {pnl}, {n} settled",
  "点选或用 Tab 聚焦任意柱,查看该周的盈亏与结算仓数":
    "Click or Tab-focus any bar to see that week's PnL and settled count",
  周度已实现盈亏柱状图: "Weekly realized PnL bar chart",
  "结算不足 6 仓,前半 vs 后半对比暂不显示":
    "Fewer than 6 settled — first vs second half comparison hidden",
  "前半(更早)": "First half (earlier)",
  "后半(更近)": "Second half (recent)",

  // -------------------------------------------------- ⑤ 持有时长分布
  持有时长分布: "Holding-duration distribution",
  "条长 ∝ 仓数,分段 = 胜(绿)/负(红)/平(灰)。回答钱是在小时级的快市场(in-play 体育)还是几天的慢市场赢的 —— 也是资金周转率的直观读数":
    "Bar length ∝ position count; segments = wins (green) / losses (red) / pushes (grey). Answers whether the money comes from hour-scale fast markets (in-play sports) or day-scale slow ones — also a direct read on capital turnover",

  // -------------------------------------------------- ⑥ 赛道细分
  赛道细分: "Track breakdown",
  "按事件赛道(gamma 事件标签)两级重切:一级行是该赛道全部仓,缩进子行按联盟/资产细分(体育里 NBA 与足球的胜率分布差异巨大,混在一个「体育」桶里没有解释力)。子行不是一级的再分配 —— 无二级标签的仓只进一级汇总":
    "A two-level recut by event track (gamma event tags): each top row is all positions on that track; indented sub-rows split by league/asset (within Sports, NBA and soccer win-rate profiles differ hugely — one 'Sports' bucket explains nothing). Sub-rows are not a re-allocation — positions without a sub-tag enter only the top-level row",
  暂无赛道数据: "No track data yet",

  // ------------------------------------- ⑥.5 赛道胜率分布(气泡象限 + 表)
  "赛道胜率分布 — 气泡象限": "Track win rates — bubble quadrant",
  "横轴 = 隐含胜率(该赛道均入场价,市场定价),纵轴 = 实际胜率;对角线为盈亏平衡 —— 气泡在上方 = 跑赢定价(edge>0)。气泡颜色 = 落袋盈亏(绿 = 赚、红 = 亏),大小 = 仓数,样本 <5 虚线描边。颜色可能与所在区域不同号 —— 位置讲 edge、颜色讲钱(如负 edge 的赛道靠低赔率大赔付仍小幅盈利);下表并列胜率/落袋/edge 三指标,方便逐赛道横比":
    "x = implied win rate (the track's average entry price, i.e. market pricing), y = actual win rate; the diagonal is break-even — a bubble above it beats the pricing (edge>0). Bubble color = realized PnL (green = profit, red = loss), size = position count, dashed outline = sample <5. Color can disagree with the region — position speaks to edge, color to money (a negative-edge track can still net a small profit via low-odds big payouts); the table below lists win rate / realized / edge side by side for cross-track comparison",
  "暂无可上图的赛道(全为平局的赛道没有实际胜率,不硬造 0%)":
    "No tracks to plot (an all-push track has no actual win rate; we don't fabricate 0%)",
  "点选或用 Tab 聚焦任意气泡,查看该赛道的胜率、edge 与落袋":
    "Click or Tab-focus any bubble to see that track's win rate, edge and realized PnL",
  赛道胜率分布气泡象限图: "Track win-rate bubble quadrant chart",
  "▲ 跑赢隐含(edge>0)": "▲ beating implied (edge>0)",
  "▼ 跑输隐含(edge<0)": "▼ trailing implied (edge<0)",
  "{label}:{n} 仓,实际胜率 {a},隐含 {b},落袋 {pnl}":
    "{label}: {n} pos, actual win rate {a}, implied {b}, realized {pnl}",
  "实际胜率 − 隐含胜率(该赛道均入场价)。持续为正才是可复制的优势":
    "Actual win rate − implied win rate (the track's average entry price). Persistently positive = repeatable advantage",
  该赛道已结算仓的累计已实现盈亏:
    "Cumulative realized PnL of settled positions on this track",

  // ------------------------------------ 赛道 edge 矩阵(EdgeMatrixTable)
  "全体样本 {n} 仓": "{n} pos in full sample",
  "{name} × {label}:{n} 仓 {rec},": "{name} × {label}: {n} pos {rec}, ",
  "胜率 {a}% vs 隐含 {b}%,": "win rate {a}% vs implied {b}%, ",
  "落袋 {pnl}": "realized {pnl}",
  ";样本不足,读数仅供方向参考": "; low sample — directional read only",

  // -------------------------------------- ⑦ 缺陷诊断 + 反事实剔除
  "缺陷诊断 — 亏在哪类下注": "Weakness diagnosis — where the losses live",
  "把已结算仓按赛道/持有时长(快慢市场)/赔率带三个维度切段,列出「段内 ≥{n} 仓且累计亏损」的特征段(最亏在前,至多 5 段)—— 定向优化的靶点。⚠️ 各段互有重叠(一仓可同时属「足球」与「>7 天」),「剔除后」数字不可相加":
    "Settled positions are sliced along three dimensions — track / holding duration (fast vs slow markets) / odds band — listing segments with ≥{n} positions and a cumulative loss (worst first, max 5): the targets for directed optimization. ⚠️ Segments overlap (one position can be both 'Soccer' and '>7 d'), so the 'without it' numbers must not be summed",
  "未发现 ≥{n} 仓且累计亏损的特征段 — 样本继续积累中,或这一档暂无集中的亏损特征":
    "No segment with ≥{n} positions and a cumulative loss — the sample is still accruing, or this tier has no concentrated loss pattern yet",
  "对照 · 最强特征(edge>0 且落袋为正 —— 优化是「砍最亏的、 保最强的」两面)":
    "Contrast · strongest segment (edge>0 with positive realized PnL — optimization has two sides: cut the worst, protect the best)",
  "剔除后 → ": "without it → ",
  "edge≥0 · 或为波动": "edge≥0 · likely variance",
  "该段实际胜率并不低于隐含胜率(edge≥0),亏损可能只是短期波动/赔率结构使然 —— 优化前先看样本是否继续恶化,不要对运气过度反应":
    "This segment's actual win rate is not below implied (edge≥0); the loss may just be short-term variance or the odds structure — before optimizing, watch whether it keeps deteriorating rather than over-reacting to luck",
};
