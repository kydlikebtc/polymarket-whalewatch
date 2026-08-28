// /pulse 市场脉搏字典分片 —— 键=中文原文,值=英文译文。
// 导航标签(市场脉搏/市场校准)也在这里:两页同批出生,共享一个分片。
export const DICT_PULSE: Record<string, string> = {
  市场脉搏: "Market Pulse",
  "每 UTC 日收盘后重建的市场级聚合：谁在异动、小单与鲸鱼是否站在对立面。":
    "Market-level aggregates rebuilt after each UTC close: what moved abnormally, and whether small orders and whales are on opposite sides.",
  "数据到 {d}（UTC）· 底座已积累 {n} 天":
    "Data through {d} (UTC) · {n} day(s) accumulated",
  "加载失败：{err}": "Failed to load: {err}",
  "尚无聚合数据 —— 底座从部署后的第一个完整 UTC 日开始积累，明天再来。":
    "No aggregates yet — the base starts accumulating with the first full UTC day after deployment. Come back tomorrow.",
  "该日窗口在分页上限处被截断，覆盖不完整 —— 以下数字是下界，不是全量。":
    "That day's window hit the pagination cap, so coverage is incomplete — the figures below are lower bounds, not totals.",

  异常市场日榜: "Daily anomaly board",
  "该日无达到材料性门槛（$10k 总量）的市场。":
    "No market cleared the materiality floor ($10k volume) that day.",
  异常分: "Anomaly",
  构成: "Components",
  量能: "Volume",
  单边: "One-sided",
  鲸鱼: "Whale",
  价移: "Move",
  "顶结果首→末价": "Top outcome first→last",
  "量能为其 {n} 日均值的 {r} 倍": "volume {r}× its {n}-day mean",

  "小单 vs 鲸鱼 · 方向分歧": "Small orders vs whales · directional split",
  "该日无达到双边材料性门槛的方向分歧。":
    "No directional split cleared both materiality floors that day.",
  小单在买: "Small orders buying",
  鲸鱼在买: "Whales buying",
  分歧强度: "Split strength",

  "口径：小单 = 单笔 $2k–10k（抓取下限之下的真散户不可见，因此只说「小单」）；鲸鱼 = 单笔 ≥$50k，与 heavy 信号同一把尺；异常分 = 0.35·量能异动 + 0.25·单边度 + 0.20·鲸鱼占比 + 0.20·日内价移，各分量 0–1 可逐项核对；量能异动在同市场基线不足 3 天时退化为当日横截面分位。":
    "Definitions: small = $2k–10k per fill (true retail below the fetch floor is invisible, hence “small orders”, never “retail”); whale = ≥$50k per fill, the same yardstick as heavy signals; anomaly = 0.35·volume surge + 0.25·one-sidedness + 0.20·whale share + 0.20·intraday move, each component 0–1 and individually inspectable; volume surge falls back to the day's cross-sectional percentile when a market has under 3 baseline days.",
  // 确信指数(第一梯队五件套,2026-08-28)
  "确信指数 · 品类激辩度": "Conviction index · category contention",
  "高 = 激辩/恐慌（阵营对峙、小单与鲸鱼对立、价格动荡、量能异动），低 = 确信（一边倒、平静）。VIX 语义，逐品类按日合成。":
    "High = contention/fear (split camps, small-vs-whale opposition, price churn, volume surge); low = conviction (one-sided, calm). VIX semantics, composed per category per day.",
  品类: "Category",
  指数: "Index",
  "近 {n} 日": "Last {n} days",
  市场数: "Markets",
  对峙: "Contest",
  对立: "Opposition",
  "确信指数 = 0.30·阵营对峙（量能加权 1−单边度）+ 0.30·对立度（合格分歧市场量能占比，双边门槛与上表同尺）+ 0.20·价格动荡 + 0.20·量能异动；品类日总量 <$10k 不给分；量能异动在品类自身基线不足 3 天时退化为当日横截面分位。":
    "Conviction index = 0.30·contest (volume-weighted 1−one-sidedness) + 0.30·opposition (volume share of qualifying divergence markets, same two-sided floors as the table above) + 0.20·price churn + 0.20·volume surge; category-days under $10k total get no score; volume surge falls back to same-day cross-sectional percentile when the category has fewer than 3 baseline days.",
  // 无鲸异动 + 洗量榜(第二梯队八件套,2026-08-28)
  "无鲸异动 · 没人付大钱的剧烈价移": "Ghost moves · big swings nobody paid big for",
  "价移 ≥10¢ 但当日没有任何一笔 ≥$10k —— 要么簿子薄到小单就能推，要么有人在蚂蚁搬家。":
    "Price moved ≥10¢ with no single fill ≥$10k all day — either the book is thin enough for small orders to push, or someone is accumulating ant-style.",
  "洗量榜 · 同钱包当日往返": "Wash board · same-wallet round trips",
  "同一钱包在同一市场当日既买又卖的配对量占比（双腿口径）。是结构描述不是指控——做市、调仓也长这样；把它当「这个市场的量能里有多少不是方向性意见」来读。":
    "Share of volume matched between buys and sells by the same wallet in the same market that day (both legs counted). A structural description, not an accusation — market making and rebalancing look the same; read it as \"how much of this market's volume is not a directional opinion\".",
  // 「价移」沿用本分片既有 chip 键;「单笔最大」沿用 accumulation 分片
  // 既有译文("Max Single")—— 跨分片同键必须同值。
  "首→末价": "First→last",
  "洗量占比": "Wash share",
  "配对量": "Matched",
  "洗量占比 {p}%": "wash {p}%",
  "无鲸异动 = 价移 ≥10¢ 且当日单笔最大 <$10k（判定材料 2026-08-28 起采集，之前的日份不进榜）；洗量占比 = 同钱包当日买卖配对量 ×2 ÷ 总量，只统计单笔 ≥$2k 的抓取窗口。":
    "Ghost move = ≥10¢ move with max single fill <$10k that day (the material is collected from 2026-08-28; earlier days never chart); wash share = same-wallet matched buy/sell volume ×2 ÷ total, within the ≥$2k fetch window.",
};
