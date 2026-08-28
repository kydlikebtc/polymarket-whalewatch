import type { SmartTag } from "./smartWallets";
import { dedupKey, notionalUsd } from "./trades";
import type { Trade } from "./types";

// 聪明钱离场(第二梯队八件套,2026-08-28,设计
// docs/plans/2026-08-28-tier2-octet-design.md §三):现有全部检测都是进场
// 偏置 —— 池内钱包集体撤出一个结果,可能比进场更有信息量。卖侧镜像
// consensus 会计:净卖出 = max(0, 卖股 − 买股) × 卖出均价(窗内买回等股的
// 「假卖出」不合格,与 P0.6 成本敞口同族防线);MM 不计票(库存再平衡不是
// 方向性观点)。
//
// 窗口局限(页面口径必须写明):窗内只见卖、不见此前建仓 —— 「减持老仓」
// 正是要抓的事实,但无法区分获利了结与止损;也无法保证卖出者仍有剩余仓位。
// 零新增上游:消费 /api/consensus 路由已抓的双侧共享窗口,零 worker 改动、
// 零新告警类型 —— 纯展示层新 section。

export interface SmartExitOptions {
  minWallets: number;
  minPerWalletUsd: number;
}

export const DEFAULT_SMART_EXIT: SmartExitOptions = {
  minWallets: 2,
  minPerWalletUsd: 5000,
};

export interface SmartExitWallet {
  wallet: string;
  /** 净卖出敞口 = max(0, 卖股−买股) × 卖出均价。 */
  soldUsd: number;
  avgSellPrice: number;
  sellCount: number;
  score: number | null;
  winRate: number | null;
}

// 字段学对齐 ConsensusGroup(cohort 同款纪律):conditionId/outcome/title/
// slug/eventSlug/asset/outcomeIndex/wallets/walletCount/lastTs。
export interface SmartExitGroup {
  conditionId: string;
  outcome: string;
  title: string;
  slug: string;
  eventSlug: string;
  asset: string;
  outcomeIndex: number;
  wallets: SmartExitWallet[];
  walletCount: number;
  totalSoldUsd: number;
  /** USD 加权卖出均价。 */
  avgSellPrice: number;
  firstTs: number;
  lastTs: number;
}

interface Acc {
  buyShares: number;
  sellShares: number;
  sellUsd: number;
  sellCount: number;
  firstTs: number;
  lastTs: number;
}

const avgSell = (a: Acc): number =>
  a.sellShares > 0 ? a.sellUsd / a.sellShares : 0;
const soldExposure = (a: Acc): number =>
  Math.max(0, a.sellShares - a.buyShares) * avgSell(a);

/** 纯检测:窗口成交 + 池标签 → 离场组(合计卖出降序)。 */
export function detectSmartExits(
  trades: Trade[],
  smartTags: Map<string, SmartTag>,
  opts: SmartExitOptions = DEFAULT_SMART_EXIT,
): SmartExitGroup[] {
  const seen = new Set<string>();
  const groups = new Map<
    string,
    {
      conditionId: string;
      outcome: string;
      title: string;
      slug: string;
      eventSlug: string;
      asset: string;
      outcomeIndex: number;
      byWallet: Map<string, Acc>;
    }
  >();
  for (const t of trades) {
    const wallet = t.proxyWallet.toLowerCase();
    const tag = smartTags.get(wallet);
    // 只看池内非 MM:离场信号的全部含义就是「被认证过的钱在撤」。
    if (!tag || tag.isMarketMaker) continue;
    const dk = dedupKey(t);
    if (seen.has(dk)) continue;
    seen.add(dk);
    const key = `${t.conditionId}:${t.outcome}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        conditionId: t.conditionId,
        outcome: t.outcome,
        title: t.title,
        slug: t.slug,
        eventSlug: t.eventSlug,
        asset: t.asset,
        outcomeIndex: t.outcomeIndex,
        byWallet: new Map(),
      };
      groups.set(key, g);
    }
    let acc = g.byWallet.get(wallet);
    if (!acc) {
      acc = {
        buyShares: 0,
        sellShares: 0,
        sellUsd: 0,
        sellCount: 0,
        firstTs: t.timestamp,
        lastTs: t.timestamp,
      };
      g.byWallet.set(wallet, acc);
    }
    if (t.side === "SELL") {
      acc.sellShares += t.size;
      acc.sellUsd += notionalUsd(t);
      acc.sellCount += 1;
    } else {
      acc.buyShares += t.size;
    }
    if (t.timestamp < acc.firstTs) acc.firstTs = t.timestamp;
    if (t.timestamp > acc.lastTs) acc.lastTs = t.timestamp;
  }

  const out: SmartExitGroup[] = [];
  for (const g of groups.values()) {
    const qualified: SmartExitWallet[] = [];
    let firstTs = Infinity;
    let lastTs = 0;
    for (const [wallet, acc] of g.byWallet) {
      const soldUsd = soldExposure(acc);
      if (soldUsd < opts.minPerWalletUsd) continue;
      const tag = smartTags.get(wallet);
      qualified.push({
        wallet,
        soldUsd,
        avgSellPrice: avgSell(acc),
        sellCount: acc.sellCount,
        score: tag?.score ?? null,
        winRate: tag?.winRate ?? null,
      });
      firstTs = Math.min(firstTs, acc.firstTs);
      lastTs = Math.max(lastTs, acc.lastTs);
    }
    if (qualified.length < opts.minWallets) continue;
    qualified.sort((a, b) => b.soldUsd - a.soldUsd);
    const totalSoldUsd = qualified.reduce((s, w) => s + w.soldUsd, 0);
    const totalShares = qualified.reduce(
      (s, w) => s + (w.avgSellPrice > 0 ? w.soldUsd / w.avgSellPrice : 0),
      0,
    );
    out.push({
      conditionId: g.conditionId,
      outcome: g.outcome,
      title: g.title,
      slug: g.slug,
      eventSlug: g.eventSlug,
      asset: g.asset,
      outcomeIndex: g.outcomeIndex,
      wallets: qualified,
      walletCount: qualified.length,
      totalSoldUsd,
      avgSellPrice: totalShares > 0 ? totalSoldUsd / totalShares : 0,
      firstTs,
      lastTs,
    });
  }
  out.sort((a, b) => b.totalSoldUsd - a.totalSoldUsd);
  return out;
}
