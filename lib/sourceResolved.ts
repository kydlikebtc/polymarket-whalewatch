import { aggregateMarketOutcomes, type OutcomeAggregate } from "./disagreement";
import type {
  DetectorCtx,
  FollowCandidate,
  StrategyParams,
} from "./followCandidate";
import type { Trade } from "./types";

/**
 * 少数边"认输"判据 —— 已实现现金流口径(sellUsd/buyUsd/sellShares/buyShares,
 * OutcomeAggregate 对该 outcome 全部非剔除钱包求和,不分净买净卖):
 *
 *   sellUsd > buyUsd                                 净回收资金:钱在往回走
 *   && ( buyShares === 0                              窗口内零买入的全清仓,
 *                                                      最强的离场信号
 *        || sellUsd / sellShares < buyUsd / buyShares )  或卖均价 < 买均价,
 *                                                      真的亏钱离场
 *
 * 复审推翻过一版用 `netShares(acc) × avgBuyPrice(acc)`(不 clamp 的"有符号
 * 敞口")做这个判据,原因是两个真实代码反例(详见 lib/disagreement.ts
 * OutcomeAggregate 的字段注释,不重复贴):
 *   ① 窗口内零买入、只把窗口前建的仓卖光的钱包 —— avgBuyPrice=0,那个量
 *      对这个"最自然的割肉形态"完全失明(算出 0,不是负数);
 *   ② 买 100@0.5、卖 150@0.9 这种赚钱止盈,那个量算出 −25(方向判反了,
 *      止盈不是认输)。
 * 现金流口径同时解决这两点:第一个条件(sellUsd>buyUsd)只看"钱在流出"这个
 * 动作本身,不需要 avgBuyPrice 兜底,买 shares===0 直接判定为最强离场信号;
 * 第二个条件(卖均价<买均价)专门把①中"钱流出但其实是获利了结"的情形挡在
 * 外面。
 */
function isCapitulating(o: OutcomeAggregate): boolean {
  if (o.sellUsd <= o.buyUsd) return false;
  if (o.buyShares === 0) return true; // 窗口内零买入的全清仓,最强信号
  return o.sellUsd / o.sellShares < o.buyUsd / o.buyShares; // 卖均价 < 买均价
}

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
 * 从 trades 重新算一遍 prev.minorOutcome 这一边【现在】的现金流 —— 不依赖它
 * 这一刻是否还挂在 ctx.contested 上。
 *
 * 判据(D8,docs/plans/2026-08-11-follow-strategy-tiers-design.md,复审后
 * 改用现金流口径,见 isCapitulating):
 * prev.minorNetUsd(上一次快照,恒 > 0 —— 它当初能被记进 market_tilt_history
 * 就必然是一条清过 minPerSideUsd floor 的真实 side)且本轮 isCapitulating(minor)
 * 为真。
 *
 * 三道 fail-closed 护栏,任一不满足都不开仓:
 *   - 少数边未满足 isCapitulating(含"这一轮该市场压根没出现在窗口里"的
 *     默认值:buyUsd=sellUsd=0,sellUsd<=buyUsd 恒真)→ 还没到"认输"那一刻,
 *     不是错过,是真的还没发生。
 *   - 主导边自己也没在净投入(buyUsd<=sellUsd)→ 两边都在撤,不是"一边赢了
 *     分歧",是整个市场的资金在离场,跟单在追一个正在崩溃的市场没有意义。
 *     注意这里同样用现金流口径(buyUsd/sellUsd),不是 exposureUsd/netUsd ——
 *     两处判据必须统一口径,否则会在"部分认输、部分还在买"这种常态场景下
 *     互相打架(复审指出的根因:混用钳位的 weightedUsd 与不钳位的旧口径)。
 *   - 主导边被其它 outcome(含 prev 快照里从未见过的第三个 outcome)反超
 *     净投入(buyUsd−sellUsd)→ 这是"主导边换人"(一场新的分歧/倾斜正在
 *     形成),不是"原本的分歧解除了" —— 该场景理应交给 C1(lopsided)在它
 *     自己形成倾斜时接住,C2 不该越界抢跑。
 *
 * formationTs = ctx.nowSec:分歧解除是本轮才观察到的事件(prev 快照证明它
 * 上一轮还没解除,不然早被上一轮的 C2 捕获过),新鲜度天然满足,不需要像
 * C1 那样重放"跨线时刻"。这不是 bug —— nowSec 确实是 C2 唯一站得住脚的取值
 * (解除是本轮才观察到的事件,不存在更早的"形成时刻")—— 但这个选择有两处
 * 连带代价,此前没有任何地方记录,写在这里:
 *   (a) 进场偏离护栏对 C2 近乎失效。护栏(见 lib/follow.ts runFollowCycle)算
 *       deviationCents = |entry − baseline| × 100,baseline = formationPrice ??
 *       referencePrice,formationPrice 由 fetchFormationPrice(asset, formationTs)
 *       取得。C2 的 formationTs 就是开仓那一刻的 nowSec,与 entry 取价用的是
 *       同一个 nowSec —— 取到的 formationPrice 数值上约等于 entry 本身,
 *       deviationCents 几乎恒为 0。这道护栏只在形成价取价失败、回退到
 *       referencePrice(主导边历史成本均价,不是"形成后漂移")时才真正起作用,
 *       即 C2 这一档实际上是靠取价失败兜底,不是靠形成价本身在拦截。
 *   (b) markout 不可跨族与其它档比较。其余五族的 formationTs 可以早于
 *       entry_ts 最多 freshSec(默认 900s,A5 是 300s),所以它们的
 *       markout_30m/2h 天然包含"检测到信号→决定跟进"这段延迟的漂移成本;
 *       C2 因为 formationTs===entry_ts,markout 测的是"从我们开仓那一刻起"的
 *       纯漂移,不含这段延迟。以后若做"哪一族形成后走势最好"之类的跨族分析,
 *       C2 和别族的 markout 不是同一把尺子,直接比较是苹果对橘子。
 *
 * referencePrice/walletCount/totalNetUsd 取主导边(prev.leadOutcome)【本轮】
 * 用 aggregateMarketOutcomes 重新算出的净买者聚合(netUsd/avgBuyPrice/
 * walletCount,与 C1/lopsided 展示口径一致)—— 不能指望 ctx.contested 里有
 * 现成的 sides(这正是上面第 1、2 点论证的:market 这一刻很可能已经不在
 * ctx.contested 里了,取不到"现成"的任何东西)。这三个展示字段仍用净买者
 * 子集聚合,只有【判定是否开仓】这一步换成了现金流口径 —— 两者服务不同目的
 * (判定要能看见负值/认输,展示要报告"聪明钱的成本基准"),不矛盾。
 */
export function detectResolvedCandidates(
  trades: Trade[],
  params: StrategyParams,
  ctx: DetectorCtx,
): FollowCandidate[] {
  const out: FollowCandidate[] = [];
  // 四个计数器对应四条独立的弃权理由 —— 同 sourceLopsided 的既有纪律:调试时
  // 最常问的问题是"这一轮没候选,到底是没有上轮快照、少数边没认输、主导边
  // 自己也在撤,还是被反超了",不分开计数就没法回答。
  let noTrades = 0; // 本轮窗口里这个市场一笔白名单相关成交都没有,无从判定
  let stillBuying = 0; // 少数边未满足认输判据(含快照本身不合法:prev.minorNetUsd<=0)
  let leadRetreated = 0; // 主导边自己也没在净投入 —— 整体离场,不是"赢了"
  let leadOvertaken = 0; // 主导边被其它 outcome 反超净投入 —— 换人,不是解除

  for (const [conditionId, prev] of ctx.prevTilt) {
    const marketTrades = trades.filter((t) => t.conditionId === conditionId);
    if (marketTrades.length === 0) {
      noTrades++;
      continue;
    }
    const { byOutcome } = aggregateMarketOutcomes(marketTrades, ctx.smart);

    // 判据核心:上一次快照里少数边是净买(否则这条快照本身就不该出现 ——
    // 防御性检查,理由见 lib/follow.ts readMarketTiltSnapshots 的字段注释),
    // 且本轮现金流满足 isCapitulating(见函数头注释)。市场本轮完全没出现在
    // 窗口里,或少数边这一刻没有任何白名单成交 → aggregateMarketOutcomes 的
    // 返回里没有这个 outcome 的 key,minor 为 undefined,视为"没有认输的
    // 证据"—— fail-closed 不触发。
    const minor = byOutcome.get(prev.minorOutcome);
    const capitulated = minor != null && isCapitulating(minor);
    if (!(prev.minorNetUsd > 0 && capitulated)) {
      stillBuying++;
      continue;
    }

    // 主导边(prev.leadOutcome)本轮的开仓字段,同样用 aggregateMarketOutcomes
    // 从 trades 算 —— 见函数头注释,市场此刻多半已经不在 ctx.contested 里,
    // 没有现成的 sides 可用。lead 不存在或本轮净投入(buyUsd−sellUsd)<=0 →
    // fail-closed:两边都在撤,不是"一边赢了"。判定用现金流口径(与少数边
    // 同一套),展示字段(referencePrice/walletCount/totalNetUsd)仍用下面
    // lead.avgBuyPrice/walletCount/netUsd 这组净买者聚合 —— 两者服务不同
    // 目的,见函数头注释。
    const lead = byOutcome.get(prev.leadOutcome);
    if (!lead || lead.buyUsd <= lead.sellUsd) {
      leadRetreated++;
      continue;
    }

    // 主导边换人:prev.leadOutcome 本轮的净投入(buyUsd−sellUsd)必须仍是这
    // 个市场里最大的 —— 若某个其它 outcome(可能是 prev.minorOutcome 残余的
    // 现金流,也可能是快照里从未见过的第三个 outcome,3-way 市场天然可能)
    // 反超,说明这不是"分歧解除",是分歧的主导权转移到了别处,该场景属于
    // C1(等它自己重新形成倾斜时接住),C2 不越界抢跑。
    const leadNetInvested = lead.buyUsd - lead.sellUsd;
    const overtaken = [...byOutcome.values()].some(
      (o) =>
        o.outcome !== prev.leadOutcome &&
        o.buyUsd - o.sellUsd > leadNetInvested,
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
      // 向前落库快照:主导边净买者(开的就是这一边)。纯归因,不参与判定。
      wallets: lead.wallets.map((w) => ({
        wallet: w.wallet,
        netUsd: w.netUsd,
        score: w.score,
      })),
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
        `(少数边未满足认输判据,或快照本身不合法)`,
    );
  }
  if (leadRetreated > 0) {
    console.log(
      `[follow] strategy ${params.id} (resolved) fail-closed:跳过 ${leadRetreated} 个市场` +
        `(主导边自己也没在净投入 —— 两边都在撤,不是"一边赢了")`,
    );
  }
  if (leadOvertaken > 0) {
    console.log(
      `[follow] strategy ${params.id} (resolved) 主导边换人:跳过 ${leadOvertaken} 个市场` +
        `(prev.leadOutcome 已被其它 outcome 反超净投入,这是翻转不是解除)`,
    );
  }

  return out;
}
