import type { DB } from "./db";
import { gradeRows, type SignalRecord } from "./signalRecord";

// 对外信号批次 0:strategy_signals 事实台账(设计:docs/plans/
// 2026-08-13-external-signal-system-design.md §4.2/§4.3)。
//
// 定位:把「某档策略在某市场某方向触发过买入」从 follow_positions 的隐含状态
// 升格为一条不可变事件 —— 投递总线(批次 1)、API strategies 段(批次 2)、
// webhook/存证(批次 3)全部只消费这张表,detector 与开仓代码永远不知道
// 通道存在。
//
// 三条纪律:
//   1. UNIQUE(strategy_id, condition_id, outcome) 与 follow_positions 同粒度,
//      INSERT OR IGNORE 幂等 —— 并发/重放安全,与 alerts 表同一形状。
//   2. 结算回填只补结果列(settled/settled_ts/exit_price/won/realized_pnl),
//      身份字段一经写入不再触碰;settled=0 守卫使回填天然一次性。
//   3. 台账是下游功能:调用方(lib/follow.ts 接线处)必须 try/catch,任何
//      台账故障只 warn,绝不影响纸面开仓/结算主流程。

export interface StrategySignalInput {
  strategyId: number;
  /** follow_positions.id —— 信号 → 仓位的因果链(结算回填按它定位)。 */
  positionId: number | null;
  conditionId: string;
  outcome: string;
  outcomeIndex: number;
  asset: string;
  title: string;
  slug: string;
  eventSlug: string;
  /** 信号成立时刻(detector 语义,非发布时刻)。 */
  formationTs: number;
  /** 聪明钱成本基准(FollowCandidate.referencePrice)。 */
  referencePrice: number;
  walletCount: number;
  totalNetUsd: number;
  /** 我们的纸面入场价(现价,非聪明钱均价)。 */
  entryPrice: number;
  sizeUsd: number;
  /** 发布时刻 = 开仓那一轮的 nowSec —— 存证锚点(先发布后结算)。 */
  emittedAt: number;
}

/**
 * 落一条信号事实。返回新行 id;UNIQUE 命中(该档已对这个市场方向发过信号)
 * 返回 null —— 与开仓侧 `res.changes === 1` 的计数纪律同构。
 */
export function recordStrategySignal(
  db: DB,
  input: StrategySignalInput,
): number | null {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO strategy_signals
         (strategy_id, position_id, condition_id, outcome, outcome_index, asset,
          title, slug, event_slug, formation_ts, reference_price, wallet_count,
          total_net_usd, entry_price, size_usd, emitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.strategyId,
      input.positionId,
      input.conditionId,
      input.outcome,
      input.outcomeIndex,
      input.asset,
      input.title,
      input.slug,
      input.eventSlug,
      input.formationTs,
      input.referencePrice,
      input.walletCount,
      input.totalNetUsd,
      input.entryPrice,
      input.sizeUsd,
      input.emittedAt,
    );
  return res.changes === 1 ? Number(res.lastInsertRowid) : null;
}

export interface SignalSettlement {
  settledTs: number;
  exitPrice: number;
  realizedPnl: number;
}

/**
 * 结算回填:按 position_id 定位台账行,补结果列。won 的三态与全站 push 纪律
 * 同源:pnl>0 → 1、<0 → 0、===0 → null(平局不进任何胜率分母)。
 * settled=0 守卫:已回填的行不再改写(结算是一次性事实);老仓(批次 0 之前
 * 开的,无台账行)天然 no-op。返回是否真的写入了一行。
 */
export function backfillSignalSettlement(
  db: DB,
  positionId: number,
  s: SignalSettlement,
): boolean {
  const won = s.realizedPnl > 0 ? 1 : s.realizedPnl < 0 ? 0 : null;
  const res = db
    .prepare(
      `UPDATE strategy_signals
         SET settled = 1, settled_ts = ?, exit_price = ?, won = ?, realized_pnl = ?
       WHERE position_id = ? AND settled = 0`,
    )
    .run(s.settledTs, s.exitPrice, won, s.realizedPnl, positionId);
  return res.changes === 1;
}

/**
 * 某档策略近 30 天的价格调整战绩 —— 对外披露的唯一战绩口径。
 *
 * 数据源刻意取 follow_positions(该档全部纸面历史)而非 strategy_signals:
 * 台账从批次 0 才开始积累,而策略的真实履历早于它;两者的行在批次 0 之后
 * 一一对应(同 UNIQUE 粒度),取仓位表让战绩行从第一天就有意义。
 *
 * 口径:窗口按 entry_ts(信号在 30d 内触发)、只算已结算、push(pnl===0)
 * 整行排除(与 computeStrategyMetrics 的分母纪律一致)、side 恒 BUY(纸面
 * 跟单只有买入),implied 即入场价本身。汇总必须经 gradeRows —— 全站战绩
 * 数字的唯一实现,见 lib/signalRecord.ts。
 */
export function strategyRecord30d(
  db: DB,
  strategyId: number,
  nowSec: number,
): SignalRecord {
  const rows = db
    .prepare(
      `SELECT entry_price AS price, realized_pnl AS pnl
       FROM follow_positions
       WHERE strategy_id = ? AND status = 'settled' AND entry_ts >= ?
         AND realized_pnl IS NOT NULL AND realized_pnl != 0`,
    )
    .all(strategyId, nowSec - 30 * 86_400) as {
    price: number | null;
    pnl: number;
  }[];
  return gradeRows(
    rows.map((r) => ({
      won: r.pnl > 0 ? 1 : 0,
      price: r.price,
      side: "BUY",
    })),
  );
}
