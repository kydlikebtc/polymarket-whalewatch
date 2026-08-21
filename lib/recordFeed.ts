import type { DB } from "./db";
import { DIGEST_DAY_KEY, DIGEST_PREV_KEY } from "./signalDigest";
import { gradeRows, type SignalRecord } from "./signalRecord";
import { strategyCode } from "./strategyCodes";
import { sourceOf } from "./strategyFeed";

// 对外信号批次 3:/record 公开战绩页的数据层(零上游调用,全部持久化状态)。
//
// 这页回答的问题与 /follow 不同:/follow 是「全部纸面策略的完整履历」,
// /record 是「**我们公开发出过的**信号,事后如何」—— 分母只含存在
// status='sent' entry 投递的信号。两个口径都诚实,但绝不能混:公开页拿
// 全量纸面账替发布记录背书,就是社会证明造假的软形态。
// 档位一旦发布过就永远在账上(push_enabled 后来关掉也不抹历史)。

export interface RecordSettledRow {
  id: number;
  conditionId: string;
  title: string;
  outcome: string;
  entryPrice: number | null;
  exitPrice: number | null;
  won: boolean | null;
  realizedPnl: number | null;
  settledAt: number;
}

export interface RecordFeedStrategy {
  id: number;
  /** 跨部署稳定的档位码;null = 未登记(运营手工建的档)。 */
  code: string | null;
  name: string;
  source: string;
  /** 已发布(sent entry)的信号总数,含未结算。 */
  pushedCount: number;
  /** 已发布且已结算信号的 30d 价格调整战绩(gradeRows 唯一实现)。 */
  record: SignalRecord;
  settledRecent: RecordSettledRow[];
}

export interface RecordFeed {
  updatedAt: number;
  strategies: RecordFeedStrategy[];
  /** 存证链状态:最近一次 digest 的日期与链尾哈希(供第三方对账起点)。 */
  digest: { day: string | null; tail: string | null };
}

const RECORD_DAYS = 30;
const SETTLED_RECENT_LIMIT = 10;

/** 存在任一 sent entry 投递的信号(公开账的准入判据)。 */
const PUSHED_EXISTS = `EXISTS (SELECT 1 FROM signal_deliveries d
   WHERE d.signal_id = s.id AND d.event = 'entry' AND d.status = 'sent')`;

export function buildRecordFeed(
  db: DB,
  opts: { nowSec?: number } = {},
): RecordFeed {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const strategies = db
    .prepare(
      `SELECT st.id, st.name, st.params_json
       FROM follow_strategies st
       WHERE EXISTS (SELECT 1 FROM strategy_signals s
                     WHERE s.strategy_id = st.id AND ${PUSHED_EXISTS})
       ORDER BY st.id`,
    )
    .all() as { id: number; name: string; params_json: string | null }[];

  const out: RecordFeedStrategy[] = strategies.map((st) => {
    const pushedCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM strategy_signals s
           WHERE s.strategy_id = ? AND ${PUSHED_EXISTS}`,
        )
        .get(st.id) as { n: number }
    ).n;
    const graded = db
      .prepare(
        `SELECT s.entry_price AS price, s.won FROM strategy_signals s
         WHERE s.strategy_id = ? AND s.settled = 1 AND s.won IS NOT NULL
           AND s.emitted_at >= ? AND ${PUSHED_EXISTS}`,
      )
      .all(st.id, nowSec - RECORD_DAYS * 86_400) as {
      price: number | null;
      won: number;
    }[];
    const settledRecent = (
      db
        .prepare(
          `SELECT s.id, s.condition_id, s.title, s.outcome, s.entry_price,
                  s.exit_price, s.won, s.realized_pnl, s.settled_ts
           FROM strategy_signals s
           WHERE s.strategy_id = ? AND s.settled = 1 AND ${PUSHED_EXISTS}
           ORDER BY s.settled_ts DESC LIMIT ${SETTLED_RECENT_LIMIT}`,
        )
        .all(st.id) as {
        id: number;
        condition_id: string;
        title: string | null;
        outcome: string;
        entry_price: number | null;
        exit_price: number | null;
        won: number | null;
        realized_pnl: number | null;
        settled_ts: number | null;
      }[]
    ).map((r) => ({
      id: r.id,
      conditionId: r.condition_id,
      title: r.title ?? "",
      outcome: r.outcome,
      entryPrice: r.entry_price,
      exitPrice: r.exit_price,
      won: r.won === 1 ? true : r.won === 0 ? false : null,
      realizedPnl: r.realized_pnl,
      settledAt: r.settled_ts ?? 0,
    }));
    return {
      id: st.id,
      code: strategyCode(st.name),
      name: st.name,
      source: sourceOf(st.params_json),
      pushedCount,
      record: gradeRows(
        graded.map((g) => ({ won: g.won, price: g.price, side: "BUY" })),
      ),
      settledRecent,
    };
  });

  const cfg = (key: string): string | null =>
    (
      db.prepare("SELECT value FROM config WHERE key = ?").get(key) as
        { value: string | null } | undefined
    )?.value ?? null;

  return {
    updatedAt: nowSec,
    strategies: out,
    digest: { day: cfg(DIGEST_DAY_KEY), tail: cfg(DIGEST_PREV_KEY) },
  };
}
