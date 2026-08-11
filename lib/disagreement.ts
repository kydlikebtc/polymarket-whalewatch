import type { Trade } from "./types";
import type { SmartTag } from "./smartWallets";
import { dedupKey, notionalUsd } from "./trades";
import { avgBuyPrice, exposureUsd, netShares } from "./netPosition";

/**
 * Per-USD quality multiplier for a wallet's net buy, driven by its smart-money
 * score: score 0 (or unknown) keeps a 0.2 FLOOR so the wallet still counts but
 * is heavily discounted; score 100 saturates at 1.0. This is the "秤砣" that
 * makes the disagreement tilt reflect WHO is buying, not just how much — a
 * top-score wallet's $10k outweighs a fresh wallet's $20k.
 */
export function qualityWeight(score: number | null | undefined): number {
  const s = score == null ? 0 : Math.max(0, Math.min(100, score));
  return 0.2 + 0.8 * (s / 100);
}

// One wallet's net-buy position on a single side of a disagreement.
export interface DisagreementWallet {
  wallet: string;
  netUsd: number;
  score: number | null;
  winRate: number | null;
  avgBuyPrice: number; // size-weighted
}

// All net-buying smart money on ONE outcome of a contested market.
export interface DisagreementSide {
  outcome: string;
  outcomeIndex: number;
  asset: string;
  walletCount: number;
  netUsd: number; // raw net buy-in (for display)
  weightedUsd: number; // Σ netUsd × qualityWeight(score) — drives the tilt
  avgBuyPrice: number; // usd-weighted across the side's buyers
  wallets: DisagreementWallet[]; // net buyers, sorted by netUsd desc
  /**
   * 倾斜形成时刻:tiltPct 首次跨过 lopsidedTiltPct 的那一笔成交时间。只有
   * 【最终主导边】(sides[0],weightedUsd 最大者)会有值,其余边恒为 null ——
   * "形成"这个概念只对最终赢下这场分歧的一边有意义。从未跨过阈值(balanced
   * 市场)同样为 null。
   *
   * 用途:C1(一边倒分歧)跟单档的新鲜度闸门 / 进场护栏基准取价 / markout
   * 锚点,三者都靠它,定错了会同时失效。
   *
   * 为什么不能用市场级 firstTs/lastTs 代替:lastTs 被市场内任何白名单成交
   * (含 SELL、含不达标钱包)刷新 —— lib/follow.ts 的
   * FollowCycleDeps.fetchWindow 字段注释记录过这个已经修掉的 bug(5 小时前
   * 形成的老共识被一笔 $2k 卖单"续命"成新鲜,按现价跟入 → 买入成本失控)。
   * C1 若拿 lastTs 当 formationTs,等于把这个后门重新打开。
   *
   * 为什么不能用"本边自己成立时刻"(本边净买首次跨过 minPerSideUsd 那一刻)
   * 代替:多数边往往早就站住了,倾斜是后来少数边撤退才形成的 —— 用前者会让
   * formationTs 落在几小时前,900s 新鲜度闸门会把 C1 全部拦掉,这一档实质是
   * 个空档。
   *
   * 计算见 tiltFormationTs(与本检测函数同文件的私有重放函数)。
   */
  formationTs: number | null;
}

// "lopsided" = one side's quality-weight dominates (a "金矿"-shaped split);
// "balanced" = smart money is genuinely split (真·势均力敌).
export type Tilt = "lopsided" | "balanced";

// A market where whitelisted smart money is net-buying >= 2 opposing outcomes.
export interface DisagreementMarket {
  conditionId: string;
  title: string;
  // MARKET slug — drives the dashboard's ⧉ copy / ↗ trade-page affordance.
  slug: string;
  eventSlug: string;
  sides: DisagreementSide[]; // >= 2, sorted by weightedUsd desc
  totalNetUsd: number;
  totalWeightedUsd: number;
  tiltPct: number; // sides[0].weightedUsd / totalWeightedUsd (0.5..1)
  tilt: Tilt;
  excludedWallets: number; // hedgers dropped for playing both sides
  firstTs: number;
  lastTs: number;
}

export interface DisagreementOptions {
  minPerSideUsd: number; // each side's net buy >= this
  minWalletsPerSide: number; // each side needs >= this many net buyers
  lopsidedTiltPct: number; // tiltPct >= this → lopsided, else balanced
}

export const DEFAULT_DISAGREEMENT: DisagreementOptions = {
  minPerSideUsd: 5000,
  minWalletsPerSide: 1,
  lopsidedTiltPct: 0.7,
};

type WalletAcc = {
  buyUsd: number;
  sellUsd: number;
  buyShares: number;
  sellShares: number;
};

/**
 * 倾斜形成时刻的时序重放:按成交时间正序,重放【最终主导边】leadOutcome 的
 * "质量加权占比"何时首次达标(≥ opts.lopsidedTiltPct)。只对已经判定为
 * contested 的市场调用(detectDisagreement 里 sides.length>=2 之后),每市场
 * 一次 O(n log n)(排序)+ O(n) 重放,不是对全窗口跑 —— 通常每轮 contested
 * 市场是个位数。
 *
 * 口径纪律(必须与主检测同基准,否则会出现"重放说达标了,但主检测算出的最终
 * tiltPct 是 balanced"的自相矛盾):主检测里一侧的 netUsd/weightedUsd 是
 * Σ_{wallet: exposureUsd(wallet)>0} exposureUsd(wallet) × qualityWeight —— 只
 * 累计"留存净股数 × 买入均价"为正的钱包,净卖/等股回合的钱包贡献恒为 0,绝不
 * 会以负数拉低另一侧。这里按【每个 (outcome, wallet) 维护与主检测同结构的
 * WalletAcc,逐笔重放后取 exposureUsd 的增量(after − before)】来累计每个
 * outcome 的 net/weighted:对任一 wallet,Σ(exposureUsd 的增量) 端到端恒等于
 * 它最终的 exposureUsd(裂项相消:Σ(f(acc_i)−f(acc_{i-1})) = f(acc_n)−f(acc_0)
 * 对任意函数 f 成立,不要求线性,avgBuyPrice 随买入变动不影响这个等式),所以
 * 重放到窗口末尾时,本函数内部聚合的 net/weighted 与主检测 sides[].netUsd/
 * weightedUsd 逐分不差;又因为 exposureUsd 恒 ≥ 0,这里的 outcome 级聚合也
 * 恒 ≥ 0,不需要额外的负值钳制。(若改为直接按"逐笔带符号现金流"累加
 * per-outcome net —— 早期草案就是这么写的 —— 会与 exposureUsd 口径脱节:
 * 一个钱包高价买入、低价大量部分卖出时,现金流可以逼近 0 甚至为负,而
 * exposureUsd 仍是较大正数,两者能在深度换手的市场上给出方向相反的"净买"
 * 读数,让重放与主检测的最终判定互相矛盾 —— 见 disagreement.test.ts 里那条
 * SELL 回归测试:把 delta 退回裸现金流会让它读到错误的 formationTs,这条
 * 测试就是为了钉死这处口径,防止未来重构不小心退回去。)
 *
 * 达标判定:>=2 边过 opts.minPerSideUsd 的 USD floor,且 leadOutcome 自己也
 * 必须在这 qualified 集合里 —— 否则占比的分子可能来自一个还没过 floor 的边
 * (它的 exposureUsd 可以被高分钱包的 qualityWeight 放大到看起来很唬人),
 * 而分母只由**其它**已过线的边撑起,比值可以轻松 ≥ 1,把"这一边根本还没
 * 站稳"误判成"倾斜已形成"。
 *
 * 只认最终主导边:leadOutcome 是调用方传入的固定值(sides.sort 之后的
 * sides[0].outcome),重放全程只检查它的占比 —— 重放中途若由另一边短暂领先
 * 并达标,不算,我们要跟的是"现在这一边赢下这场分歧"的那一刻。
 *
 * 按秒【分批】判定,不能逐笔判定:Trade.timestamp 全程只有秒级精度,同一秒内
 * 完全可能有跨 outcome 的反向大单 —— 突发消息把市场打倾斜的那一刻,天然最
 * 容易有多笔成交扎堆落在同一秒。下面的 sorted 用的是稳定排序,同一 timestamp
 * 内谁先谁后取决于它们在 marketTrades 里的原始相对顺序,而那只是上游分页
 * 抓取/合并的实现细节,不代表链上真实执行序。若逐笔判定(处理完一笔立刻拿
 * 当前状态检查是否达标),同一秒内"另一笔反向成交还没被应用"的瞬时状态会被
 * 当成正式的达标时刻,结果随数组序摆动 —— 实测反例:Over/Under 各站稳 $10k
 * 后,同一秒两笔反向大单各 +$30k,完整算完这一秒后比例仍是 0.5(不该跨线),
 * 但数组序 [Over 那笔, Under 那笔] 会在处理完前者的瞬间读到 40000/50000=0.8
 * 并立即 return,顺序反过来则不会 —— 两个数组序对同一个真实事件给出不同
 * 答案,而数组序本身不是这个信号的一部分。修法:排序后按 timestamp 分组,
 * 组内全部成交先【完整应用】一遍("这一秒到底发生了什么"必须看完整),再对
 * 应用完这一整秒之后的状态做【一次】达标检查 —— 组内成交的相对顺序此时已
 * 不可观察,判定天然与之无关(见下方 applyTrade / isLeadQualified 的职责
 * 拆分:前者只管累加状态、绝不判定,后者只读当前状态、绝不感知时序)。
 *
 * 这里不能照搬 lib/consensus.ts 的 ConsensusGroup.formationTs 那套(取
 * qualifiedTs 升序第 minWallets 个):那边每个钱包的 crossTs 只由**它自己**
 * 的成交序列独立决定 —— 别的钱包同一秒做什么不影响这个钱包自身的
 * exposureUsd,取第 N 个天然免疫于同秒的相对顺序。这里的达标判定是**跨
 * outcome 的联合比例**(leadW/totalW,分子分母都汇总了多个钱包、多个 outcome
 * 的贡献),同一秒内不同 outcome 的成交会互相影响这同一个比例,是本质上更
 * 难、绕不开"这一秒必须整体看待"的问题,不能用 consensus 那套单钱包独立判定
 * 的思路简化。
 *
 * 从未达标 → 返回 null。调用方(sourceLopsided,Task 8)见 null 即不产出
 * 候选 —— fail-closed,绝不用 lastTs 之类的兜底值硬开仓。
 */
function tiltFormationTs(
  marketTrades: Trade[],
  leadOutcome: string,
  smartTags: Map<string, SmartTag>,
  excluded: Set<string>, // 已剔除的对冲者/MM,与主检测同一份,不重算
  opts: DisagreementOptions,
): number | null {
  // outcome -> wallet -> WalletAcc:与主检测同结构,逐笔重放到"此刻"的持仓。
  const byOutcome = new Map<string, Map<string, WalletAcc>>();
  // outcome -> 当前 { netUsd, weightedUsd },由每笔成交前后的 exposureUsd 差值
  // 增量维护(见函数头口径纪律)。
  const agg = new Map<string, { netUsd: number; weightedUsd: number }>();
  const seen = new Set<string>();

  // 应用单笔成交:更新 byOutcome/agg,不做任何达标判定。判定职责完全交给
  // isLeadQualified,只在同一秒整组应用完之后调用一次(见主循环)—— 这个
  // 拆分本身就是同秒乱序 bug 的修复,写在一起会诱使人在组内提前判定。
  const applyTrade = (t: Trade): void => {
    const wallet = t.proxyWallet.toLowerCase();
    const tag = smartTags.get(wallet);
    if (!tag || tag.isMarketMaker || excluded.has(wallet)) return;
    const dk = dedupKey(t);
    if (seen.has(dk)) return;
    seen.add(dk);

    let wallets = byOutcome.get(t.outcome);
    if (!wallets) {
      wallets = new Map();
      byOutcome.set(t.outcome, wallets);
    }
    let acc = wallets.get(wallet);
    if (!acc) {
      acc = { buyUsd: 0, sellUsd: 0, buyShares: 0, sellShares: 0 };
      wallets.set(wallet, acc);
    }
    const before = exposureUsd(acc);
    const usdVal = notionalUsd(t);
    if (t.side === "BUY") {
      acc.buyUsd += usdVal;
      acc.buyShares += t.size;
    } else {
      acc.sellUsd += usdVal;
      acc.sellShares += t.size;
    }
    const after = exposureUsd(acc);
    const delta = after - before; // 可正可负(round-trip 部分卖出会为负)
    const weight = qualityWeight(tag.score);
    const a = agg.get(t.outcome) ?? { netUsd: 0, weightedUsd: 0 };
    a.netUsd += delta;
    a.weightedUsd += delta * weight;
    agg.set(t.outcome, a);
  };

  // 用【当前累计状态】判定 leadOutcome 是否已达标 —— 不看时序,只读 agg 的
  // 快照,因此只要调用时机对(整组同秒成交应用完之后),结果天然与组内顺序
  // 无关。
  const isLeadQualified = (): boolean => {
    const qualified = [...agg.entries()].filter(
      ([, v]) => v.netUsd >= opts.minPerSideUsd,
    );
    if (qualified.length < 2) return false;
    // leadOutcome 必须自己也过 floor(见函数头注释的反例),否则占比的分子
    // 可能来自一个还没站稳的边,绝不把它误判成"已倾斜"。
    if (!qualified.some(([outcome]) => outcome === leadOutcome)) return false;
    const totalW = qualified.reduce((s, [, v]) => s + v.weightedUsd, 0);
    const leadW = agg.get(leadOutcome)?.weightedUsd ?? 0;
    return totalW > 0 && leadW / totalW >= opts.lopsidedTiltPct;
  };

  const sorted = [...marketTrades].sort((a, b) => a.timestamp - b.timestamp);
  let i = 0;
  while (i < sorted.length) {
    const ts = sorted[i].timestamp;
    let j = i;
    while (j < sorted.length && sorted[j].timestamp === ts) {
      applyTrade(sorted[j]);
      j++;
    }
    // 这一秒的成交已经全部应用完,现在才检查 —— 首次达标即返回,后续波动
    // (回落/再次跨过)不再重置。
    if (isLeadQualified()) return ts;
    i = j;
  }
  return null;
}

/**
 * Pure detection over a trade window: find markets where whitelisted smart
 * money is NET-BUYING two or more OPPOSING outcomes of the same market — the
 * "smart-money disagreement" signal. Mirrors detectConsensus's per-(market,
 * outcome, wallet) net-buy aggregation, then:
 *  - drops any wallet net-buying >= 2 outcomes of one market (a hedger /
 *    market-maker playing both sides — fake opposition, not an opinion);
 *  - builds a SIDE per outcome from the remaining NET BUYERS (a net seller of
 *    an outcome is exiting, not "buying" that side);
 *  - keeps sides clearing the per-side USD + wallet floors;
 *  - surfaces the market when >= 2 sides qualify, sorted by QUALITY-WEIGHTED
 *    amount, with a tilt (lopsided vs balanced).
 * Read-only monitoring: reports WHO is split and how the weight leans — never a
 * follow/skip recommendation.
 */
export function detectDisagreement(
  trades: Trade[],
  smartTags: Map<string, SmartTag>,
  opts: DisagreementOptions = DEFAULT_DISAGREEMENT,
): DisagreementMarket[] {
  const seen = new Set<string>();
  const markets = new Map<
    string,
    {
      title: string;
      slug: string;
      eventSlug: string;
      firstTs: number;
      lastTs: number;
      byOutcome: Map<
        string,
        {
          outcomeIndex: number;
          asset: string;
          byWallet: Map<string, WalletAcc>;
        }
      >;
    }
  >();

  // Aggregate net buy per (conditionId, outcome, wallet) — smart wallets only,
  // deduped (offset pagination re-serves boundary rows).
  for (const t of trades) {
    const wallet = t.proxyWallet.toLowerCase();
    // MM disenfranchisement (P0.5), same gate as detectConsensus: an MM
    // absorbing one side is liquidity provision, not directional opposition —
    // counting it would fake a "disagreement" and (via the mutex) suppress
    // the genuine consensus on the other side.
    const smartTag = smartTags.get(wallet);
    if (!smartTag || smartTag.isMarketMaker) continue;
    const dk = dedupKey(t);
    if (seen.has(dk)) continue;
    seen.add(dk);

    let m = markets.get(t.conditionId);
    if (!m) {
      m = {
        title: t.title,
        slug: t.slug,
        eventSlug: t.eventSlug,
        firstTs: t.timestamp,
        lastTs: t.timestamp,
        byOutcome: new Map(),
      };
      markets.set(t.conditionId, m);
    }
    if (t.timestamp < m.firstTs) m.firstTs = t.timestamp;
    if (t.timestamp > m.lastTs) m.lastTs = t.timestamp;

    let o = m.byOutcome.get(t.outcome);
    if (!o) {
      o = { outcomeIndex: t.outcomeIndex, asset: t.asset, byWallet: new Map() };
      m.byOutcome.set(t.outcome, o);
    }
    let acc = o.byWallet.get(wallet);
    if (!acc) {
      acc = { buyUsd: 0, sellUsd: 0, buyShares: 0, sellShares: 0 };
      o.byWallet.set(wallet, acc);
    }
    const usdVal = notionalUsd(t);
    if (t.side === "BUY") {
      acc.buyUsd += usdVal;
      acc.buyShares += t.size;
    } else {
      acc.sellUsd += usdVal;
      acc.sellShares += t.size;
    }
  }

  const out: DisagreementMarket[] = [];
  for (const [conditionId, m] of markets) {
    // Fake-opposition: a wallet NET-BUYING >= 2 outcomes of this market is a
    // hedger/market-maker, not a directional opinion — exclude from every side.
    // (Net-buying one outcome while net-SELLING another is directionally
    // consistent — e.g. bullish Yes, trimming No — and is NOT excluded.)
    const netBuyOutcomes = new Map<string, number>();
    for (const o of m.byOutcome.values()) {
      for (const [wallet, acc] of o.byWallet) {
        // 净股数口径(P0.6):只有真实留仓的结果才算"净买了该结果"。
        if (netShares(acc) > 0) {
          netBuyOutcomes.set(wallet, (netBuyOutcomes.get(wallet) ?? 0) + 1);
        }
      }
    }
    const excluded = new Set<string>();
    for (const [wallet, n] of netBuyOutcomes) if (n >= 2) excluded.add(wallet);

    // Build a side per outcome from the remaining NET BUYERS.
    const sides: DisagreementSide[] = [];
    for (const [outcome, o] of m.byOutcome) {
      const wallets: DisagreementWallet[] = [];
      let netUsd = 0;
      let weightedUsd = 0;
      let sumBuyUsd = 0;
      let sumBuyShares = 0;
      for (const [wallet, acc] of o.byWallet) {
        if (excluded.has(wallet)) continue;
        // 成本敞口口径(P0.6):留存净股数 × 买入均价 —— 等股买卖不同价的
        // "USD 假净买"不构成一侧;纯买入时与旧现金流口径数值一致。
        const net = exposureUsd(acc);
        if (net <= 0) continue; // flat / net sellers aren't buying this side
        const smart = smartTags.get(wallet);
        const score = smart?.score ?? null;
        netUsd += net;
        weightedUsd += net * qualityWeight(score);
        sumBuyUsd += acc.buyUsd;
        sumBuyShares += acc.buyShares;
        wallets.push({
          wallet,
          netUsd: net,
          score,
          winRate: smart?.winRate ?? null,
          avgBuyPrice: avgBuyPrice(acc),
        });
      }
      if (wallets.length < opts.minWalletsPerSide) continue;
      if (netUsd < opts.minPerSideUsd) continue;
      wallets.sort((a, b) => b.netUsd - a.netUsd);
      sides.push({
        outcome,
        outcomeIndex: o.outcomeIndex,
        asset: o.asset,
        walletCount: wallets.length,
        netUsd,
        weightedUsd,
        avgBuyPrice: sumBuyShares > 0 ? sumBuyUsd / sumBuyShares : 0,
        wallets,
        formationTs: null, // 占位;下面只对最终主导边(sides[0])重放覆盖
      });
    }

    if (sides.length < 2) continue; // no opposing sides → not a disagreement
    sides.sort((a, b) => b.weightedUsd - a.weightedUsd);
    const totalWeightedUsd = sides.reduce((s, x) => s + x.weightedUsd, 0);
    const totalNetUsd = sides.reduce((s, x) => s + x.netUsd, 0);
    const tiltPct =
      totalWeightedUsd > 0 ? sides[0].weightedUsd / totalWeightedUsd : 0;
    // 倾斜形成时刻:只对已经判定 contested 的市场重放(这里,不是全窗口 ——
    // 按 conditionId 从整窗筛出该市场的原始成交,交给 tiltFormationTs 自己
    // 做白名单/去重/hedger 过滤),只算【最终主导边】sides[0] 的达标时刻;
    // 非主导边不适用"形成"概念,保留上面 push 时的 null 占位。
    const marketTrades = trades.filter((t) => t.conditionId === conditionId);
    const leadFormationTs = tiltFormationTs(
      marketTrades,
      sides[0].outcome,
      smartTags,
      excluded,
      opts,
    );
    sides[0] = { ...sides[0], formationTs: leadFormationTs };
    out.push({
      conditionId,
      title: m.title,
      slug: m.slug,
      eventSlug: m.eventSlug,
      sides,
      totalNetUsd,
      totalWeightedUsd,
      tiltPct,
      tilt: tiltPct >= opts.lopsidedTiltPct ? "lopsided" : "balanced",
      excludedWallets: excluded.size,
      firstTs: m.firstTs,
      lastTs: m.lastTs,
    });
  }

  // Biggest quality-weighted contest first — a simple, stable default order.
  out.sort((a, b) => b.totalWeightedUsd - a.totalWeightedUsd);
  return out;
}
