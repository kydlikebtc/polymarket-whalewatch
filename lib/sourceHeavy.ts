import type {
  DetectorCtx,
  FollowCandidate,
  StrategyParams,
} from "./followCandidate";
import { dedupKey, notionalUsd } from "./trades";
import type { Trade } from "./types";

/**
 * 族 B:单笔巨额买入。判据对齐推送侧的 signalFeed.foldHeavy —— 单个白名单钱包
 * 单笔 BUY notional >= minSingleFillUsd(生产阈值 $50k)。这一族上线即补上
 * 「推了不跟」的核心盲区:推送有三种 SignalKind,跟单此前只接了 consensus 一种。
 *
 * 与 foldHeavy 的**唯一有意差异**:不继承「consensus 已覆盖该 market+outcome 就
 * 抑制」那条规则。那是展示逻辑(一个市场不占两张卡),而跟单要的是归因逻辑 ——
 * 只有让 B 族与 A 族在同一市场各开各的仓,才能对比「共识 vs 单笔巨鲸谁更准」;
 * 抑制掉等于让 heavy 只在 consensus 失败的市场取样,样本被系统性偏置。代价是
 * 跨档持仓重叠(设计文档 §9.1 已声明:各档战绩不可相加)。
 *
 * 不受分歧互斥约束:heavy 的语义是「这一笔单本身就是信号」,不依赖别的聪明钱
 * 怎么想。因市场有争议就不跟,等于用 consensus 的世界观去审查 heavy 的信号,
 * 还会让 B 族只在无争议市场取样(样本系统性偏置)。故本函数故意不读 ctx.contested。
 *
 * formationTs = 那一笔的 timestamp(单笔信号,无"形成过程",天然精确)。
 * referencePrice = 那一笔的成交价。
 */
export function detectHeavyCandidates(
  trades: Trade[],
  params: StrategyParams,
  ctx: DetectorCtx,
): FollowCandidate[] {
  const floor = params.minSingleFillUsd;
  if (floor == null || floor <= 0) {
    console.warn(
      `[follow] strategy ${params.id} (heavy) minSingleFillUsd 缺失或非正,本策略本轮无候选`,
    );
    return [];
  }
  const seen = new Set<string>();
  // 同一 (市场,方向) 折叠成一个候选,取 notional 最大的那笔 —— 一个方向只开一仓,
  // 多笔达标时最大那笔是最强的证据,它的 ts/price 即候选的 formationTs/referencePrice。
  const byKey = new Map<string, FollowCandidate>();
  // B3 质量门槛(minWalletScore)的剔除计数。这是本函数里唯一一个从「候选数 vs
  // 输入笔数」反推不出效果的决策点(BUY/白名单/MM/新鲜度的效果多少能从笔数变化
  // 估出来),不单独计数就没法回答调试时最常问的问题:这一轮没候选,到底是没
  // 巨鲸,还是巨鲸分数不够。
  let scoreGated = 0;
  for (const t of trades) {
    if (t.side !== "BUY") continue;
    const wallet = t.proxyWallet.toLowerCase();
    const tag = ctx.smart.get(wallet);
    // MM 剔除:与 detectConsensus/detectDisagreement 同一道闸(P0.5)。做市商的
    // 大额吃单是库存再平衡,不是方向性意见。
    if (!tag || tag.isMarketMaker) continue;
    // B3 质量门槛:score===null(未知)视为不达标,与 A3 同纪律 —— 宁可漏跟
    // 不可误开。
    if (
      params.minWalletScore != null &&
      (tag.score == null || tag.score < params.minWalletScore)
    ) {
      scoreGated++;
      continue;
    }
    // 分页边界会重发同一行,一个 tx 也可能含多笔 fill —— 先去重再比阈值,
    // 与 detectConsensus 的既有顺序一致。
    const dk = dedupKey(t);
    if (seen.has(dk)) continue;
    seen.add(dk);

    const usd = notionalUsd(t);
    if (usd < floor) continue;
    if (ctx.nowSec - t.timestamp > params.freshSec) continue;

    const key = `${t.conditionId}|${t.outcome}`;
    const prev = byKey.get(key);
    if (prev && prev.totalNetUsd >= usd) continue;
    byKey.set(key, {
      conditionId: t.conditionId,
      outcome: t.outcome,
      outcomeIndex: t.outcomeIndex,
      asset: t.asset,
      title: t.title,
      slug: t.slug,
      eventSlug: t.eventSlug,
      formationTs: t.timestamp,
      referencePrice: t.price,
      sourceKind: "heavy",
      walletCount: 1,
      totalNetUsd: usd,
    });
  }
  if (scoreGated > 0) {
    console.log(
      `[follow] strategy ${params.id} (heavy) 质量门槛:剔除 ${scoreGated} 笔` +
        `(score>=${params.minWalletScore} 不达标)`,
    );
  }
  return [...byKey.values()];
}
