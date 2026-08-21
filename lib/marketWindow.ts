import type { Trade } from "./types";
import { dedupKey } from "./trades";
import { fetchMarketWindow } from "./marketBrief";
import { CARD_WINDOW_SEC } from "./marketCard";
import type { DB } from "./db";
import { loadPersistedWindow, persistWindow } from "./marketWindowStore";

// 市场深度卡的窗口层。
//
// 定位:**贵的是窗口,不是卡片**。composeMarketBrief 是纯函数、告警命中史是本地
// SQL、钱包账龄永久缓存 —— 拿一份已有窗口重算一张卡几乎不要钱。所以缓存与预算
// 都围着窗口转,卡片每次现合成。这也是不必再存一份「卡片缓存」的理由。
//
// 增量续抓:24h 窗口里只有最近这一分钟是新的,整窗重抓是在重付已经付过的钱。
// 记住上次见到的最新成交时刻,续抓时 fetchMarketWindow 会在第 0 页就
// `oldest < sinceSec` 而停 —— 与引擎告警循环 hasSeenAny 的止页是同一招。
// 于是:冷启 1–13 个请求(只付一次),热续恒 1 个请求。

/**
 * 把续抓到的成交并入既有窗口。
 * 去重按 dedupKey(续抓必然重复覆盖锚点那一笔);结果 newest-first;
 * 早于 cutoffSec 的尾部丢弃 —— 窗口是滑动的,不是累积的。
 */
export function mergeWindow(
  prev: Trade[],
  incoming: Trade[],
  cutoffSec: number,
): Trade[] {
  const seen = new Set<string>();
  const out: Trade[] = [];
  // incoming 在前:同一笔成交若两侧都有,留新抓到的那份。
  for (const t of [...incoming, ...prev]) {
    if (t.timestamp < cutoffSec) continue;
    const k = dedupKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out;
}

// ---------------------------------------------------------------------------
// 工作集:进程内 LRU + 在途合并
// ---------------------------------------------------------------------------

/** 窗口新鲜期。也是卡片的年龄上限 —— 两者是同一个数。 */
export const WINDOW_TTL_SEC = 30;
/** 工作集上限(市场数)。单市场 24h/$500 约 ~200KB,200 个约 40MB。 */
export const WINDOW_LRU_MAX = 200;

/** 既没令牌又没窗口 —— 没有任何诚实的东西可返回,由调用方转 429。 */
export class NoBudgetError extends Error {
  constructor() {
    super("upstream budget exhausted and no cached window");
    this.name = "NoBudgetError";
  }
}

interface WindowEntry {
  trades: Trade[];
  truncated: boolean;
  /** 续抓锚点:上次见到的最新成交时刻。 */
  newestTs: number;
  /** 本窗口最后一次成功续抓的时刻。 */
  builtAt: number;
  /** LRU 用。 */
  touchedAt: number;
}

const windows = new Map<string, WindowEntry>();
// 在途合并:同一 cid 的并发请求共用一次续抓,而不是各发各的 —— 没有它,
// 一个热门市场的并发会把令牌桶按并发数而非按市场数消耗掉。
//
// **刻意不用 createPromiseCache**:那个带 TTL,而 TTL 走墙钟毫秒,窗口的新鲜
// 判定走逻辑 nowSec —— 同一个「新不新鲜」的问题两个时钟各答一遍,必然分叉。
// 在途合并本来就不需要 TTL:新鲜度归 builtAt 管,这里只需要「并发共用一个
// promise,settle 后立刻删掉」。
const inFlight = new Map<string, Promise<WindowEntry>>();

/**
 * 运营可观测的五个计数 + 工作集大小。进程内累计,重启归零 —— 它回答的是
 * 「这个进程活着这段时间里,预算花在哪了」,不是历史统计。
 *
 * 为什么这五个:cold/warm 分开,是因为二者的上游成本差一个数量级(1–13 页 vs
 * 恒 1 页),混在一起就看不出「工作集有没有预热起来」;hit 与它们的比值就是
 * 缓存效率;degraded/refused 是背压的两级,前者还能给答案、后者已经在拒绝 ——
 * refused 持续非零意味着预算或工作集上限该调了。
 */
export interface WindowStats {
  /** 冷启:工作集里没有,整窗抓。 */
  cold: number;
  /** 热续:有窗口但过了新鲜期,增量抓。 */
  warm: number;
  /** 新鲜期内直接命中,零上游。 */
  hit: number;
  /** 没预算但有陈旧窗口,降级返回。 */
  degraded: number;
  /** 没预算也没窗口,拒绝(上层转 429)。 */
  refused: number;
  /** 当前工作集里的市场数。 */
  workingSet: number;
}

const stats = { cold: 0, warm: 0, hit: 0, degraded: 0, refused: 0 };

export function windowStats(): WindowStats {
  return { ...stats, workingSet: windows.size };
}

export function windowCount(): number {
  return windows.size;
}

/** 仅供测试:清空工作集、在途表与计数。 */
export function __resetWindows(): void {
  windows.clear();
  inFlight.clear();
  stats.cold = 0;
  stats.warm = 0;
  stats.hit = 0;
  stats.degraded = 0;
  stats.refused = 0;
}

export interface MarketWindowResult {
  trades: Trade[];
  truncated: boolean;
  builtAt: number;
  /** true = 本次没拿到令牌,返回的是陈旧窗口。 */
  degraded: boolean;
}

/** data-api 的 /trades 每页上限,与 lib/marketBrief 的 PAGE_LIMIT 同源。 */
const PAGE_LIMIT = 250;

export interface MarketWindowDeps {
  nowSec: number;
  /**
   * 花掉 `cost` 枚令牌,返回是否仍在预算内。
   *
   * 令牌近似的是**向上游发了几个请求**,所以冷启(翻 1–13 页)不能和热续
   * (恒 1 页)收同样的钱:那样进程刚重启、工作集全空时,预算会被超出十几倍,
   * 而那正是最脆弱的时刻。页数由抓回的行数反推,抓完补收差额。
   */
  takeToken: (cost: number) => boolean;
  fetchWindow?: typeof fetchMarketWindow;
  /**
   * 给了就启用持久化:内存工作集未命中时从存档水合,续抓后节流落盘。
   * 可选 —— 落库是「重启后不必冷启」这一件事的增强,不是窗口层的必需依赖,
   * 纯单元测试不该被迫开一个库。
   */
  db?: DB;
  /** 窗口新鲜期,缺省用常量。运营可调(lib/cardSettings)。 */
  ttlSec?: number;
  /** 工作集上限,缺省用常量。 */
  lruMax?: number;
}

/**
 * 取某市场的 24h 成交窗口。三条出路:
 *   - 窗口还新鲜 → 原样返回,零上游;
 *   - 拿到令牌 → 增量续抓(冷启则整窗)后返回;
 *   - 没令牌 → 有陈旧窗口就降级返回,没有就抛 NoBudgetError。
 */
export async function getMarketWindow(
  conditionId: string,
  deps: MarketWindowDeps,
): Promise<MarketWindowResult> {
  const {
    nowSec,
    takeToken,
    fetchWindow = fetchMarketWindow,
    db,
    ttlSec = WINDOW_TTL_SEC,
    lruMax = WINDOW_LRU_MAX,
  } = deps;
  // 归一化键:0xAB… 与 0xab… 是同一个市场,不该占两份工作集与两次预算。
  const cid = conditionId.toLowerCase();
  let prev = windows.get(cid);
  if (!prev && db) {
    // 进程重启后的第一次访问:库里还留着上一个进程的窗口。水合进来,这一次
    // 就是**热续而非冷启** —— 否则重启那一刻若干热门市场同时被访问,就是一次
    // 自伤式的上游冲击,恰好在服务刚起来、最该表现稳的时候。
    const archived = loadPersistedWindow(db, cid, nowSec);
    if (archived) {
      prev = { ...archived, touchedAt: nowSec };
      windows.set(cid, prev);
      evictLru(lruMax);
    }
  }

  if (prev && nowSec - prev.builtAt < ttlSec) {
    prev.touchedAt = nowSec;
    stats.hit++;
    return { ...toResult(prev), degraded: false };
  }
  // 在途检查必须在取令牌**之前**:加入一次已在飞的续抓是免费的,而令牌计量的
  // 是「向上游发了几次」。反过来写的话,热门市场的 N 个并发会烧掉 N 枚令牌却
  // 只做 1 次抓取 —— 那正好把「按市场数计量」这个全部意义给废掉。
  const running = inFlight.get(cid);
  if (running) return { ...toResult(await running), degraded: false };

  if (!takeToken(1)) {
    // 预算耗尽:有陈旧窗口就降级(陈旧闸由上层判),没有就诚实拒绝。
    if (prev) {
      prev.touchedAt = nowSec;
      stats.degraded++;
      return { ...toResult(prev), degraded: true };
    }
    stats.refused++;
    throw new NoBudgetError();
  }

  const started = (async () => {
    // 冷启抓整窗;热续只抓 newestTs 之后 —— fetchMarketWindow 会在
    // `oldest < sinceSec` 时停止翻页,于是第 0 页就止,恒 1 个请求。
    const cutoff = nowSec - CARD_WINDOW_SEC;
    const sinceSec = prev ? prev.newestTs : cutoff;
    if (prev) stats.warm++;
    else stats.cold++;
    const got = await fetchWindow(conditionId, { sinceSec });
    // 补收差额:闸门只先收了 1 枚,而这次实际翻了 ceil(行数/250) 页。
    // 结果忽略 —— 钱已经花出去了,记账必须如实,拒绝要等下一次进闸门。
    const pages = Math.max(1, Math.ceil(got.trades.length / PAGE_LIMIT));
    if (pages > 1) takeToken(pages - 1);
    const merged = mergeWindow(prev?.trades ?? [], got.trades, cutoff);
    const next: WindowEntry = {
      trades: merged,
      truncated: got.truncated,
      // 空窗口时锚点保持在本次下界,否则下一轮又会退回整窗抓。
      newestTs: merged[0]?.timestamp ?? sinceSec,
      builtAt: nowSec,
      touchedAt: nowSec,
    };
    windows.set(cid, next);
    evictLru(lruMax);
    if (db) {
      // 落盘失败绝不能影响出卡:存档只是重启优化,没有它一切照常(冷启一次)。
      try {
        persistWindow(db, cid, next, nowSec);
      } catch (e) {
        console.warn(`[marketWindow] 存档写入失败 ${cid}:`, e);
      }
    }
    return next;
  })();
  inFlight.set(cid, started);
  // 成败都要摘掉在途标记,否则一次失败会把这个 cid 永久钉在旧 promise 上。
  // 只摘自己那份:更新的一次续抓不该被旧的清理掉。
  const clear = () => {
    if (inFlight.get(cid) === started) inFlight.delete(cid);
  };
  started.then(clear, clear);
  return { ...toResult(await started), degraded: false };
}

function toResult(e: WindowEntry) {
  return { trades: e.trades, truncated: e.truncated, builtAt: e.builtAt };
}

function evictLru(lruMax: number = WINDOW_LRU_MAX): void {
  while (windows.size > lruMax) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, v] of windows) {
      if (v.touchedAt < oldest) {
        oldest = v.touchedAt;
        oldestKey = k;
      }
    }
    if (oldestKey === null) return;
    windows.delete(oldestKey);
  }
}
