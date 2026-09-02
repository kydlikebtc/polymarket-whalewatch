import type { DB } from "./db";
import type { CandidateWallet } from "./followCandidate";
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
//   4. 纪律 3 的代价是回填可能被吞:仓位已 settled 而台账仍 settled=0,且下轮
//      结算集只取 open 仓不会再碰它。reconcileSignalSettlements 每轮一条 JOIN
//      对账兜底(仓位行是真相),同样 try/catch 只 warn。

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
  /**
   * 触发钱包快照(FollowCandidate.wallets 原样透传,顺序不重排)。可选:
   * 缺省落 NULL —— 老行/未接 detector 的行自描述「早于向前落库批次」,
   * walk-forward v2 按 IS NOT NULL 划可回放窗口。
   */
  wallets?: CandidateWallet[];
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
          total_net_usd, entry_price, size_usd, emitted_at, wallets_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.wallets == null ? null : JSON.stringify(input.wallets),
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

/** reconcileSignalSettlements 的 JOIN 行:台账 id + 仓位侧的结算结果列。 */
interface StraySettlementRow {
  signal_id: number;
  position_id: number;
  exit_ts: number | null;
  exit_price: number | null;
  realized_pnl: number | null;
}

/**
 * 结算对账(幂等兜底):补齐「仓位已 settled、台账仍 settled=0」的漏网行。
 *
 * 为什么会漏:runFollowCycle 结算段先 UPDATE follow_positions,再在 try/catch
 * 里调 backfillSignalSettlement;回填一旦抛错(SQLITE_BUSY/磁盘)只 warn,而
 * 下一轮结算集只取 status='open' 的仓 —— 这个仓不会再被处理,台账行永久卡在
 * settled=0:active[] 里挂满 48h,signalDelivery 的 settle 段与 strategyFeed
 * 的 events[] 发不出它的兑现事件。
 *
 * 口径:仓位行是真相(全仓库唯一的 settled 写入点在 lib/follow.ts,三列同写)。
 * settled_ts 取仓位 exit_ts(真实结算时刻,不是对账时刻)—— 下游 7d 陈旧闸 /
 * 48h 窗口据此决定还发不发,迟到的兑现不能伪装成新鲜的。won 三态经
 * backfillSignalSettlement 同一条路径,不另写第二份规则。
 *
 * 不制造事实:仓位 exit_ts/exit_price/realized_pnl 任一为 NULL(status 与结果列
 * 自相矛盾,正常路径不可达)→ 跳过。既不把 NULL 当结果写进台账,也不编造时间戳
 * —— 编出来的 settled_ts 会让一条来路不明的兑现同时穿过两道闸,以「刚刚认账」
 * 推给付费通道。坏行不会自愈,故每轮合并成一条 warn 列出全部 signal/position
 * id(逐行逐轮喊会以 288 条/天淹掉日志)。
 *
 * 容错:单行写入抛错(BUSY/IO)只 warn(带两个 id)并继续同批其它行 —— 一行
 * 故障不拖累整批,漏掉的下轮再补;SELECT 本身的故障由调用方 lib/follow.ts 的
 * 外层 try/catch 兜住。成本:每轮一条 JOIN 查询;无漏网时零写入。返回补齐行数。
 */
export function reconcileSignalSettlements(db: DB): number {
  const strays = db
    .prepare(
      `SELECT s.id AS signal_id, s.position_id, p.exit_ts, p.exit_price, p.realized_pnl
       FROM strategy_signals s
       JOIN follow_positions p ON p.id = s.position_id
       WHERE s.settled = 0 AND p.status = 'settled'`,
    )
    .all() as StraySettlementRow[];
  let fixed = 0;
  const contradictory: string[] = [];
  for (const r of strays) {
    const tag = `signal ${r.signal_id} / position ${r.position_id}`;
    if (r.exit_ts == null || r.exit_price == null || r.realized_pnl == null) {
      contradictory.push(tag);
      continue;
    }
    let ok: boolean;
    try {
      ok = backfillSignalSettlement(db, r.position_id, {
        settledTs: r.exit_ts,
        exitPrice: r.exit_price,
        realizedPnl: r.realized_pnl,
      });
    } catch (e) {
      console.warn(
        `[follow] strategy_signals 对账写入失败(下轮重试):${tag}:`,
        e,
      );
      continue;
    }
    // false = SELECT 之后被别处抢先回填(settled=0 守卫拦下)—— 不计数即幂等。
    // 同步单进程下造不出这个竞态,无法单测,纯防御分支。
    if (!ok) continue;
    fixed++;
    console.log(
      `[follow] strategy_signals 对账补齐:${tag} · settled_ts=${r.exit_ts} · exit_price=${r.exit_price} · realized_pnl=${r.realized_pnl}`,
    );
  }
  if (contradictory.length > 0) {
    console.warn(
      `[follow] strategy_signals 对账跳过 ${contradictory.length} 行(仓位已 settled 但 exit_ts/exit_price/realized_pnl 有 NULL,需人工核查):${contradictory.join("; ")}`,
    );
  }
  return fixed;
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
