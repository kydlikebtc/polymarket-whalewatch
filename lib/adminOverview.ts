import type { DB } from "./db";
import { ENTRY_MAX_AGE_SEC } from "./signalDelivery";
import { DIGEST_DAY_KEY, DIGEST_PREV_KEY } from "./signalDigest";
import type { SignalRecord } from "./signalRecord";
import { strategyCode } from "./strategyCodes";
import { sourceOf } from "./strategyFeed";
import { countStraySettlements, strategyRecord30d } from "./strategySignals";
import { getTelegramHealth, type TelegramHealth } from "./telegramHealth";

// /manage 运营页的数据层(admin 视角,与 /record 的公开口径刻意分开):
// 全部 13 档都在列 —— 「放开哪几档」这个决策恰恰要看未放开档的台账表现。
// 零上游调用,全部持久化状态。

export interface StrategyPushRow {
  id: number;
  /** 对外档位码 —— 订阅方按它认档,运营答疑时要看得见(null = 未登记)。 */
  code: string | null;
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

/**
 * ① 聪明钱动向的台账单行:一条 consensus/smart 告警 + 它的去向。
 *
 * 「去向」三列的可得性刻意不同,如实呈现而不是假装同质:
 *   - 𝕏:有逐行记录(x_posts.alert_id + status);
 *   - 总线→webhook:有逐行记录(bus_signals dedup=alert:<id> × bus_deliveries);
 *   - TG:**没有**逐行记录 —— alertEngine 是先发后记(transient 失败连
 *     alerts 行都不落,permanent 失败保留行照记),行的存在只证明「已入库」。
 *     UI 对 TG 只标配置态,不伪造逐行状态。
 */
export interface SmartLedgerRow {
  id: number;
  /** 'consensus' | 'smart'(= feed 里的 heavy 原料)。 */
  type: string;
  title: string | null;
  outcome: string | null;
  emittedAt: number;
  summary: string;
  /** x_posts 命中(kind whale/consensus):status,未发为 null。 */
  xStatus: string | null;
  /** 总线投影:是否已投影 + 逐通道投递状态。 */
  bus: { projected: boolean; channels: { channel: string; status: string }[] };
}

function smartSummary(type: string, payload: Record<string, unknown>): string {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  if (type === "consensus") {
    const n = num(payload.walletCount);
    const usd = num(payload.totalNetUsd);
    return [
      n != null ? `${n} 钱包` : null,
      usd != null ? `$${Math.round(usd).toLocaleString()}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const size = num(payload.size);
  const price = num(payload.price);
  const usd = size != null && price != null ? size * price : null;
  const side = typeof payload.side === "string" ? payload.side : null;
  return [
    usd != null ? `$${Math.round(usd).toLocaleString()}` : null,
    side,
    price != null ? `@${price}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** ① 台账最近 N 条(consensus/smart 告警)+ 去向。 */
export function buildSmartLedger(db: DB, limit = 20): SmartLedgerRow[] {
  const rows = db
    .prepare(
      `SELECT id, type, payload, created_at FROM alerts
       WHERE type IN ('consensus','smart')
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as {
    id: number;
    type: string;
    payload: string;
    created_at: number;
  }[];
  const xStmt = db.prepare(
    "SELECT status FROM x_posts WHERE alert_id = ? ORDER BY id DESC LIMIT 1",
  );
  const busStmt = db.prepare("SELECT id FROM bus_signals WHERE dedup_key = ?");
  const chStmt = db.prepare(
    "SELECT channel, status FROM bus_deliveries WHERE bus_signal_id = ? ORDER BY channel",
  );
  return rows.map((r) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      // 坏载荷:摘要留空,行仍完整。
    }
    const busRow = busStmt.get(`alert:${r.id}`) as { id: number } | undefined;
    return {
      id: r.id,
      type: r.type,
      title: typeof payload.title === "string" ? payload.title : null,
      outcome: typeof payload.outcome === "string" ? payload.outcome : null,
      emittedAt: r.created_at,
      summary: smartSummary(r.type, payload),
      xStatus:
        (xStmt.get(r.id) as { status: string } | undefined)?.status ?? null,
      bus: {
        projected: busRow != null,
        channels: busRow
          ? (chStmt.all(busRow.id) as { channel: string; status: string }[])
          : [],
      },
    };
  });
}

/**
 * ① 原始事件线的统一台账行:大额/共识来自 alerts(源表),发现来自
 * bus_signals(它的唯一落库形态)。三类合并按时间倒序 —— 运营者要的是
 * 「这条线最近发生了什么、去了哪」一张表,不是按存储表各看一张。
 */
export interface EventLedgerRow extends SmartLedgerRow {}

export function buildEventLedger(db: DB, limit = 20): EventLedgerRow[] {
  const base = buildSmartLedger(db, limit);
  const discovery = (
    db
      .prepare(
        `SELECT b.id, b.payload, b.emitted_at FROM bus_signals b
         WHERE b.source_type = 'discovery'
         ORDER BY b.emitted_at DESC, b.id DESC LIMIT ?`,
      )
      .all(limit) as { id: number; payload: string; emitted_at: number }[]
  ).map((r): EventLedgerRow => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      // 坏载荷:摘要留空。
    }
    const addr = typeof payload.address === "string" ? payload.address : null;
    const score =
      typeof payload.score === "number" && Number.isFinite(payload.score)
        ? payload.score
        : null;
    return {
      // 发现事件与 alerts 的 id 是两个命名空间,取负避免 React key 撞车
      // (仅展示用,不是稳定引用)。
      id: -r.id,
      type: "discovery",
      title: null,
      outcome: null,
      emittedAt: r.emitted_at,
      summary: [
        addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : null,
        score != null ? `score ${score}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      xStatus: null, // 发现事件不接 𝕏
      bus: {
        projected: true,
        channels: db
          .prepare(
            "SELECT channel, status FROM bus_deliveries WHERE bus_signal_id = ? ORDER BY channel",
          )
          .all(r.id) as { channel: string; status: string }[],
      },
    };
  });
  return [...base, ...discovery]
    .sort((a, b) => b.emittedAt - a.emittedAt)
    .slice(0, limit);
}

/**
 * 总线台账单行(运营视角):一条 bus 事件 + 它的逐通道投递状态。
 * 与 RecentSignalRow 的分工:那边是**策略**信号台账(strategy_signals ×
 * signal_deliveries),这边是**总线**台账(bus_signals × bus_deliveries)——
 * 两本账,两张表,同一套「发了没有」的问题。
 */
export interface BusLedgerRow {
  id: number;
  sourceType: string;
  title: string | null;
  conditionId: string | null;
  emittedAt: number;
  /** payload 一行摘要,按类型取最有信息量的两三个字段,运营者扫一眼用。 */
  summary: string;
  channels: { channel: string; status: string }[];
}

/** payload → 一行人话。坏载荷/缺字段一律降级成空串,不抛。 */
function busSummary(
  sourceType: string,
  payload: Record<string, unknown>,
): string {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v ? v : null;
  if (sourceType === "large") {
    const usd = num(payload.usd);
    const side = str(payload.side);
    const price = num(payload.price);
    return [
      usd != null ? `$${Math.round(usd).toLocaleString()}` : null,
      side,
      price != null ? `@${price}` : null,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (sourceType === "consensus") {
    const n = num(payload.walletCount);
    const usd = num(payload.totalNetUsd);
    return [
      n != null ? `${n} 钱包` : null,
      usd != null ? `$${Math.round(usd).toLocaleString()}` : null,
      str(payload.outcome),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (sourceType === "discovery") {
    const addr = str(payload.address);
    const score = num(payload.score);
    return [
      addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : null,
      score != null ? `score ${score}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return "";
}

/** 总线台账最近 N 条 + 逐通道投递状态(bus_deliveries)。 */
export function buildBusLedger(db: DB, limit = 20): BusLedgerRow[] {
  const rows = db
    .prepare(
      `SELECT id, source_type, title, condition_id, payload, emitted_at
       FROM bus_signals ORDER BY emitted_at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as {
    id: number;
    source_type: string;
    title: string | null;
    condition_id: string | null;
    payload: string;
    emitted_at: number;
  }[];
  const chStmt = db.prepare(
    "SELECT channel, status FROM bus_deliveries WHERE bus_signal_id = ? ORDER BY channel",
  );
  return rows.map((r) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      // 坏载荷:摘要留空,行仍完整。
    }
    return {
      id: r.id,
      sourceType: r.source_type,
      title: r.title,
      conditionId: r.condition_id,
      emittedAt: r.emitted_at,
      summary: busSummary(r.source_type, payload),
      channels: chStmt.all(r.id) as { channel: string; status: string }[],
    };
  });
}

/**
 * 结算对账读数(strategy_signals × follow_positions)。对账补齐次数只活在 worker
 * stdout(`[engine] follow cycle … sigReconciled`),这里给的是能直接查库得到的
 * 两项,页面据此高亮:
 *   - stray:仓位已 settled 而台账仍 settled=0 的行数。对账每轮兜底,正常恒为 0;
 *     持续 >0 = 回填路径在坏(SQLITE_BUSY/磁盘)或有对账拒碰的自相矛盾行,
 *     看 [follow] 日志的「对账补齐 / 对账写入失败」。
 *   - tsMismatch7d:近 7d 已结算台账行里 settled_ts 与仓位 exit_ts 偏差 >300s
 *     (或仓位 exit_ts 为 NULL)的行数。正常结算与对账两条路径都写仓位 exit_ts
 *     —— 下游 7d 陈旧闸 / 48h 窗口据此判新鲜,应恒为 0。
 */
export interface SettlementReconcile {
  stray: number;
  tsMismatch7d: number;
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
    /** 结算对账读数,见 SettlementReconcile。 */
    settlementReconcile: SettlementReconcile;
  };
}

const RECENT_LIMIT = 20;
// 结算对账 tsMismatch 的窗口与容差:只盯最近 7 天的回填行为;两条回填路径都写
// 仓位 exit_ts,300s 是给「同轮时钟差」留的余量,超过即口径漂移。
const RECONCILE_WINDOW_SEC = 7 * 86_400;
const SETTLED_TS_TOLERANCE_SEC = 300;

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
      code: strategyCode(st.name),
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
  // 结算对账:stray 与 reconcileSignalSettlements 同一谓词(lib/strategySignals);
  // tsMismatch7d 只查已结算行,exit_ts 为 NULL 的 JOIN 行同样算偏差(仓位没
  // 结算时刻却有已结算的台账,是同一种口径漂移)。
  const settlementReconcile: SettlementReconcile = {
    stray: countStraySettlements(db),
    tsMismatch7d: (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM strategy_signals s
           JOIN follow_positions p ON p.id = s.position_id
           WHERE s.settled = 1 AND s.settled_ts >= ?
             AND (p.exit_ts IS NULL OR ABS(s.settled_ts - p.exit_ts) > ?)`,
        )
        .get(nowSec - RECONCILE_WINDOW_SEC, SETTLED_TS_TOLERANCE_SEC) as {
        n: number;
      }
    ).n,
  };
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
      settlementReconcile,
    },
  };
}
