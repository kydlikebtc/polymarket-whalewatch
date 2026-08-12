import { DEFAULT_DISAGREEMENT } from "./disagreement";
import type {
  DetectorCtx,
  FollowCandidate,
  StrategyParams,
} from "./followCandidate";
import type { Trade } from "./types";

/**
 * C1:分歧但一边倒。产品语义「只跟共识、不跟分歧」此前被 lib/marketSignals.ts
 * 的 excludeContestedFromConsensus 实现成「沾了分歧的市场整个不跟」—— 但
 * detectDisagreement 早就算出了 tiltPct(主导边质量加权占比)与 tilt
 * ("lopsided"/"balanced")。一边倒的市场从来不是「没有共识」,只是共识里混进
 * 了零星反对票;C1 把这批市场从「谁都不跟」的死区里捞回来,跟主导边(sides[0])。
 *
 * 与 A 族(detectConsensusCandidates)的关系是"互补且不重叠",不是"重叠取并":
 *   - 无争议市场                             → 只有 A 族覆盖
 *   - 争议 + tiltPct >= minTilt(一边倒)      → 只有 C1 覆盖(A 族已被
 *     excludeContestedFromConsensus 按 conditionId 整市场剔除,与本 detector
 *     挑不挑这个市场无关 —— 见 lib/sourceConsensus.ts)
 *   - 争议 + tiltPct <  minTilt(真·势均力敌) → 谁都不跟。这才是「只跟共识不
 *     跟分歧」的原义:不是产品放弃了这批市场的信号,而是这批市场本身没有一个
 *     "聪明钱赢下了这场分歧"的答案,跟哪一边都是在替聪明钱做他们自己都还没
 *     做出的判断。
 * 两族各自消费 ctx.contested 的补集/子集,靠 ctx.contested 本身的口径(市场级、
 * DEFAULT_DISAGREEMENT 阈值,runFollowCycle 每轮只算一次、所有策略共享)天然
 * 不重叠 —— 本 detector 不需要、也没有对 A 族做任何去重处理。
 *
 * 不读 trades:一边倒是 ctx.contested 里现成的结果(每轮由 runFollowCycle 用
 * DEFAULT_DISAGREEMENT 跑一次 detectDisagreement,所有策略共享,见
 * lib/follow.ts)。重新扫一遍 trades 只会算出同一个答案,还可能因为本策略自己
 * 的 minTiltPct/minPerSideUsd 与 DEFAULT_DISAGREEMENT 不一致而算出不同的
 * contested 集合,破坏「contested 市场级互斥只有一个口径」这条设计前提(见
 * lib/follow.ts 里 detectDisagreement 调用处的注释)。第一个参数因此用不到,
 * 命名前缀下划线只是给人看的意图声明 —— 本仓库没有 ESLint,tsconfig 也未开
 * noUnusedParameters(strict 不包含它,见 tsconfig.json),不加下划线一样编译
 * 通过,这里加上纯粹是防止未来读者以为"忘了用 trades"。
 *
 * formationTs = sides[0](主导边)的倾斜形成时刻(tiltPct 首次跨过
 * lopsidedTiltPct 的那一笔成交时间,见 lib/disagreement.ts 的
 * DisagreementSide.formationTs 字段注释)。它可能是 null —— 只有两种情况:
 *   1) 从未跨过阈值(市场其实是 balanced,不该走到这里,下面的 tiltPct 检查
 *      会先拦下);
 *   2) 本策略配置了比 DEFAULT_DISAGREEMENT.lopsidedTiltPct 更低的 minTiltPct,
 *      市场最终 tiltPct 过了这个更低的门槛,但从未跨过 ctx.contested 构建时
 *      用的固定 0.7(formationTs 锚定的是那个固定阈值,不随本策略的
 *      minTiltPct 变化)。
 * 无论哪种情况,fail-closed 都是唯一安全的选择:绝不退回 m.lastTs 之类的市场级
 * 时间戳兜底 —— lastTs 被市场内任何白名单成交(含 SELL、含不达标钱包)刷新,
 * 会把一个"其实没有正式形成"的倾斜"续命"成新鲜,按现价跟入,这正是
 * DisagreementSide.formationTs 字段注释里记录的、已经付出代价修掉的那类 bug。
 * 宁可这一档暂时空仓,也不要用一个编造的时间戳开仓。
 *
 * minTilt 默认值直接引用 DEFAULT_DISAGREEMENT.lopsidedTiltPct,不是重复写字面量
 * 0.7:ctx.contested 恒由 runFollowCycle 用 DEFAULT_DISAGREEMENT 算出(与策略
 * 阈值无关,见 lib/follow.ts),market.tilt 字段("lopsided"/"balanced")就是拿
 * 这同一个常量判定的。若这里独立写一个字面量,两处一旦有一处改动就会分叉,
 * 出现「detectDisagreement 标了 balanced 但 C1 却跟了」的自相矛盾 —— 这正是
 * 这一行要杜绝的 bug 类别。策略显式配置 minTiltPct(比如要求比默认更保守的
 * 0.9)不受此约束,是策略作者的主动选择,与 A3/A4 等其余可选门槛同一套哲学;
 * 配置得比默认更低时,上面 formationTs 的 fail-closed 兜底会让它在
 * [自定义阈值, 0.7) 这个区间静默失效而不是错误开仓 —— 更低的自定义阈值只能
 * "无效",不能"更危险"。
 *
 * side 选边(第 13 档「逆势少数边」新增;C1 自己不配这个字段,固定退默认
 * "lead"):params.side === "minor" 时跟 sides[1](少数边)而非 sides[0]
 * (主导边)——两档共享同一批 ctx.contested、同一个 minTilt 判据,只在"选哪
 * 一边的 outcome/asset/avgBuyPrice/walletCount/netUsd 组装候选"这一步分叉。
 *
 * ⚠️ formationTs 恒取 sides[0].formationTs,不随 side 切换 —— 这是本 detector
 * 里最容易被后人误"修"的一处,必须讲清楚为什么不能变:
 *   1. 语义上,"倾斜形成时刻"(tiltPct 首次跨过 lopsidedTiltPct 的那一笔成交
 *      时间)是一个市场级事件,不是"主导边专属"的事件 —— 那一刻同时是"多数边
 *      站稳了"与"少数边被压制到只剩这么点权重"的两面。少数边也没有一个独立
 *      于此的"自己的形成时刻"可用:detectDisagreement 只对 sides[0] 重放过
 *      tiltFormationTs,sides[1..] 恒为 null(见 lib/disagreement.ts
 *      DisagreementSide.formationTs 字段注释),没有现成的备选值。
 *   2. 更重要的是这一档存在的产品目的:给 C1 提供一个能拿真实战绩互相印证的
 *      对照组(主导边持续赢 → tilt/qualityWeight 判据有效;少数边持续赢 →
 *      评分体系可能有盲区,或少数派掌握了权重算法看不见的信息)。对照要成立,
 *      两档必须在同一时刻、以同一笔钱开仓 —— 如果少数边另算一个 formationTs
 *      (比如它自己净买首次达标的时刻,通常早于倾斜形成),两档的进场时机就
 *      不再是同一个基准,胜率差异里会混入"择时不同"这个变量,C1 与本档的
 *      战绩对比就失去了意义,退化成两个互不可比的独立策略。
 * 所以下面 minor 分支只切换 outcome/asset/avgBuyPrice/walletCount/netUsd
 * 这四类字段的来源,formationTs 那一行不动。
 */
export function detectLopsidedCandidates(
  _trades: Trade[],
  params: StrategyParams,
  ctx: DetectorCtx,
): FollowCandidate[] {
  const minTilt = params.minTiltPct ?? DEFAULT_DISAGREEMENT.lopsidedTiltPct;
  // 缺省 "lead"(既有 C1 行为)。lib/follow.ts 的 parseStrategy 已经做过一次
  // 校验/退默认,这里的 `?? "lead"` 是防御性的第二道 —— 本 detector 也被
  // 单测直接构造 StrategyParams 调用(不经过 parseStrategy),缺 side 字段时
  // 必须与生产路径落到同一个默认值,两处一旦分叉,单测再绿也保护不了生产行为。
  const side = params.side ?? "lead";
  const out: FollowCandidate[] = [];
  // 四个计数器对应四条独立的弃权理由 —— 调试时最常问的问题是"这一轮没候选,
  // 到底是没有一边倒的市场、算不出形成时刻、形成得太早不新鲜了,还是(仅
  // side="minor" 时)这个市场压根没有第二边可跟",不分开计数就没法回答。
  let balancedSkipped = 0; // 真·势均力敌:tiltPct 没过 minTilt,谁都不跟
  let noFormation = 0; // 一边倒但算不出跨线时刻(fail-closed 弃权)
  let stale = 0; // 一边倒且有跨线时刻,但已过新鲜度窗口
  let missingMinor = 0; // side="minor" 但 sides[1] 不存在(fail-closed 弃权)

  for (const m of ctx.contested) {
    // sides 按 weightedUsd 降序是 detectDisagreement 的出参契约(见
    // lib/disagreement.ts DisagreementMarket.sides 字段注释 + 该函数内
    // `sides.sort((a, b) => b.weightedUsd - a.weightedUsd)`),sides[0] 即质量
    // 加权金额最大的主导边 —— 也是唯一被算过 formationTs 的边(见下方)。
    const lead = m.sides[0];

    if (m.tiltPct < minTilt) {
      balancedSkipped++;
      continue; // 真·势均力敌 —— 谁都不跟,不是漏跟,是本来就没有信号
    }

    // fail-closed:倾斜时刻算不出就不开仓,绝不退回 lastTs(理由见函数头注释)。
    // formationTs 只在 sides[0] 上有值(detectDisagreement 只对最终主导边重放
    // 覆盖,其余边恒 null),lead 就是 sides[0],口径对得上。⚠️ side==="minor"
    // 时这里仍然读 lead(即 sides[0])的 formationTs,不是漏改 —— 见函数头
    // 「formationTs 恒取 sides[0]」整段论证,两档必须共用同一个时刻才构成
    // 干净的对照。
    const formationTs = lead.formationTs;
    if (formationTs == null) {
      noFormation++;
      continue;
    }

    if (ctx.nowSec - formationTs > params.freshSec) {
      stale++;
      continue;
    }

    // 选边:"lead" 跟 sides[0](与上面判定 formationTs 用的同一个对象,C1 的
    // 既有行为);"minor" 跟 sides[1]。detectDisagreement 保证 sides.length>=2
    // 才会把市场放进 ctx.contested(该函数内 `if (sides.length < 2) continue`),
    // 理论上 sides[1] 恒存在 —— 但这个契约由另一个文件保证,这里仍显式判空
    // fail-closed(不用 `m.sides[1]!` 断言硬转):防御性检查的成本几乎为零,
    // 换来的是"契约万一被未来重构破坏"时静默弃权,而不是运行时抛错崩掉整轮。
    let chosen = lead;
    if (side === "minor") {
      const minor = m.sides[1];
      if (!minor) {
        missingMinor++;
        continue;
      }
      chosen = minor;
    }

    out.push({
      conditionId: m.conditionId,
      outcome: chosen.outcome,
      outcomeIndex: chosen.outcomeIndex,
      asset: chosen.asset,
      title: m.title,
      slug: m.slug,
      eventSlug: m.eventSlug,
      formationTs, // 恒为 sides[0].formationTs,不随 side 切换 —— 见函数头注释
      referencePrice: chosen.avgBuyPrice,
      sourceKind: "lopsided",
      walletCount: chosen.walletCount,
      totalNetUsd: chosen.netUsd,
    });
  }

  if (balancedSkipped > 0) {
    console.log(
      `[follow] strategy ${params.id} (lopsided) 真·势均力敌:跳过 ${balancedSkipped} 个争议市场` +
        `(tiltPct < ${minTilt},谁都不跟)`,
    );
  }
  if (noFormation > 0) {
    console.log(
      `[follow] strategy ${params.id} (lopsided) fail-closed:跳过 ${noFormation} 个一边倒市场` +
        `(倾斜形成时刻算不出,拒绝退回 lastTs 兜底)`,
    );
  }
  if (stale > 0) {
    console.log(
      `[follow] strategy ${params.id} (lopsided) 新鲜度闸门:跳过 ${stale} 个陈旧倾斜` +
        `(now − formationTs > ${params.freshSec}s)`,
    );
  }
  if (missingMinor > 0) {
    console.log(
      `[follow] strategy ${params.id} (lopsided,side=minor) fail-closed:跳过 ${missingMinor} 个市场` +
        `(sides[1] 不存在,理论上不应发生 —— detectDisagreement 保证 sides.length>=2)`,
    );
  }

  return out;
}
