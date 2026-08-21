import type { DB } from "./db";
import { TradeSchema, type Trade } from "./types";
import { CARD_WINDOW_SEC } from "./marketCard";

// 窗口层的持久化。**只为一件事存在:进程重启后不必把整个工作集重新冷启。**
//
// 冷启一个市场要翻 1–13 页,而重启那一刻工作集全空;若干个热门市场同时被访问
// 就是一次自伤式的上游冲击 —— 恰好发生在服务刚起来、最该表现稳的时候。
//
// 两条让它便宜下来的设计:
//
//  1. **存档不必是最新的,只要够近。** 重启后读回一份 5 分钟前的窗口,续抓时
//     `sinceSec` 就是那份的 newestTs —— 单个市场 5 分钟内的 $500+ 成交远不到
//     250 笔,所以补齐仍是**一页**。于是落盘可以节流:每市场每 PERSIST_INTERVAL_SEC
//     最多写一次,写放大直接降一个数量级(热门市场本会每 30 秒刷新一次)。
//
//  2. **超窗即失效。** 存档比 24h 还老时整个窗口都已滚出下界,读回来是骗人 ——
//     直接当没有,老老实实冷启。

/** 每个市场最多多久落一次盘。见文件头「存档不必是最新的,只要够近」。 */
export const PERSIST_INTERVAL_SEC = 300;

export interface PersistedWindow {
  trades: Trade[];
  truncated: boolean;
  newestTs: number;
  builtAt: number;
}

/**
 * 读回存档。超过窗口跨度(24h)的、解析不出来的,一律当没有 ——
 * 一行坏存档不该让端点挂掉,冷启一次就是全部代价。
 */
export function loadPersistedWindow(
  db: DB,
  conditionId: string,
  nowSec: number,
): PersistedWindow | null {
  const row = db
    .prepare(
      `SELECT trades_json, newest_ts, built_at, truncated
         FROM market_window_cache WHERE condition_id = ?`,
    )
    .get(conditionId.toLowerCase()) as
    | {
        trades_json: string;
        newest_ts: number;
        built_at: number;
        truncated: number | null;
      }
    | undefined;
  if (!row) return null;
  if (nowSec - row.built_at > CARD_WINDOW_SEC) return null;
  try {
    const raw = JSON.parse(row.trades_json) as unknown;
    if (!Array.isArray(raw)) return null;
    // 逐行过 schema:存档是上一个进程写的,版本可能不同步;宁可丢掉几行
    // 也不要把形状不对的东西喂进 composeMarketBrief。
    const trades = raw.flatMap((t) => {
      const p = TradeSchema.safeParse(t);
      return p.success ? [p.data] : [];
    });
    // 「本来就是空的」与「有行但全部解析失败」是两件事:前者是合法事实(这个
    // 市场 24h 内确实没有达标成交),后者是损坏存档。判据必须分开 —— 都当成
    // null 的话,写进去却拒绝读回来,锚点白丢、每次重启都退回冷启。
    if (raw.length > 0 && trades.length === 0) return null;
    return {
      trades,
      truncated: row.truncated === 1,
      newestTs: row.newest_ts,
      builtAt: row.built_at,
    };
  } catch {
    return null;
  }
}

/** 落盘(节流)。返回是否真的写了。 */
export function persistWindow(
  db: DB,
  conditionId: string,
  entry: PersistedWindow,
  nowSec: number,
): boolean {
  const cid = conditionId.toLowerCase();
  const prev = db
    .prepare(
      "SELECT persisted_at FROM market_window_cache WHERE condition_id = ?",
    )
    .get(cid) as { persisted_at: number } | undefined;
  if (prev && nowSec - prev.persisted_at < PERSIST_INTERVAL_SEC) return false;
  db.prepare(
    `INSERT OR REPLACE INTO market_window_cache
       (condition_id, trades_json, newest_ts, built_at, truncated, persisted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    cid,
    JSON.stringify(entry.trades),
    entry.newestTs,
    entry.builtAt,
    entry.truncated ? 1 : 0,
    nowSec,
  );
  return true;
}

/** 清掉已经超窗的存档。返回删除行数。 */
export function prunePersistedWindows(db: DB, nowSec: number): number {
  const res = db
    .prepare("DELETE FROM market_window_cache WHERE built_at < ?")
    .run(nowSec - CARD_WINDOW_SEC);
  return res.changes;
}
