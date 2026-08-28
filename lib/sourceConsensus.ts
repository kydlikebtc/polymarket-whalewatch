import { detectConsensus } from "./consensus";
import type {
  DetectorCtx,
  FollowCandidate,
  StrategyParams,
} from "./followCandidate";
import { excludeContestedFromConsensus } from "./marketSignals";
import type { Trade } from "./types";

/**
 * 族 A:共识候选。这一版是 runFollowCycle 原有的 freshByStrategy 循环段的等价提取 ——
 * 每策略各跑一次 detectConsensus(不能用最松阈值跑一次再复筛:formationTs 的跨线
 * 时刻依赖该策略自己的 minPerWalletUsd)、分歧互斥、新鲜度闸门,顺序与语义完全不变。
 *
 * formationTs = g.formationTs(第 minWallets 个合格钱包跨线时刻)。不能用 lastTs ——
 * 后者被组内任何白名单成交(含 SELL、含不达标非成员)刷新,会把老共识"续命"成新鲜。
 * referencePrice = g.avgBuyPrice(聪明钱加权均价)。
 *
 * A3/A4(均为可选门槛,未配置时对 A1/A2 两条生产策略零影响):
 *  - minWalletScore(质量轴):只把 score>=阈值的钱包计入「合格钱包」。
 *  - minTotalNetUsd(总额轴):不看人数,看总净买是否达标;若同一策略也配了
 *    minWalletScore,判断的是质量过滤之后的总额,不是原始总额 —— 见下方
 *    实现处对这个不对称的详细说明。
 */
export function detectConsensusCandidates(
  trades: Trade[],
  params: StrategyParams,
  ctx: DetectorCtx,
): FollowCandidate[] {
  const { minWallets, minPerWalletUsd } = params;
  if (minWallets == null || minPerWalletUsd == null) {
    console.warn(
      `[follow] strategy ${params.id} (consensus) minWallets/minPerWalletUsd 缺失,本策略本轮无候选`,
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
      `[follow] strategy ${params.id} 分歧互斥:剔除 ${dropped} 个单边共识组(聪明钱两边都买 → 不跟)`,
    );
  }
  const fresh = uncontested.filter(
    (g) => ctx.nowSec - g.formationTs <= params.freshSec,
  );
  const stale = uncontested.length - fresh.length;
  if (stale > 0) {
    console.log(
      `[follow] strategy ${params.id} 新鲜度闸门:跳过 ${stale} 个陈旧共识组(formationTs 距 now > ${params.freshSec}s),不补开历史`,
    );
  }

  // A3 质量门槛(minWalletScore):score 是 ConsensusWallet 已经带的字段,
  // detectConsensus 从没拿它做过门槛。score===null(未知)视为不达标 ——
  // 与 walletStats「不把未知当合格」的既有纪律一致,宁可漏跟不可误开。
  //
  // walletCount 与 totalNetUsd 都要重算(只算够分的钱包),但 referencePrice
  // (=g.avgBuyPrice)不重算 —— 这个不对称是刻意的:
  //  - walletCount/totalNetUsd 表达的是「这一档看到的信号强度」:不够分的
  //    钱包在这一档的语义里不算数,所以只算够格的那些(totalNetUsd 用与
  //    detectConsensus 完全相同的公式 sum(wallets.netUsd),只是求和范围从
  //    「全体 qualified」收窄到「score 达标的 qualified」,口径不漂移)。
  //  - referencePrice 表达的是「聪明钱的成本基准」,用途是算我们相对市场
  //    买贵了多少(positionSlippage 的减数 + 进场偏离护栏的基准)。用全体
  //    聪明钱的加权均价比用筛选后子集的更贴近"市场上聪明钱的平均成本"这个
  //    语义 —— 我们要衡量的是自己的执行相对整个知情资金的位置,不是相对
  //    某个筛选子集的位置。
  const scored =
    params.minWalletScore == null
      ? fresh
      : fresh
          .map((g) => ({
            g,
            qualified: g.wallets.filter(
              (w) => w.score != null && w.score >= params.minWalletScore!,
            ),
          }))
          .filter((x) => x.qualified.length >= minWallets)
          .map((x) => ({
            ...x.g,
            wallets: x.qualified,
            walletCount: x.qualified.length,
            totalNetUsd: x.qualified.reduce((s, w) => s + w.netUsd, 0),
          }));
  const scoreGated = fresh.length - scored.length;
  if (scoreGated > 0) {
    console.log(
      `[follow] strategy ${params.id} 质量门槛:剔除 ${scoreGated} 个共识组` +
        `(score>=${params.minWalletScore} 的钱包不足 ${minWallets} 个)`,
    );
  }

  // A4 总额门槛(minTotalNetUsd):不看人数,看总净买。用的是 scored 里(若配了
  // A3)已经按质量过滤重算过的 totalNetUsd —— 与 A3「不够分不算数」的语义
  // 保持一致,不能拿全体钱包的总额去判断,否则两个门槛会互相打架。
  const sized =
    params.minTotalNetUsd == null
      ? scored
      : scored.filter((g) => g.totalNetUsd >= params.minTotalNetUsd!);
  const totalGated = scored.length - sized.length;
  if (totalGated > 0) {
    console.log(
      `[follow] strategy ${params.id} 总额门槛:剔除 ${totalGated} 个共识组` +
        `(总净买 < $${params.minTotalNetUsd})`,
    );
  }

  return sized.map((g) => ({
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
    // 向前落库快照:qualified 集合原样投影(netUsd 降序沿用组内排序),score
    // 是检测时 ctx.smart 可见的分 —— 纯归因,开仓判定与上面各闸零关系。
    wallets: g.wallets.map((w) => ({
      wallet: w.wallet,
      netUsd: w.netUsd,
      score: w.score,
    })),
  }));
}
