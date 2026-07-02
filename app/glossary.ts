// Single source of truth for every symbol and term the dashboard uses.
// Consumed by BOTH the hover tooltips (Icon in ui.tsx) and the /glossary page,
// so the two can never drift apart. Pure data — client-safe, no node imports.

export interface IconEntry {
  symbol: string;
  name: string;
  // One-line hover tooltip.
  tip: string;
  // Full explanation for the glossary page.
  detail: string;
}

export const ICONS: IconEntry[] = [
  {
    symbol: "💰",
    name: "大额成交",
    tip: "大额成交：单笔金额达到告警阈值（默认 ≥$10k）",
    detail:
      "单笔名义金额（份额 × 价格）达到告警阈值的成交，默认 ≥$10,000。这是最基础的信号层：钱包一次性打出的大单。",
  },
  {
    symbol: "🐳",
    name: "巨鲸单",
    tip: "巨鲸单：单笔 ≥$50k 的顶级大额成交",
    detail:
      "单笔 ≥$50,000 的成交，大额成交里的顶级档位。阈值分层可在 .env 的 LARGE_THRESHOLDS 配置（默认 10000,50000）。",
  },
  {
    symbol: "🧩",
    name: "拆单累计",
    tip: "拆单累计：多笔小单累积出的净买入（每笔都低于大单阈值）",
    detail:
      "同一钱包在同一（市场 · 结果）上用多笔小额订单累积出的净买入仓位——每一笔都刻意低于单笔告警阈值，逃过单笔监控。实测单笔监控会漏掉约 60% 的 ≥$10k 累计建仓者，拆单累计榜就是为抓这批人而生。",
  },
  {
    symbol: "🆕",
    name: "新钱包",
    tip: "新钱包：地址年龄 ≤30 天（红色 = <7 天）",
    detail:
      "地址年龄 = 该钱包首次 Polymarket 链上活动至今的时长。≤30 天显示确切天数并标 🆕，<7 天红色高亮，<1 天精确到小时/分钟。为一笔交易专门开新钱包是最强的内幕信号之一。年龄永久缓存（出生时间不会变）。",
  },
  {
    symbol: "🏆",
    name: "聪明钱（白名单）",
    tip: "聪明钱：官方盈利榜自动播种的高盈利白名单钱包",
    detail:
      "每日自动从 Polymarket 官方盈利排行榜（周榜/月榜/总榜）播种的高盈利钱包池，并用已结算战绩（/closed-positions）富集出 0-100 评分。命中白名单的成交在告警和表格里都会打上 🏆。30 天未再上榜的自动过期；手动加入的永久保留。",
  },
  {
    symbol: "🔥",
    name: "聪明钱共识",
    tip: "共识：≥2 个白名单钱包同向买入同一结果",
    detail:
      "时间窗内 ≥2 个互不相同的白名单钱包，各自净买入 ≥$5,000 同一市场的同一结果。几个高胜率钱包独立得出同一结论，比任何单笔巨鲸单都更有说服力。只在共识形成和升级（又一个钱包加入）时推送，不重复轰炸。",
  },
  {
    symbol: "✅",
    name: "结算命中",
    tip: "结算命中：该告警方向押对了最终结算",
    detail:
      "该告警对应市场已结算，且方向押对：BUY 的结果结算为 1，或 SELL 的结果结算为 0。",
  },
  {
    symbol: "❌",
    name: "结算落空",
    tip: "结算落空：该告警方向押错了最终结算",
    detail: "市场已结算且方向押错。与 ✅ 一起构成告警的最终成绩单。",
  },
  {
    symbol: "➖",
    name: "平局结算",
    tip: "平局：市场以 50/50 结算（取消/平局裁决），不计入胜率",
    detail:
      "市场按规则以 50/50 结算（赛事取消、平局裁决等），买卖双方都按 0.5 退款。不计入命中率统计的分母。",
  },
  {
    symbol: "📐",
    name: "信号验证",
    tip: "信号验证：告警发出后 1h/24h 价格走势与结算回填",
    detail:
      "验证闭环：每条告警自动回填信号发出后 1 小时 / 24 小时的市场价格变化（按方向着色）与最终结算结果，页面顶部汇总出方向命中率和已结算胜率——让工具为自己的信号打分。数据按需查询公开历史价格，不依赖归档。",
  },
  {
    symbol: "↗",
    name: "链上记录",
    tip: "跳转 Polygonscan 查看该笔成交的链上交易",
    detail: "跳转 Polygonscan 查看该笔成交对应的链上交易哈希。",
  },
  {
    symbol: "…",
    name: "加载中",
    tip: "数据加载中：按需查询上游并缓存，稍候自动补全",
    detail:
      "该字段正在惰性加载：战绩、地址年龄等数据按需查询 Polymarket 公开 API 并缓存，首次出现的钱包需要几秒，之后即时。",
  },
];

export interface TermEntry {
  term: string;
  detail: string;
}

export const TERMS: TermEntry[] = [
  {
    term: "战绩",
    detail:
      "钱包在已结算市场上的历史表现：胜率（盈利仓位占比）· 已实现盈亏（USD）。悬停可见已结算市场数与 ROI。来自 /closed-positions 的全量已结算仓位，缓存 24 小时。",
  },
  {
    term: "ROI",
    detail:
      "已实现盈亏 ÷ 成本。成本 = 买入份额 × 平均买入价（注意 Polymarket API 的 totalBought 是份额而非美元）。",
  },
  {
    term: "净买入",
    detail:
      "买入额 − 卖出额，按（钱包 · 市场 · 结果）聚合。买卖对倒后剩下的才是真实方向敞口。",
  },
  {
    term: "建仓均价（加权均价）",
    detail:
      "按金额加权的平均买入价，即该仓位的平均赔率。0.5–0.9 区间是内幕资金最偏好的甜区——赔率有利且事件尚未定局。",
  },
  {
    term: "占24h量（冲击占比）",
    detail:
      "该笔金额 ÷ 市场 24 小时成交量。$15k 打进日成交 $30k 的冷门市场（50%）远比 $100k 打进大选主市场（<1%）有信息量——衡量'这笔钱对这个市场意味着什么'。",
  },
  {
    term: "流动性",
    detail:
      "市场当前的挂单深度（来自 Gamma API），金额相同冲击占比越高越异常。",
  },
  {
    term: "距结算",
    detail:
      "距市场结束时间的剩余小时数。内幕信息的价值随结算临近急剧升值，知情者常在最后几小时突击进场——告警条件里可设'距结算 ≤N 小时'。",
  },
  {
    term: "跟单空间",
    detail:
      "现价 − 聪明钱建仓均价。差距 ≤5¢ 显示'仍可跟'（还能以接近聪明钱的成本跟进），更大显示'已跑'（价格已被推走）。",
  },
  {
    term: "评分（0-100）",
    detail:
      "聪明钱综合评分：盈利规模最多 40 分（$1m+ 满分）+ 资金效率 pnl/vol 最多 30 分（10%+ 满分，区分真信号与高频做市）+ 已结算胜率最多 30 分。可解释、非黑盒。",
  },
  {
    term: "共识形成 / 升级",
    detail:
      "首次凑齐 N 个白名单钱包同向买入为'形成'，之后又有钱包加入为'升级'——只在这两种时刻推送告警；同一共识 6 小时内不重复提醒。",
  },
  {
    term: "24h 方向命中",
    detail:
      "信号发出 24 小时后价格是否朝该方向移动（BUY 后上涨 / SELL 后下跌 = 命中）。绿色 = 方向正确，红色 = 方向错误。",
  },
  {
    term: "内幕猎杀组合",
    detail:
      "价格 0.5–0.9 + 地址年龄 ≤7 天的筛选组合（可再叠加距结算 ≤N 小时）：异常内幕资金倾向于用新钱包、在有利赔率、临近结算时买入——三个条件叠加能把成交洪流收敛成一张嫌疑名单。",
  },
  {
    term: "颜色语义",
    detail:
      "全站统一：绿色 = 买入 / 上涨 / 盈利，红色 = 卖出 / 下跌 / 亏损，琥珀色 = 赔率与警示信息。",
  },
];

const tipMap = new Map(ICONS.map((e) => [e.symbol, e.tip]));

// Hover text for a symbol; empty string when the symbol has no entry.
export const iconTip = (symbol: string): string => tipMap.get(symbol) ?? "";
