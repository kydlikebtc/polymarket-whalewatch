import type {
  DetectorCtx,
  FollowCandidate,
  FollowSourceKind,
  StrategyParams,
} from "./followCandidate";
import { avgBuyPrice, exposureUsd, type PositionAcc } from "./netPosition";
import type { SmartTag } from "./smartWallets";
import { dedupKey, notionalUsd } from "./trades";
import type { Trade } from "./types";

/**
 * 族 D:钱包画像。D1(lone_wolf,高分独狼)与 D2(early_winner,早期赢家跟投)
 * 判据几乎完全相同 —— 单个钱包在窗口内对某 (市场,方向) 的净买 >= minNetUsd,
 * 唯一不同的是"这个钱包够不够格"的谓词:
 *   D1:score >= minWalletScore(质量轴,测的是"钱包好不好")
 *   D2:属于 ctx.earlyWinnerWallets(渠道轴,测的是"敢不敢在便宜时下重注"——
 *       earlyWinner.ts 的 EW_MAX_PRICE/EW_EARLY_LEAD_SEC 判据,与 score 的三个
 *       分量——绝对利润/资金效率/胜率——完全正交,score 里没有这个维度)
 * 两者共用 detectWalletCandidates,只在 isQualified 谓词上分叉,避免复制粘贴
 * 两份净买累加/跨线/折叠逻辑。
 *
 * 与族 B(heavy)的区别:B 看**单笔金额**(一笔巨额本身就是信号,无关钱包是谁);
 * D 看**钱包质量/身份**(同样金额的净买,出自一个 score=95 的钱包 或一个
 * early_winner 钱包,比出自普通白名单钱包更值得跟)。
 *
 * 不受分歧互斥约束(D6,与族 B 同一裁决,见
 * docs/plans/2026-08-11-follow-strategy-tiers-design.md §「D6」):lone_wolf/
 * early_winner 的语义都是"这个钱包的净买本身就是信号",不依赖别的聪明钱怎么想。
 * 因市场有争议就不跟,等于用共识的世界观审查钱包画像族的信号,还会让 D 族只在
 * 无争议市场取样(样本系统性偏置)。故本文件两个 detector 都不读 ctx.contested。
 */

// 净买累加器 + 跨线时刻。PositionAcc 是 netPosition.ts 的净股数口径基础结构
// (buyUsd/sellUsd/buyShares/sellShares),crossTs 借鉴 ConsensusWallet.qualifiedTs
// (consensus.ts)的 last-upward-crossing 语义,见下方累加循环处的注释。
interface WalletAcc extends PositionAcc {
  crossTs: number | null;
}

interface WalletEntry {
  conditionId: string;
  outcome: string;
  outcomeIndex: number;
  asset: string;
  title: string;
  slug: string;
  eventSlug: string;
  wallet: string;
  acc: WalletAcc;
}

/**
 * 族 D 共用的核心检测逻辑。isQualified 是唯一的分叉点:判断一个通过了身份闸
 * (白名单 + 非做市商)的钱包,是否够格作为本源的信号来源。
 *
 * 判据全流程:
 *  1. 身份闸(P0.5 同款):非白名单(!tag)或做市商(isMarketMaker)剔除 ——
 *     与 detectConsensus/detectHeavyCandidates 同一道闸,做市商的成交是库存
 *     再平衡,不是方向性意见。
 *  2. isQualified 谓词:本源特有的"够不够格"判断(D1:score;D2:渠道成员)。
 *  3. 净股数口径(P0.6,netPosition.ts)按 (市场,方向,钱包) 累加,借鉴
 *     ConsensusWallet.qualifiedTs 的 last-upward-crossing:按时序累加,记录
 *     **最后一次**由 <floor 升到 >=floor 的成交时刻(中途跌回再跨则覆盖)。
 *     选"最后一次"而非"第一次"的理由与 consensus.ts 完全一致:
 *     formationTs 要回答的是"这个钱包的净买信号在什么时刻**站稳**",而不是
 *     "第一次摸到门槛是什么时候"——摸到门槛后又跌回去说明那一刻的信号并不
 *     可靠(可能是试探性建仓又部分平掉),只有最后一次跨线且保持到窗口末尾
 *     (由下面"窗口末尾净买 >= floor"这个前提保证)才是真正站稳的时刻。
 *  4. 折叠:同一 (市场,方向) 可能有多个够格钱包各自独立跨线 —— 开仓表的
 *     UNIQUE(strategy_id, condition_id, outcome) 约束决定这一档只能开一仓,
 *     取净买(exposureUsd)最大的那个钱包。见下方折叠循环处的详细论证。
 *
 * referencePrice = 中选钱包的 avgBuyPrice(它自己的成本基准,不是市场均价)。
 * walletCount 恒为 1(单钱包信号,与族 A/C 的多钱包聚合语义不同)。
 */
function detectWalletCandidates(
  trades: Trade[],
  params: StrategyParams,
  ctx: DetectorCtx,
  sourceKind: FollowSourceKind,
  isQualified: (wallet: string, tag: SmartTag) => boolean,
  qualifyLabel: string,
): FollowCandidate[] {
  const floor = params.minNetUsd;
  if (floor == null || floor <= 0) {
    console.warn(
      `[follow] strategy ${params.id} (${sourceKind}) minNetUsd 缺失或非正,本策略本轮无候选`,
    );
    return [];
  }

  // 分页边界会重发同一行,一个 tx 也可能含多笔 fill —— 与 detectConsensus 同
  // 纪律先去重。crossing 检测必须按时间正序累计净买,trades 的顺序契约在不同
  // 调用方之间不一致(newest-first / 未知序都有),不能对入参加隐式有序假设,
  // 这里自己排(复制后排序,不改入参)。
  const rows = [...trades].sort((a, b) => a.timestamp - b.timestamp);

  const byWalletMarket = new Map<string, WalletEntry>();
  const seen = new Set<string>();
  // 身份闸 + isQualified 合并计数:两者都指向同一个问题"这个钱包能不能投票",
  // 拆开对调试没有额外帮助(排查时都是去看这个钱包的 tag),不像下面
  // belowFloor/stale 那样是发生在不同钱包身上、彼此独立的两条门槛。
  let notQualified = 0;
  for (const t of rows) {
    const wallet = t.proxyWallet.toLowerCase();
    const tag = ctx.smart.get(wallet);
    if (!tag || tag.isMarketMaker || !isQualified(wallet, tag)) {
      notQualified++;
      continue;
    }
    const dk = dedupKey(t);
    if (seen.has(dk)) continue;
    seen.add(dk);

    const key = `${t.conditionId}|${t.outcome}|${wallet}`;
    let entry = byWalletMarket.get(key);
    if (!entry) {
      entry = {
        conditionId: t.conditionId,
        outcome: t.outcome,
        outcomeIndex: t.outcomeIndex,
        asset: t.asset,
        title: t.title,
        slug: t.slug,
        eventSlug: t.eventSlug,
        wallet,
        acc: {
          buyUsd: 0,
          sellUsd: 0,
          buyShares: 0,
          sellShares: 0,
          crossTs: null,
        },
      };
      byWalletMarket.set(key, entry);
    }
    const acc = entry.acc;
    // 跨线与达标同用成本敞口口径(P0.6):等股买卖不同价的"USD 假净买"既不能让
    // 钱包合格,也不能制造跨线时刻 —— 这正是这个项目付出过代价的坑(见
    // netPosition.ts 文件头注释:买 20k@75¢ 卖 20k@25¢,现金流口径读出 +$10k
    // 净买,而钱包实际什么都没留下)。
    const prevNet = exposureUsd(acc);
    const tradeUsd = notionalUsd(t);
    if (t.side === "BUY") {
      acc.buyUsd += tradeUsd;
      acc.buyShares += t.size;
    } else {
      acc.sellUsd += tradeUsd;
      acc.sellShares += t.size;
    }
    const newNet = exposureUsd(acc);
    // last upward crossing(借鉴 ConsensusWallet.qualifiedTs,consensus.ts):
    // 每次从 <floor 升到 >=floor 都覆盖记录,中途跌回再跨则覆盖 —— 最终保留
    // "最后一次"跨线,不是"第一次"。
    if (prevNet < floor && newNet >= floor) {
      acc.crossTs = t.timestamp;
    }
  }
  if (notQualified > 0) {
    console.log(
      `[follow] strategy ${params.id} (${sourceKind}) 身份/资格门槛:剔除 ${notQualified} 笔` +
        `(非白名单、做市商,或未通过 ${qualifyLabel})`,
    );
  }

  // 折叠:同一 (市场,方向) 上多个够格钱包各自独立跨线时,取净买(exposureUsd)
  // 最大的那个 —— 与 sourceHeavy.ts 折叠同一 (市场,方向) 多笔达标交易时"取
  // notional 最大的那笔"同一套论证:金额越大,这个钱包对这个方向的信念越强、
  // 证据越硬,是这批够格钱包里最有代表性的那一个信号。不选"最早跨线的":早不
  // 代表强 —— 一个刚压线达标($10,001)的钱包比一个远超门槛($80,000)的钱包
  // 更早跨过同一条线,不该因为"抢跑一步"就压过明显更有信念的对手,这与 heavy
  // 拒绝"取最新一笔"、坚持"取最大一笔"是同一立场:数额优先于时间。
  const byMarketOutcome = new Map<
    string,
    { entry: WalletEntry; netUsd: number; formationTs: number }
  >();
  let belowFloor = 0; // 窗口末尾净买 < floor(含"从未跨线"与"跨线后又跌回"两种情况)
  let stale = 0;
  for (const entry of byWalletMarket.values()) {
    const netUsd = exposureUsd(entry.acc);
    if (netUsd < floor) {
      belowFloor++;
      continue;
    }
    const formationTs = entry.acc.crossTs;
    if (formationTs == null) {
      // 不可能发生:floor>0 且 netUsd>=floor ⇒ exposureUsd 必然经历过一次从
      // <floor 到 >=floor 的跃升,crossTs 在那一刻必被赋值(上面累加循环里)。
      // 保留这道防御只是不信任"不可能"三个字 —— 真出现说明累加逻辑本身有
      // bug,fail-closed 弃权比开一个凭空冒出时间戳的仓安全。
      console.warn(
        `[follow] strategy ${params.id} (${sourceKind}) 内部不变量被打破:` +
          `${entry.wallet} 净买 ${netUsd} >= floor ${floor} 但无跨线时刻,跳过`,
      );
      continue;
    }
    if (ctx.nowSec - formationTs > params.freshSec) {
      stale++;
      continue;
    }
    const mk = `${entry.conditionId}|${entry.outcome}`;
    const prev = byMarketOutcome.get(mk);
    if (prev && prev.netUsd >= netUsd) continue;
    byMarketOutcome.set(mk, { entry, netUsd, formationTs });
  }
  if (belowFloor > 0) {
    console.log(
      `[follow] strategy ${params.id} (${sourceKind}) 净买门槛:剔除 ${belowFloor} 个钱包×市场组合` +
        `(窗口末尾净买 < $${floor})`,
    );
  }
  if (stale > 0) {
    console.log(
      `[follow] strategy ${params.id} (${sourceKind}) 新鲜度闸门:跳过 ${stale} 个陈旧跨线` +
        `(now − formationTs > ${params.freshSec}s)`,
    );
  }

  return [...byMarketOutcome.values()].map(
    ({ entry, netUsd, formationTs }) => ({
      conditionId: entry.conditionId,
      outcome: entry.outcome,
      outcomeIndex: entry.outcomeIndex,
      asset: entry.asset,
      title: entry.title,
      slug: entry.slug,
      eventSlug: entry.eventSlug,
      formationTs,
      referencePrice: avgBuyPrice(entry.acc),
      sourceKind,
      walletCount: 1,
      totalNetUsd: netUsd,
      // 向前落库快照:聚合净买 + 检测时可见评分(纯归因,不参与判定)。
      wallets: [
        {
          wallet: entry.wallet,
          netUsd,
          score: ctx.smart.get(entry.wallet)?.score ?? null,
        },
      ],
    }),
  );
}

/**
 * D1:高分独狼。单个钱包 score >= minWalletScore 且净买(净股数口径)
 * >= minNetUsd,不要求共识 —— 测的是"一个极好的钱包,一个人说了算吗"。
 * 与 B(heavy)的区别:B 看单笔金额,D1 看钱包质量。
 *
 * score===null(未知)视为不达标,与 A3/B3 同纪律:宁可漏跟不可误开 —— 一个
 * 从未被打过分的钱包,不能因为"未知"而被当作"反正不是低分"放行。
 *
 * minWalletScore 缺失时提前短路(不进入共享逻辑):与 minNetUsd 缺失一样,
 * 都是"必需参数没配,本策略本轮无候选",在这里单独判断是因为 minNetUsd 的
 * 校验发生在 detectWalletCandidates 内部(D2 也要用到那道校验),而
 * minWalletScore 是 D1 独有的必需参数,detectWalletCandidates 对它一无所知。
 */
export function detectLoneWolfCandidates(
  trades: Trade[],
  params: StrategyParams,
  ctx: DetectorCtx,
): FollowCandidate[] {
  const minScore = params.minWalletScore;
  if (minScore == null) {
    console.warn(
      `[follow] strategy ${params.id} (lone_wolf) minWalletScore 缺失,本策略本轮无候选`,
    );
    return [];
  }
  return detectWalletCandidates(
    trades,
    params,
    ctx,
    "lone_wolf",
    (_wallet, tag) => tag.score != null && tag.score >= minScore,
    `score>=${minScore}`,
  );
}

/**
 * D2:早期赢家跟投。由 early_winner 渠道(lib/earlyWinner.ts)发现的钱包开的
 * 新仓 —— 这批钱包的筛选轴是"在 <=40¢ 且距结算 >=24h 时押中赢家"
 * (EW_MAX_PRICE/EW_EARLY_LEAD_SEC),与 score 完全正交:score 的三个分量
 * (绝对利润/资金效率/胜率)里没有"敢在便宜时下重注"这个维度。
 *
 * 与 D1 的唯一差别:不看 score,看钱包是否属于 ctx.earlyWinnerWallets ——
 * 即使该钱包 score 很低甚至未知,只要它是 early_winner 渠道成员且净买达标,
 * 照样产出候选。其余判据(净买门槛、跨线语义、身份闸/MM 剔除、新鲜度、折叠
 * 规则)与 D1 完全共享同一个 detectWalletCandidates。
 *
 * ctx.earlyWinnerWallets 由 runFollowCycle 每轮预取一次(见 lib/follow.ts),
 * 预取失败时降级为空 Set —— 本函数对此无感知,空 Set 下 isQualified 恒假,
 * 自然产出空候选,不需要额外的降级分支。
 */
export function detectEarlyWinnerCandidates(
  trades: Trade[],
  params: StrategyParams,
  ctx: DetectorCtx,
): FollowCandidate[] {
  return detectWalletCandidates(
    trades,
    params,
    ctx,
    "early_winner",
    (wallet) => ctx.earlyWinnerWallets.has(wallet),
    "early_winner 渠道钱包",
  );
}
