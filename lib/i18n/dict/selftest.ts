// 聪明钱自测分片 —— 键=中文原文,值=英文译文。
// 覆盖 /selftest 落地页、共享判决卡(app/selfTestCard.tsx)与档案页判决块。
// 「已结算胜率 / 净盈亏 / 评分 / 已复制 / 立即重试 / 加载失败 / {n}s 后
// 自动重试」等跨页同键直接复用既有分片(同键同值纪律),不在此重复。
export const DICT_SELFTEST: Record<string, string> = {
  // -------- 页面骨架与入口(NAV label 与页面标题同键)
  聪明钱自测: "Smart-money self-test",
  "📐 按池准入口径的战绩体检":
    "📐 Track-record checkup against the pool-admission bar",
  "把你的钱包放进本站同一把尺子：过没过闸、在池成员里排第几、一张可分享的判决卡。":
    "Put your wallet under this site's yardstick: pass or not, where you rank among pool members, and a shareable verdict card.",
  口径声明: "Basis statement",
  "粘贴一个 0x 开头的钱包地址，按聪明钱池的准入口径领一份判决书。":
    "Paste a wallet address starting with 0x and get a verdict against the smart-money pool-admission bar.",
  "先看看池内成员 →": "Browse pool members first →",
  "口径声明：这是按本站池准入口径的战绩体检，不是资质认证，也不是投资建议。样本 = Polymarket 公开接口可见的已结算持仓（最多约 1000 仓，超出即截断、判决降级「样本不可判」）；分位样本 = 本站当前池成员（按本站口径挑选，非全体交易者）。":
    "Basis statement: this is a track-record checkup against this site's pool-admission bar — not certification, not investment advice. Sample = settled positions visible through Polymarket's public APIs (up to ~1000; beyond that the record is truncated and the verdict degrades to \"unjudgeable\"); percentile sample = this site's current pool members (picked by our own bar, not all traders).",
  "0x 开头的 Polymarket 钱包地址": "Polymarket wallet address starting with 0x",
  领取判决书: "Get the verdict",
  "体检中…": "Checking…",
  "地址格式不对——应为 0x 开头的 42 位十六进制。":
    "Invalid address — expected 0x followed by 40 hex characters.",
  "新地址首次体检要拉取全部已结算持仓，约需几秒；重测走 24 小时判决缓存，即时返回。":
    "A first checkup for a new address pulls its full settled history and takes a few seconds; re-tests hit the 24-hour verdict cache and return instantly.",
  "⏳ 实时体检被限流（公共接口预算已满）——先展示本地留存判决。":
    "⏳ Live checkup rate-limited (public API budget exhausted) — showing the locally stored verdict first.",
  "⚠️ 上游接口暂时不可用——先展示本地留存判决。":
    "⚠️ Upstream API temporarily unavailable — showing the locally stored verdict first.",

  // -------- 判决词(「没过」与「判不了」严格分家)
  // 判决卡改版后徽章与句子分家:徽章短且上色(五类语义固定),句子中性。
  "✅ 过闸": "✅ PASS",
  "按本站准入口径，这份战绩过了聪明钱池的门槛。":
    "By this site's admission basis, this record clears the smart-money pool bar.",
  "❌ 未过闸": "❌ BELOW BAR",
  "样本足够、判得出，但两条路都没到线。":
    "The sample is sufficient and judgeable, but neither path clears the line.",
  "🤖 不适用": "🤖 N/A",
  "高频做市 / 机器人画像，胜率口径对它无意义。":
    "HF market-maker / bot profile; the win-rate basis is meaningless for it.",
  "⚖️ 样本不可判": "⚖️ UNJUDGEABLE",
  "已结算市场过多，只能取到按盈亏排序的最赚一部分（赢家偏差），胜率 / ROI 无法可靠统计。":
    "Too many settled markets; only the most profitable slice (profit-sorted, winner-biased) could be fetched, so win rate / ROI cannot be measured reliably.",
  "⚖️ 样本不足": "⚖️ LOW SAMPLE",
  "已结算市场少于 {n} 个，两条路的最低样本线都没到。":
    "Fewer than {n} settled markets — below the minimum sample line of both paths.",
  "⚖️ 暂不可判": "⚖️ NOT JUDGEABLE YET",
  "净盈亏暂不可得，按闸门纪律拒绝凭部分数据下判。":
    "Net P/L unavailable; by gate discipline we refuse to judge on partial data.",
  "⚠️ 暂无数据": "⚠️ NO DATA",
  "上游接口暂时取不到这份战绩——稍后再试":
    "Upstream APIs can't fetch this record right now — try again later",

  // -------- 分位与元信息
  "池内前 {p}% · 样本 {n}": "Top {p}% in pool · sample {n}",
  "超过池内约 {p}% 成员 · 样本 {n}": "Above ~{p}% of pool members · sample {n}",
  "🏆 已在池内": "🏆 In pool",
  "🏆 该地址已在本站聪明钱池内（分位含自身）":
    "🏆 This address is already in the smart-money pool (percentiles include itself)",
  // 「前 X%」是 midrank 分位的镜像换算,换算规则与「分位含自身」都写在卡底
  // 那条灰底口径条里(桌面 hover 的裸 title 触屏读不到,口径不能藏)。
  "「池内前 X%」= 池内约 X% 的成员不低于你（同值各算一半）":
    '"Top X% in pool" = about X% of members are not below you (ties split evenly)',
  "该地址已在池内，分位含自身":
    "This address is already in the pool, so the percentiles include it",
  // 「已结算 {n} 仓」不在此片:与 follow 分片同键同值,统一由那片提供。
  "判决计算于 {at}": "Verdict computed {at}",
  "战绩数据截至 {at}": "Record data as of {at}",
  "分位样本 = 当前池 {n} 名成员（按本站口径挑选，非全体交易者）":
    "Percentile sample = current pool of {n} members (picked by this site's own bar, not all traders)",

  // -------- 口径展示(数字来自 admissionGate 常量,不硬编码)
  准入口径: "Admission bar",
  "· 两条路满足其一": "· either path qualifies",
  // 「❌ 未到线」只在闸门明确判定 fail(两条路都没到线)时出;pass 时闸门
  // 不告诉我们走的是哪一条,展示层不复算,所以下面两个键暂时没有调用点
  // (等服务端补 admittedPath 字段后原样复用,不重编)。
  "❌ 未到线": "❌ Below the line",
  "✅ 走这条过的": "✅ cleared via this path",
  未走这条: "Not this path",
  "卡内 — 是「判不了」不是零：做市商或截断样本下胜率 / ROI 被判为不可用，池内该轴没有可比成员时分位同样不出数。":
    'A "—" on this card means "can\'t judge", not zero: for market makers or truncated samples the win rate / ROI are marked unusable, and a percentile is likewise withheld when the pool has no comparable members on that axis.',
  "① 已结算 ≥{n} 市场 · 胜率 ≥{p}% · 净盈亏为正":
    "① ≥{n} settled markets · win rate ≥{p}% · positive net P/L",
  "② 已结算 ≥{n} 市场 · ROI ≥{p}% · 净盈亏为正":
    "② ≥{n} settled markets · ROI ≥{p}% · positive net P/L",
  "池准入另有「30 天 ≥3 个不同市场」的复发证据要求——那是发现渠道的候选资格，不在自测范围；自测通过 ≠ 自动入池。":
    "Pool admission additionally requires recurrence evidence (≥3 distinct markets in 30 days) — that is the discovery channels' candidacy gate, out of scope for the self-test; passing here ≠ automatic pool entry.",

  // -------- 操作
  "查看完整档案 →": "Full dossier →",
  复制嵌入卡代码: "Copy embed code",
  "预览嵌入卡 ↗": "Preview embed card ↗",

  // -------- 档案页判决块
  聪明钱自测判决: "Smart-money self-test verdict",
  "按池准入口径给这份战绩一个判决：过没过闸、池内百分位、可分享判决卡。点击加载。":
    "Judge this record against the pool-admission bar: pass or not, pool percentiles, and a shareable verdict card. Click to load.",
  加载判决: "Load verdict",
};
