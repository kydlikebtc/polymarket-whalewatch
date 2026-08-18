// 插件通道的队列层 —— x_posts 表既是台账也是队列。
//
// 架构立场:extension 通道下 xBroadcast 只负责把候选落成 'queued',真正的
// 发帖动作发生在网络另一头的浏览器里。于是 claim-then-send 的那把"锁"从
// 进程内变成了跨网络,**必须带 TTL** —— 这是 leased/leased_at 存在的唯一
// 理由。锁的持有者可能永远不回来(浏览器崩溃、标签页被关、断网)。
//
// 两条不变量:
//   1. 状态只前进不回头。唯一的例外是 channel_error 与租约超时 → 退回
//      'queued':这两种情况下「这条帖到底发出去没有」的答案是确定的"没有"。
//      而 unconfirmed(点了发送但没抓到回执)恰恰是**不确定**的,所以它必须
//      是独立终态,绝不能退回队列重发。
//   2. 过期用墓碑('expired')不用删行。删行会腾空 (kind, dedup_key) 唯一
//      索引,下一轮同一条 alert 就会被重新入队 —— 「恢复后喷出一堆隔夜
//      旧闻」这个 bug 就是这么来的。
//
// 设计文档:docs/plans/2026-08-18-x-extension-channel-design.md §4 §8
import type { DB } from "./db";

export type XAckResult = "posted" | "unconfirmed" | "failed" | "channel_error";

export interface LeasedPost {
  id: number;
  kind: string;
  text: string;
  /** weekly 帖的图卡地址,由路由层按 kind 填充;其余 kind 恒为 null。 */
  imageUrl: string | null;
}

// 优先级:独家/稀有的先走。插件一轮只拉几条,而 whale 是量最大的一类 ——
// 不排序的话,一波大单能把窗口整个占满,共识信号要等好几轮才轮得到。
// 与 xBroadcast 里 api 通道的排序哲学一致(consensus 优先)。
const PRIORITY_SQL = `CASE kind
    WHEN 'consensus' THEN 0
    WHEN 'weekly'    THEN 1
    WHEN 'pregame'   THEN 2
    ELSE 3 END`;

/**
 * 原子租借:选中 → 置 leased。整体包在事务里,所以两个并发请求(两台设备、
 * 或一次重试)不会拿到同一条。
 *
 * 不用 `UPDATE ... LIMIT`:better-sqlite3 默认未编译
 * SQLITE_ENABLE_UPDATE_DELETE_LIMIT,那条语法会直接报语法错误。
 */
export function leaseQueued(
  db: DB,
  opts: { limit: number; nowSec: number },
): LeasedPost[] {
  const run = db.transaction((limit: number, nowSec: number): LeasedPost[] => {
    const rows = db
      .prepare(
        `SELECT id, kind, text FROM x_posts
          WHERE status = 'queued' AND channel = 'extension'
          ORDER BY ${PRIORITY_SQL}, created_at ASC, id ASC
          LIMIT ?`,
      )
      .all(limit) as { id: number; kind: string; text: string }[];
    if (rows.length === 0) return [];
    // 逐行加 `AND status = 'queued'` 条件更新:即便有并发把某行抢先改掉,
    // changes===0 会让它落选,而不是被我们当成已租借返回出去。
    const mark = db.prepare(
      "UPDATE x_posts SET status = 'leased', leased_at = ? WHERE id = ? AND status = 'queued'",
    );
    const out: LeasedPost[] = [];
    for (const r of rows) {
      if (mark.run(nowSec, r.id).changes === 1) {
        out.push({ id: r.id, kind: r.kind, text: r.text, imageUrl: null });
      }
    }
    return out;
  });
  return run(opts.limit, opts.nowSec);
}

// 三种终态。channel_error 不在这里 —— 它不是终态,是"退回重来"。
const TERMINAL: Record<Exclude<XAckResult, "channel_error">, string> = {
  posted: "posted",
  // 点了发送但 6 秒内没抓到 CreateTweet 回执。既不能当成功(x_post_id 为空
  // 会污染周报统计)也不能当失败(重发 = 重复发帖)—— /manage 高亮等人工核对。
  unconfirmed: "posted_unconfirmed",
  failed: "failed",
};

/**
 * 结算一条。返回 false = 这条不在 leased 态(重复 ack、或已被租约回收)。
 * 调用方应把 false 当成"已处理"而不是错误:at-least-once 下重复 ack 是
 * 正常流量(插件本地补 ack 的必然结果),不是异常。
 */
export function ackQueued(
  db: DB,
  opts: {
    id: number;
    result: XAckResult;
    xPostId?: string | null;
    nowSec: number;
  },
): boolean {
  if (opts.result === "channel_error") {
    // 通道级故障:这条帖本身没问题,退回队列等通道恢复。必须同时清掉
    // leased_at,否则下一次租约超时判定会读到陈旧时间戳。
    return (
      db
        .prepare(
          `UPDATE x_posts SET status = 'queued', leased_at = NULL
            WHERE id = ? AND status = 'leased'`,
        )
        .run(opts.id).changes === 1
    );
  }
  return (
    db
      .prepare(
        `UPDATE x_posts SET status = ?, x_post_id = ?, leased_at = NULL
          WHERE id = ? AND status = 'leased'`,
      )
      .run(TERMINAL[opts.result], opts.xPostId ?? null, opts.id).changes === 1
  );
}

/**
 * 每轮由 worker 调用的双回收。返回各自条数(进日志 —— 调试者要能一眼看出
 * "队列是被消费掉的还是被超时收掉的")。
 *
 * 顺序不可换:**先退租约再判过期**。一条既超租约又超 TTL 的行,如果先判
 * 过期,它还挂在 leased 上匹配不到,就会永远收不掉。
 */
export function reclaimStale(
  db: DB,
  opts: { nowSec: number; queueTtlSec: number; leaseTtlSec: number },
): { expired: number; reclaimed: number } {
  const reclaimed = db
    .prepare(
      `UPDATE x_posts SET status = 'queued', leased_at = NULL
        WHERE status = 'leased' AND channel = 'extension'
          AND leased_at IS NOT NULL AND leased_at < ?`,
    )
    .run(opts.nowSec - opts.leaseTtlSec).changes;
  const expired = db
    .prepare(
      `UPDATE x_posts SET status = 'expired'
        WHERE status = 'queued' AND channel = 'extension' AND created_at < ?`,
    )
    .run(opts.nowSec - opts.queueTtlSec).changes;
  return { expired, reclaimed };
}

/** 待发条数。健康探测(积压告警)与 popup 都读它。 */
export function queueDepth(db: DB): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM x_posts
          WHERE status = 'queued' AND channel = 'extension'`,
      )
      .get() as { n: number }
  ).n;
}
