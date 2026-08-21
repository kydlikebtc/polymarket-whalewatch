import type { DB } from "./db";
import { buildMarketCard, type MarketCard } from "./marketCard";
import { getMarketWindow, NoBudgetError } from "./marketWindow";
import type { fetchMarketWindow } from "./marketBrief";
import type { getWalletAges } from "./walletAge";
import type { fetchMarketMeta } from "./gamma";

// 卡片服务:窗口层之上的编排。窗口负责「贵不贵」,这里负责「给不给」。
//
// 两条路由(对外 /api/signals/market/[cid]、内部 /api/market/[cid])都经由此处,
// 于是共用同一个工作集与同一个令牌桶 —— 上游预算本来就是同一份,分两个桶只是把
// 同一个天花板切成两半;而人在网页上看的热门市场正好也是订阅方在看的,共享工作集
// 是净收益(互相预热)。

/**
 * 硬陈旧闸。超过它宁可 429 也不发卡。
 *
 * 为什么不是「带 staleSec 照给」:卡片说「3 个聪明钱刚买了 YES」,若其中 2 个在
 * 这几分钟里已经卖了,这张卡不是「不够新」,是**错的**,而且错在会让人亏钱的方向
 * 上。让客户端自己看 staleSec 判断是不够的 —— 客户端会为了不显示空白而照渲染。
 * 契约层面拒绝,才是真的拒绝。
 */
export const STALE_GATE_SEC = 90;

/** 429 时给客户端的退避建议;与窗口 TTL 同量级,重试大概率能等到一枚令牌。 */
const RETRY_AFTER_SEC = 30;

export type CardOutcome =
  | {
      ok: true;
      card: MarketCard;
      builtAt: number;
      staleSec: number;
      /** true = 数据在新鲜期内;false = 预算耗尽,发的是陈旧窗口重算的卡。 */
      live: boolean;
    }
  | { ok: false; status: 429; retryAfterSec: number };

export interface CardServiceDeps {
  nowSec: number;
  takeToken: (cost: number) => boolean;
  fetchWindow?: typeof fetchMarketWindow;
  agesFetcher?: typeof getWalletAges;
  metaFetcher?: typeof fetchMarketMeta;
}

/** 降级时顶掉元信息抓取:只读 market_meta 缓存,未命中就当没有。 */
const NO_UPSTREAM_META: typeof fetchMarketMeta = async () => ({});

export async function serveMarketCard(
  db: DB,
  conditionId: string,
  deps: CardServiceDeps,
): Promise<CardOutcome> {
  const { nowSec, takeToken, fetchWindow, agesFetcher, metaFetcher } = deps;
  let win;
  try {
    win = await getMarketWindow(conditionId, {
      nowSec,
      takeToken,
      fetchWindow,
    });
  } catch (e) {
    if (e instanceof NoBudgetError) {
      return { ok: false, status: 429, retryAfterSec: RETRY_AFTER_SEC };
    }
    throw e;
  }
  const staleSec = Math.max(0, nowSec - win.builtAt);
  if (staleSec > STALE_GATE_SEC) {
    return { ok: false, status: 429, retryAfterSec: RETRY_AFTER_SEC };
  }
  // 卡片每次现合成 —— 纯 CPU(composeMarketBrief)+ 本地 SQL(告警命中史)+
  // 永久缓存的账龄,几乎不要钱。这正是不必再存一份「卡片缓存」的理由:贵的是窗口。
  const card = await buildMarketCard(db, conditionId, {
    nowSec,
    fetchWindow: async () => ({ trades: win.trades, truncated: win.truncated }),
    agesFetcher,
    // 降级路径必须零上游 —— 元信息也不例外。gamma 与 data-api 虽是不同 host,
    // 但一条声称「不再向上游要任何东西」的路径上藏着网络调用,契约就是假的。
    metaFetcher: win.degraded ? NO_UPSTREAM_META : metaFetcher,
  });
  return {
    ok: true,
    card,
    builtAt: win.builtAt,
    staleSec,
    live: !win.degraded,
  };
}
