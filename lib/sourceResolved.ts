import { aggregateMarketOutcomes } from "./disagreement";
import type {
  DetectorCtx,
  FollowCandidate,
  StrategyParams,
} from "./followCandidate";
import type { Trade } from "./types";

/**
 * C2:分歧解除。一个市场原本聪明钱两边都在买(contested),后来少数边开始
 * 【净卖】—— 有人认输了,这一刻信息量最大。
 *
 * 为什么遍历 ctx.prevTilt 而不是 ctx.contested(这是整份实现里最容易被"顺手
 * 改回去"的一点,写清楚原因防止未来重构踩回同一个坑):
 *   1. detectDisagreement 构建 side 时有两道过滤 —— exposureUsd(acc)<=0 时
 *      跳过该钱包(净卖者不构成这一边)、netUsd<opts.minPerSideUsd 时整条边
 *      不成立。少数边真的转净卖时,这两道过滤会先后生效:该边的净买者一个
 *      不剩,netUsd 跌破 floor,side 消失,市场 sides.length<2,整个市场
 *      从 ctx.contested 里消失。
 *   2. 而 C2 恰恰要跟的就是这个消失的瞬间。若遍历 ctx.contested,目标市场
 *      在它最想被看见的那一刻,已经不在这个集合里了 —— 遍历 ctx.contested
 *      结构性地看不到 C2 的正例。
 * 所以必须反过来:遍历上一轮记录下来的 ctx.prevTilt(那时市场还 contested,
 * 被 runFollowCycle 快照进了 market_tilt_history),本轮用 aggregateMarketOutcomes
 * 从 trades 重新算一遍 prev.minorOutcome 这一边【现在】的净额 —— 不依赖它
 * 这一刻是否还挂在 ctx.contested 上。
 *
 * 判据(D8,docs/plans/2026-08-11-follow-strategy-tiers-design.md):
 * prev.minorNetUsd(上一次快照,恒 > 0 —— 它当初能被记进 market_tilt_history
 * 就必然是一条清过 minPerSideUsd floor 的真实 side)且本轮 signedNetUsd < 0
 * (aggregateMarketOutcomes 的有符号口径,不 clamp —— 详见该函数在
 * lib/disagreement.ts 里的字段注释:唯独这个字段能测出"转负"这件事,
 * DisagreementSide 那套 clamp 到 0 的口径做不到)。
 *
 * 三道 fail-closed 护栏,任一不满足都不开仓:
 *   - 少数边仍在净买(signedNetUsd>=0,含"这一轮该市场压根没出现在窗口里"
 *     的默认值 0)→ 还没到"认输"那一刻,不是错过,是真的还没发生。
 *   - 主导边自己也没在净买(signedNetUsd<=0)→ 两边都在撤,不是"一边赢了
 *     分歧",是整个市场的资金在离场,跟单在追一个正在崩溃的市场没有意义。
 *   - 主导边被其它 outcome(含 prev 快照里从未见过的第三个 outcome)反超
 *     weightedUsd → 这是"主导边换人"(一场新的分歧/倾斜正在形成),不是
 *     "原本的分歧解除了" —— 该场景理应交给 C1(lopsided)在它自己形成
 *     倾斜时接住,C2 不该越界抢跑。
 *
 * formationTs = ctx.nowSec:分歧解除是本轮才观察到的事件(prev 快照证明它
 * 上一轮还没解除,不然早被上一轮的 C2 捕获过),新鲜度天然满足,不需要像
 * C1 那样重放"跨线时刻"。
 *
 * referencePrice/walletCount/totalNetUsd 取主导边(prev.leadOutcome)【本轮】
 * 用 aggregateMarketOutcomes 重新算出的净买者聚合 —— 不能指望 ctx.contested
 * 里有现成的 sides(这正是上面第 1、2 点论证的:market 这一刻很可能已经不在
 * ctx.contested 里了,取不到"现成"的任何东西)。
 */
export function detectResolvedCandidates(
  trades: Trade[],
  params: StrategyParams,
  ctx: DetectorCtx,
): FollowCandidate[] {
  const out: FollowCandidate[] = [];
  // 四个计数器对应四条独立的弃权理由 —— 同 sourceLopsided 的既有纪律:调试时
  // 最常问的问题是"这一轮没候选,到底是没有上轮快照、少数边没转负、主导边
  // 自己也在撤,还是被反超了",不分开计数就没法回答。
  let noTrades = 0; // 本轮窗口里这个市场一笔白名单相关成交都没有,无从判定
  let stillBuying = 0; // 少数边未转负(含快照本身不合法:prev.minorNetUsd<=0)
  let leadRetreated = 0; // 主导边自己也没在净买 —— 整体离场,不是"赢了"
  let leadOvertaken = 0; // 主导边被其它 outcome 反超 —— 换人,不是解除

  for (const [conditionId, prev] of ctx.prevTilt) {
    const marketTrades = trades.filter((t) => t.conditionId === conditionId);
    if (marketTrades.length === 0) {
      noTrades++;
      continue;
    }
    const { byOutcome } = aggregateMarketOutcomes(marketTrades, ctx.smart);

    // 判据核心:上一次快照里少数边是净买(否则这条快照本身就不该出现 ——
    // 防御性检查,理由见 lib/follow.ts readMarketTiltSnapshots 的字段注释),
    // 且本轮重新算出的有符号净额已经 < 0。市场本轮完全没出现在窗口里,或
    // 少数边这一刻没有任何白名单成交 → aggregateMarketOutcomes 的返回里
    // 没有这个 outcome 的 key,minorNow 按未变化处理(0,不小于 0)—— 不是
    // "转负"的证据,fail-closed 不触发。
    const minor = byOutcome.get(prev.minorOutcome);
    const minorNow = minor?.signedNetUsd ?? 0;
    if (!(prev.minorNetUsd > 0 && minorNow < 0)) {
      stillBuying++;
      continue;
    }

    // 主导边(prev.leadOutcome)本轮的开仓字段,同样用 aggregateMarketOutcomes
    // 从 trades 算 —— 见函数头注释,市场此刻多半已经不在 ctx.contested 里,
    // 没有现成的 sides 可用。lead 不存在或本轮净额 <= 0(未 clamp 的有符号
    // 口径,可能因为自己也在净卖而为负,也可能因为窗口内没有任何白名单成交
    // 而按 0 处理)→ fail-closed:两边都在撤,不是"一边赢了"。
    const lead = byOutcome.get(prev.leadOutcome);
    if (!lead || lead.signedNetUsd <= 0) {
      leadRetreated++;
      continue;
    }

    // 主导边换人:prev.leadOutcome 本轮的 weightedUsd 必须仍是这个市场里最大
    // 的 —— 若某个其它 outcome(可能是 prev.minorOutcome 残余的净买者,也
    // 可能是快照里从未见过的第三个 outcome,3-way 市场天然可能)反超,说明
    // 这不是"分歧解除",是分歧的主导权转移到了别处,该场景属于 C1(等它自己
    // 重新形成倾斜时接住),C2 不越界抢跑。lead.weightedUsd 是净买者子集的
    // 加权聚合(见 aggregateMarketOutcomes 字段注释),与 detectDisagreement
    // 排 sides 顺序用的量纲一致。
    const overtaken = [...byOutcome.values()].some(
      (o) => o.outcome !== prev.leadOutcome && o.weightedUsd > lead.weightedUsd,
    );
    if (overtaken) {
      leadOvertaken++;
      continue;
    }

    out.push({
      conditionId,
      outcome: lead.outcome,
      outcomeIndex: lead.outcomeIndex,
      asset: lead.asset,
      // MarketTiltSnapshot 不携带 title/slug/eventSlug(表结构里也没有这几列
      // —— 见 lib/db.ts 的 market_tilt_history 建表语句),这几个字段本来就
      // 该从"本轮真实观察到的成交"里取,而不是跨轮持久化一份可能过期的市场
      // 元数据。marketTrades 非空已在函数开头确认,任取一笔即可(与
      // detectDisagreement 构建 market 元数据时"first-seen wins"同一约定)。
      title: marketTrades[0].title,
      slug: marketTrades[0].slug,
      eventSlug: marketTrades[0].eventSlug,
      formationTs: ctx.nowSec, // 解除是本轮才观察到的事件,新鲜度天然满足
      referencePrice: lead.avgBuyPrice,
      sourceKind: "resolved",
      walletCount: lead.walletCount,
      totalNetUsd: lead.netUsd,
    });
  }

  if (noTrades > 0) {
    console.log(
      `[follow] strategy ${params.id} (resolved) 跳过 ${noTrades} 个上轮快照市场` +
        `(本轮窗口无该市场任何白名单成交,无从判定转变)`,
    );
  }
  if (stillBuying > 0) {
    console.log(
      `[follow] strategy ${params.id} (resolved) 跳过 ${stillBuying} 个市场` +
        `(少数边未观察到转净卖,或快照本身不合法)`,
    );
  }
  if (leadRetreated > 0) {
    console.log(
      `[follow] strategy ${params.id} (resolved) fail-closed:跳过 ${leadRetreated} 个市场` +
        `(主导边自己也没在净买 —— 两边都在撤,不是"一边赢了")`,
    );
  }
  if (leadOvertaken > 0) {
    console.log(
      `[follow] strategy ${params.id} (resolved) 主导边换人:跳过 ${leadOvertaken} 个市场` +
        `(prev.leadOutcome 已被其它 outcome 反超,这是翻转不是解除)`,
    );
  }

  return out;
}
