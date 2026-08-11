import { detectConsensus } from "./consensus";
import type {
  DetectorCtx,
  FollowCandidate,
  StrategyParams,
} from "./followCandidate";
import { excludeContestedFromConsensus } from "./marketSignals";
import type { Trade } from "./types";

/**
 * 族 A:共识候选。这一版是 runFollowCycle 原有逻辑(follow.ts:263-296)的等价提取 ——
 * 每策略各跑一次 detectConsensus(不能用最松阈值跑一次再复筛:formationTs 的跨线
 * 时刻依赖该策略自己的 minPerWalletUsd)、分歧互斥、新鲜度闸门,顺序与语义完全不变。
 *
 * formationTs = g.formationTs(第 minWallets 个合格钱包跨线时刻)。不能用 lastTs ——
 * 后者被组内任何白名单成交(含 SELL、含不达标非成员)刷新,会把老共识"续命"成新鲜。
 * referencePrice = g.avgBuyPrice(聪明钱加权均价)。
 */
export function detectConsensusCandidates(
  trades: Trade[],
  params: StrategyParams,
  ctx: DetectorCtx,
): FollowCandidate[] {
  const { minWallets, minPerWalletUsd } = params;
  if (minWallets == null || minPerWalletUsd == null) {
    console.warn(
      "[follow/consensus] minWallets/minPerWalletUsd 缺失,本策略本轮无候选",
    );
    return [];
  }
  const groups = detectConsensus(trades, ctx.smart, {
    minWallets,
    minPerWalletUsd,
  });
  const uncontested = excludeContestedFromConsensus(groups, ctx.contested);
  const dropped = groups.length - uncontested.length;
  if (dropped > 0) {
    console.log(
      `[follow/consensus] 分歧互斥:剔除 ${dropped} 个单边共识组(聪明钱两边都买 → 不跟)`,
    );
  }
  const fresh = uncontested.filter(
    (g) => ctx.nowSec - g.formationTs <= params.freshSec,
  );
  const stale = uncontested.length - fresh.length;
  if (stale > 0) {
    console.log(
      `[follow/consensus] 新鲜度闸门:跳过 ${stale} 个陈旧共识组(formationTs 距 now > ${params.freshSec}s),不补开历史`,
    );
  }
  return fresh.map((g) => ({
    conditionId: g.conditionId,
    outcome: g.outcome,
    outcomeIndex: g.outcomeIndex,
    asset: g.asset,
    title: g.title,
    slug: g.slug,
    eventSlug: g.eventSlug,
    formationTs: g.formationTs,
    referencePrice: g.avgBuyPrice,
    sourceKind: "consensus" as const,
    walletCount: g.walletCount,
    totalNetUsd: g.totalNetUsd,
  }));
}
