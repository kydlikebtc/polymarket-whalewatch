import { rateLimit } from "./apiGuard";

// 市场深度卡的上游预算。两条判断,顺序不能反:
//
//  1. **闸门计量的是「续抓次数」而非「请求次数」** —— 既有的 guardExpensive 限的
//     是请求数 N,而上游成本取决于去重后的市场数 M。窗口层早把同 cid 的并发合并
//     成一次续抓,真正要命的是「三百个人各看一个不同市场」。限错维度的闸门拦得住
//     免费的那种滥用,拦不住花钱的那种。
//
//  2. **额度从属引擎健康度** ——「服务性能允许的范围」不该是拍脑袋的常数。判据
//     仓库里现成:heartbeats 记着每个循环的年龄与超时线,evaluateHealth 算得出
//     staleLoops。引擎断更时继续取令牌是在加深故障 —— 断更的原因很可能正是
//     data-api 被挤爆。引擎永远优先:它死了,卡片再新鲜也没有意义。

/**
 * 满额:引擎稳态(~20–25 req/min)的 4 倍。热续恒 1 请求,故这个数同时就是
 * 每分钟可刷新的市场次数 —— 30s 新鲜度下约等于 50 个同时被盯着的市场。
 */
export const CARD_BUDGET_PER_MIN = 100;

/** 漂移线:循环年龄超过它自己 staleAfter 的这个比例,就算开始喘。 */
const DRIFT_RATIO = 0.6;
const DRIFT_BUDGET_FACTOR = 0.25;

export interface BudgetHealth {
  staleLoops: string[];
  loops: { ageSec: number | null; staleAfterSec: number }[];
}

/** 本刻允许的每分钟续抓次数。0 = 只发降级。 */
export function budgetFor(health: BudgetHealth): number {
  if (health.staleLoops.length > 0) return 0;
  // 最坏的那个循环说了算,不是平均 —— 一个循环喘不过气就够了。
  // ageSec 为 null 的循环不参与:没数据不等于在漂移。
  const worst = health.loops.reduce((m, l) => {
    if (l.ageSec == null || l.staleAfterSec <= 0) return m;
    return Math.max(m, l.ageSec / l.staleAfterSec);
  }, 0);
  if (worst >= DRIFT_RATIO) {
    return Math.floor(CARD_BUDGET_PER_MIN * DRIFT_BUDGET_FACTOR);
  }
  return CARD_BUDGET_PER_MIN;
}

/**
 * 取一枚续抓令牌。复用 apiGuard 的滑窗计数器(同一进程、同一姿态)。
 * 注意其语义:**被拒的调用同样计数** —— 那正是「压力下自我收敛」想要的,
 * 与 guardExpensive「两级都记账,不短路」是同一条理由。
 */
export function takeCardToken(
  limit: number,
  cost = 1,
  nowMs = Date.now(),
): boolean {
  if (limit <= 0) return false;
  return rateLimit(
    "market-card:__upstream__",
    limit,
    60_000,
    nowMs,
    Math.max(1, Math.floor(cost)),
  );
}
