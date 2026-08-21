import type { Trade } from "./types";
import { dedupKey } from "./trades";

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
