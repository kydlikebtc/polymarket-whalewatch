import type { DB } from "./db";
import { ENTRY_MAX_AGE_SEC } from "./signalDelivery";
import { DIGEST_DAY_KEY, DIGEST_PREV_KEY } from "./signalDigest";
import type { SignalRecord } from "./signalRecord";
import { sourceOf } from "./strategyFeed";
import { strategyRecord30d } from "./strategySignals";
import { getTelegramHealth, type TelegramHealth } from "./telegramHealth";

// /manage 运营页的数据层(admin 视角,与 /record 的公开口径刻意分开):
// 全部 13 档都在列 —— 「放开哪几档」这个决策恰恰要看未放开档的台账表现。
// 零上游调用,全部持久化状态。

export interface StrategyPushRow {
  id: number;
  name: string;
  source: string;
  /** 策略本身是否参与开仓(follow_strategies.enabled)。 */
  enabled: boolean;
  /** 是否进对外投递总线(push_enabled)—— 本页要管理的开关。 */
  pushEnabled: boolean;
  /** 30d 价格调整战绩(全量纸面口径,gradeRows 唯一实现)。 */
  record: SignalRecord;
  signals: {
    total: number;
    last24h: number;
    lastEmittedAt: number | null;
  };
  /** 已发送的 entry 投递计数(按通道)。 */
  deliveries: { sentPaid: number; sentPublic: number };
}

export interface RecentSignalRow {
  id: number;
  strategyName: string;
  conditionId: string;
  title: string;
  outcome: string;
  entryPrice: number | null;
  emittedAt: number;
  settled: boolean;
  won: boolean | null;
  channels: { channel: string; status: string }[];
}

/** 一个已配置投递通道的积压视图(运营问题:「该发的发出去没有」)。 */
export interface ChannelBacklog {
  key: string;
  minEmitAgeSec: number;
  /** 已到点、未过新鲜度上限、却还没有投递记录的 entry 数 —— 应为 0 或很快归零。 */
  pendingEntries: number;
}

export interface AdminSignalOverview {
  updatedAt: number;
  strategies: StrategyPushRow[];
  recent: RecentSignalRow[];
  ops: {
    tg: TelegramHealth | null;
    digest: { day: string | null; tail: string | null };
    backupDay: string | null;
    /** config engine_started_at —— 顶部摘要条算运行时长用。 */
    engineStartedAt: number | null;
    /** 全部档位近 24h 的台账信号总数。 */
    signalsLast24h: number;
    /** 未吊销 api key 数。 */
    activeKeys: number;
    /** 由 route 按部署配置传入的通道清单 + 各自积压(未配置通道不出现)。 */
    channels: ChannelBacklog[];
  };
}

const RECENT_LIMIT = 20;

/** 推送开关(本页唯一的写操作)。未知 id 返回 false。 */
export function setStrategyPush(
  db: DB,
  strategyId: number,
  enabled: boolean,
): boolean {
  const res = db
    .prepare("UPDATE follow_strategies SET push_enabled = ? WHERE id = ?")
    .run(enabled ? 1 : 0, strategyId);
  return res.changes === 1;
}

export function buildAdminSignalOverview(
  db: DB,
  opts: {
    nowSec?: number;
    /** 部署实际配置的投递通道(route 从 env + webhook 表拼出),用于积压计算。 */
    channels?: { key: string; minEmitAgeSec: number }[];
  } = {},
): AdminSignalOverview {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const strategies = (
    db
      .prepare(
        "SELECT id, name, enabled, push_enabled, params_json FROM follow_strategies ORDER BY id",
      )
      .all() as {
      id: number;
      name: string;
      enabled: number;
      push_enabled: number;
      params_json: string | null;
    }[]
  ).map((st): StrategyPushRow => {
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN emitted_at >= ? THEN 1 ELSE 0 END) AS last24h,
                MAX(emitted_at) AS lastEmittedAt
         FROM strategy_signals WHERE strategy_id = ?`,
      )
      .get(nowSec - 86_400, st.id) as {
      total: number;
      last24h: number | null;
      lastEmittedAt: number | null;
    };
    const sentBy = (channel: string): number =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM signal_deliveries d
             JOIN strategy_signals s ON s.id = d.signal_id
             WHERE s.strategy_id = ? AND d.event = 'entry'
               AND d.channel = ? AND d.status = 'sent'`,
          )
          .get(st.id, channel) as { n: number }
      ).n;
    return {
      id: st.id,
      name: st.name,
      source: sourceOf(st.params_json),
      enabled: st.enabled === 1,
      pushEnabled: st.push_enabled === 1,
      record: strategyRecord30d(db, st.id, nowSec),
      signals: {
        total: counts.total,
        last24h: counts.last24h ?? 0,
        lastEmittedAt: counts.lastEmittedAt,
      },
      deliveries: {
        sentPaid: sentBy("tg_paid"),
        sentPublic: sentBy("tg_public"),
      },
    };
  });

  const recentRows = db
    .prepare(
      `SELECT s.id, st.name AS strategyName, s.condition_id, s.title, s.outcome,
              s.entry_price, s.emitted_at, s.settled, s.won
       FROM strategy_signals s
       JOIN follow_strategies st ON st.id = s.strategy_id
       ORDER BY s.emitted_at DESC, s.id DESC LIMIT ${RECENT_LIMIT}`,
    )
    .all() as {
    id: number;
    strategyName: string;
    condition_id: string;
    title: string | null;
    outcome: string;
    entry_price: number | null;
    emitted_at: number;
    settled: number;
    won: number | null;
  }[];
  const chStmt = db.prepare(
    "SELECT channel, status FROM signal_deliveries WHERE signal_id = ? AND event = 'entry' ORDER BY channel",
  );
  const recent: RecentSignalRow[] = recentRows.map((r) => ({
    id: r.id,
    strategyName: r.strategyName,
    conditionId: r.condition_id,
    title: r.title ?? "",
    outcome: r.outcome,
    entryPrice: r.entry_price,
    emittedAt: r.emitted_at,
    settled: r.settled === 1,
    won: r.won === 1 ? true : r.won === 0 ? false : null,
    channels: chStmt.all(r.id) as { channel: string; status: string }[],
  }));

  const cfg = (key: string): string | null =>
    (
      db.prepare("SELECT value FROM config WHERE key = ?").get(key) as
        { value: string | null } | undefined
    )?.value ?? null;

  // 通道积压:与 runDeliveryCycle 的 due/stale 判据同口径(到点 = emitted_at
  // ≤ now − minEmitAge;过期 = 再往前 ENTRY_MAX_AGE)。积压 >0 且持续,
  // 说明投递循环停了或被健康冻结 —— 这是「该发没发」的直接读数。
  const pendingStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM strategy_signals s
     JOIN follow_strategies st ON st.id = s.strategy_id
     WHERE st.push_enabled = 1
       AND s.emitted_at <= ? AND s.emitted_at > ?
       AND NOT EXISTS (SELECT 1 FROM signal_deliveries d
                       WHERE d.signal_id = s.id AND d.event = 'entry' AND d.channel = ?)`,
  );
  const channels: ChannelBacklog[] = (opts.channels ?? []).map((c) => {
    const dueBefore = nowSec - c.minEmitAgeSec;
    return {
      key: c.key,
      minEmitAgeSec: c.minEmitAgeSec,
      pendingEntries: (
        pendingStmt.get(dueBefore, dueBefore - ENTRY_MAX_AGE_SEC, c.key) as {
          n: number;
        }
      ).n,
    };
  });

  const signalsLast24h = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM strategy_signals WHERE emitted_at >= ?",
      )
      .get(nowSec - 86_400) as { n: number }
  ).n;
  const activeKeys = (
    db
      .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL")
      .get() as { n: number }
  ).n;
  const engineStartedAtRaw = cfg("engine_started_at");
  const engineStartedAt =
    engineStartedAtRaw != null && Number.isFinite(Number(engineStartedAtRaw))
      ? Number(engineStartedAtRaw)
      : null;

  return {
    updatedAt: nowSec,
    strategies,
    recent,
    ops: {
      tg: getTelegramHealth(db),
      digest: { day: cfg(DIGEST_DAY_KEY), tail: cfg(DIGEST_PREV_KEY) },
      backupDay: cfg("db_backup_last_day"),
      engineStartedAt,
      signalsLast24h,
      activeKeys,
      channels,
    },
  };
}
