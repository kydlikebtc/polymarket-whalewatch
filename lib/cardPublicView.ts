import type { MarketCard } from "./marketCard";

// 对外卡片的投影:把每钱包的**原始评分**换成分档。
//
// 理由是**契约稳定性,不是保密** —— 每钱包 score 早已在无 key 的
// /api/market/[cid] 上公开,只给对外端点打码是安全剧场。真正的问题是:raw score
// 是内部评分模型的输出,会随模型迭代漂移;把它写进对外契约,等于承诺「这个连续
// 值的语义永不变」,于是每次调模型都成了一次破坏性 API 变更。分档是稳定语义 ——
// 模型怎么调,都不改变「这个钱包算强」这件事。
//
// 内部面(网页/bot)保持原始分:仪表盘是我们自己的,跟着模型走没问题。
//
// winRate 不分档:它是**实测统计**(逐仓 realizedPnl 正负聚合,已处理归零仓的
// 幸存者偏差),不是模型输出,没有随版本漂移的问题。

export type ScoreBand = "high" | "mid" | "low";

/** 分档边界。改这两个数是破坏性变更,与改模型不同 —— 这正是分档的意义。 */
const HIGH = 80;
const MID = 60;

export function scoreBand(score: number | null | undefined): ScoreBand | null {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (score >= HIGH) return "high";
  if (score >= MID) return "mid";
  return "low";
}

/** 把一个带 score 的钱包对象换成带 scoreBand 的。原对象不动。 */
function bandWallet(w: unknown): unknown {
  if (typeof w !== "object" || w === null) return w;
  const { score, ...rest } = w as Record<string, unknown>;
  return { ...rest, scoreBand: scoreBand(score as number | null) };
}

function bandWallets(list: unknown): unknown {
  return Array.isArray(list) ? list.map(bandWallet) : list;
}

/**
 * score 藏在**三处**,漏一处就等于没做:
 *   1. brief.smartFlow[].wallets[]
 *   2. brief.classification.group.wallets[]        (共识)
 *   3. brief.classification.market.sides[].wallets[] (分歧)
 */
export function toPublicCard(card: MarketCard): MarketCard {
  const brief = card.brief as unknown as Record<string, any>;
  const cls = brief.classification as Record<string, any> | undefined;

  let publicCls = cls;
  if (cls?.kind === "consensus" && cls.group) {
    publicCls = {
      ...cls,
      group: { ...cls.group, wallets: bandWallets(cls.group.wallets) },
    };
  } else if (cls?.kind === "disagreement" && Array.isArray(cls.market?.sides)) {
    publicCls = {
      ...cls,
      market: {
        ...cls.market,
        sides: cls.market.sides.map((s: Record<string, unknown>) => ({
          ...s,
          wallets: bandWallets(s.wallets),
        })),
      },
    };
  }

  return {
    ...card,
    brief: {
      ...brief,
      classification: publicCls,
      smartFlow: Array.isArray(brief.smartFlow)
        ? brief.smartFlow.map((f: Record<string, unknown>) => ({
            ...f,
            wallets: bandWallets(f.wallets),
          }))
        : brief.smartFlow,
    },
  } as unknown as MarketCard;
}
