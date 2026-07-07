import type { ConsensusGroup, ConsensusOptions } from "./consensus";
import type { Trade } from "./types";

// 纸面跟单的单仓 / 策略 / 价格纯函数。全部无副作用,便于 TDD 与复用。
// 约定:所有单仓函数一律「价在前、size 在后」,避免同为 number 的实参误序时
// 编译不报错(footgun)。

/**
 * 以 entryPrice 单价、sizeUsd 美元买入所得份额数。
 * entryPrice<=0(缺价/异常)时返回 0,防止除零产生 Infinity/NaN 污染下游求和。
 */
export function positionShares(entryPrice: number, sizeUsd: number): number {
  return entryPrice > 0 ? sizeUsd / entryPrice : 0;
}

/**
 * 单仓已实现盈亏 = 份额 * (退出价 - 入场价)。
 * 结算 1(赢)时 = +size 的收益方向,结算 0(输)时 = -size(整仓亏光)。
 */
export function positionRealizedPnl(
  entryPrice: number,
  exitPrice: number,
  sizeUsd: number,
): number {
  const shares = positionShares(entryPrice, sizeUsd);
  return shares * (exitPrice - entryPrice);
}

/**
 * 跟单滑点(美元)= 份额 * (自己入场价 - 聪明钱均价)。
 * 我们跟进时比聪明钱买得更贵(entryPrice>smartAvgPrice)为正 —— 即多付出的成本。
 */
export function positionSlippage(
  entryPrice: number,
  smartAvgPrice: number,
  sizeUsd: number,
): number {
  const shares = positionShares(entryPrice, sizeUsd);
  return shares * (entryPrice - smartAvgPrice);
}

/**
 * 策略阈值二次过滤:detectConsensus 在最松阈值下产出 groups,这里按某具体策略的
 * minPerWalletUsd / minWallets 复筛 —— 每组内净买入 >= floor 的钱包数达到 minWallets
 * 才保留。纯函数,不修改入参。
 * 复用 ConsensusOptions(结构同构;策略对象可携带 sizeUsd/exitRule 等额外字段,
 * 结构兼容,此处只读 minWallets/minPerWalletUsd,多余字段无碍)。
 */
export function qualifyingGroups(
  groups: ConsensusGroup[],
  strat: ConsensusOptions,
): ConsensusGroup[] {
  return groups.filter(
    (g) =>
      g.wallets.filter((w) => w.netUsd >= strat.minPerWalletUsd).length >=
      strat.minWallets,
  );
}

/**
 * 窗口内每个 asset 的最近一笔成交价 —— 入场价的回退来源(当无更精确报价时)。
 * 按 timestamp 严格取最大者对应的 price —— 生产窗口成交是 newest-first 排序
 * (lib/polymarket.ts 对 trades 做 b.timestamp - a.timestamp),故不能退化成
 * 「取数组末元素/last-wins」(那会返回最旧价)。严格 `>` ⇒ 时间戳相等时先见者胜
 * (与 newest-first 顺序一致,保留最先出现即最新的那笔)。
 */
export function latestPriceByAsset(trades: Trade[]): Map<string, number> {
  const latestTs = new Map<string, number>();
  const price = new Map<string, number>();
  for (const t of trades) {
    const prev = latestTs.get(t.asset);
    if (prev == null || t.timestamp > prev) {
      latestTs.set(t.asset, t.timestamp);
      price.set(t.asset, t.price);
    }
  }
  return price;
}
