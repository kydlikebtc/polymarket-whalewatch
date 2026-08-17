// 统一信号总线 —— 把全站各类信号收进一张台账,供 webhook / /api/signals 消费。
//
// 设计要点(docs/plans/2026-08-17-signal-bus-design.md):
//  · **投影而非重算**:已持久化的类型(大单/共识/发现)从源表投影进来。
//    源表已是唯一真相,重算既浪费又会产生口径分叉。
//  · **只读本地表**:投影层严禁上游请求(有测试钉死)—— 它跑在引擎循环里,
//    一次误加的 fetch 就会啃掉监控主链路的 data-api 预算。
//  · **默认全关**:新能力不该在运营者不知情时就开始往订阅方推数据。
//  · **关掉的类型不写入**(而非写了再过滤):省表,也省投递配额。
//  · 与 strategy_signals 并存而非合并:后者 strategy_id NOT NULL,塞入
//    "不属于任何档位"的信号会让既有战绩查询全都得加过滤,是把两件事搅一起。
import type { DB } from "./db";
import { notionalUsd } from "./trades";

export type BusSourceType =
  | "large"
  | "consensus"
  | "discovery"
  | "disagreement"
  | "accumulation"
  | "pregame";

export interface BusTypeMeta {
  type: BusSourceType;
  label: string;
  hint: string;
  /** false = 该类型的信号目前还没落库,开关在 UI 上禁用(批次 B 接入)。 */
  available: boolean;
  /** 该类型的阈值字段名与展示名,UI 据此渲染输入框。 */
  threshold?: { key: string; label: string; unit: string };
}

export const BUS_TYPES: BusTypeMeta[] = [
  {
    type: "large",
    label: "🐳 大额成交",
    hint: "单笔成交额达标即入总线。来源与 Telegram 告警同一批 alerts,可独立设更高阈值",
    available: true,
    threshold: { key: "minUsd", label: "最低金额", unit: "USD" },
  },
  {
    type: "consensus",
    label: "🔥 聪明钱共识",
    hint: "多个白名单钱包同向买入同一结果。可按最少钱包数收紧",
    available: true,
    threshold: { key: "minWallets", label: "最少钱包数", unit: "个" },
  },
  {
    type: "discovery",
    label: "🔭 聪明钱发现",
    hint: "新成员通过准入闸进入白名单池时发出。可按评分收紧",
    available: true,
    threshold: { key: "minScore", label: "最低评分", unit: "分" },
  },
  {
    type: "disagreement",
    label: "⚖️ 聪明钱分歧",
    hint: "对立结果上都有聪明钱。当前为页面级实时计算,尚未落库(待接入)",
    available: false,
  },
  {
    type: "accumulation",
    label: "🧩 拆单累计建仓",
    hint: "多笔小单堆成大仓。当前为页面级实时聚合,尚未落库(待接入)",
    available: false,
  },
  {
    type: "pregame",
    label: "⏰ 赛前聚合",
    hint: "结算前数小时的热门市场汇总。当前只用于 𝕏 播报,尚未落库(待接入)",
    available: false,
  },
];

export interface BusTypeSetting {
  enabled: boolean;
  [threshold: string]: boolean | number;
}

export type BusSettings = Record<BusSourceType, BusTypeSetting>;

export const DEFAULT_BUS_SETTINGS: BusSettings = {
  large: { enabled: false, minUsd: 100_000 },
  consensus: { enabled: false, minWallets: 2 },
  discovery: { enabled: false, minScore: 60 },
  disagreement: { enabled: false },
  accumulation: { enabled: false },
  pregame: { enabled: false },
};

const CONFIG_KEY = "bus_signal_settings";

// 投影窗口:只看这么新的事件。总线是"从此刻起往前推送",不是历史回灌 ——
// 首次开启某类型时不该把几个月的旧事件一次性冲进订阅方的 webhook。
export const PROJECT_WINDOW_SEC = 3600;

export function getBusSettings(db: DB): BusSettings {
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(CONFIG_KEY) as { value: string | null } | undefined;
  if (!row?.value) return structuredClone(DEFAULT_BUS_SETTINGS);
  try {
    const parsed = JSON.parse(row.value) as Partial<BusSettings>;
    if (typeof parsed !== "object" || parsed === null) {
      return structuredClone(DEFAULT_BUS_SETTINGS);
    }
    const out = structuredClone(DEFAULT_BUS_SETTINGS);
    for (const t of Object.keys(DEFAULT_BUS_SETTINGS) as BusSourceType[]) {
      const v = parsed[t];
      if (typeof v !== "object" || v === null) continue;
      // 逐字段校验:类型对得上才采信,其余保持默认(坏配置不该变成意外推送)。
      for (const [k, dv] of Object.entries(out[t])) {
        const nv = (v as Record<string, unknown>)[k];
        if (typeof nv === typeof dv) out[t][k] = nv as boolean | number;
      }
    }
    return out;
  } catch {
    console.warn(
      `[signalBus] corrupt JSON for '${CONFIG_KEY}', using defaults`,
    );
    return structuredClone(DEFAULT_BUS_SETTINGS);
  }
}

export function setBusSettings(db: DB, s: BusSettings): void {
  const next = JSON.stringify(s);
  const prev = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(CONFIG_KEY) as { value: string | null } | undefined;
  if (prev?.value !== next) {
    db.prepare(
      "INSERT INTO config_history (key, value, changed_at) VALUES (?, ?, ?)",
    ).run(CONFIG_KEY, next, Math.floor(Date.now() / 1000));
  }
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    CONFIG_KEY,
    next,
  );
}

export interface BusSignalRow {
  id: number;
  sourceType: string;
  dedupKey: string;
  conditionId: string | null;
  title: string | null;
  payload: Record<string, unknown>;
  emittedAt: number;
}

export function getBusSignals(
  db: DB,
  opts: { nowSec: number; windowSec?: number; limit?: number },
): BusSignalRow[] {
  const windowSec = opts.windowSec ?? 24 * 3600;
  return (
    db
      .prepare(
        `SELECT id, source_type, dedup_key, condition_id, title, payload, emitted_at
           FROM bus_signals WHERE emitted_at >= ?
          ORDER BY emitted_at DESC LIMIT ?`,
      )
      .all(opts.nowSec - windowSec, opts.limit ?? 200) as {
      id: number;
      source_type: string;
      dedup_key: string;
      condition_id: string | null;
      title: string | null;
      payload: string;
      emitted_at: number;
    }[]
  ).map((r) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      // 坏载荷不该让整个 feed 崩,留空对象并保留其余字段。
    }
    return {
      id: r.id,
      sourceType: r.source_type,
      dedupKey: r.dedup_key,
      conditionId: r.condition_id,
      title: r.title,
      payload,
      emittedAt: r.emitted_at,
    };
  });
}

/**
 * 把源表里的新事件投影进总线。返回写入行数(幂等:唯一索引挡住重复)。
 * 纯本地读写,无网络。引擎循环每轮调用一次。
 */
export function projectBusSignals(
  db: DB,
  nowSec: number,
): { written: number; byType: Record<string, number> } {
  const s = getBusSettings(db);
  const since = nowSec - PROJECT_WINDOW_SEC;
  const byType: Record<string, number> = {};
  let written = 0;

  const ins = db.prepare(
    `INSERT OR IGNORE INTO bus_signals (source_type, dedup_key, condition_id, title, payload, emitted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const emit = (
    type: BusSourceType,
    dedupKey: string,
    conditionId: string | null,
    title: string | null,
    payload: unknown,
    emittedAt: number,
  ) => {
    const r = ins.run(
      type,
      dedupKey,
      conditionId,
      title,
      JSON.stringify(payload),
      emittedAt,
    );
    if (r.changes === 1) {
      written++;
      byType[type] = (byType[type] ?? 0) + 1;
    }
  };

  // ---- 大额成交 / 聪明钱共识:都来自 alerts 表 ----
  if (s.large.enabled || s.consensus.enabled) {
    const types: string[] = [];
    if (s.large.enabled) types.push("large", "smart");
    if (s.consensus.enabled) types.push("consensus");
    const rows = db
      .prepare(
        `SELECT id, type, dedup_key, payload, created_at FROM alerts
          WHERE created_at >= ? AND type IN (${types.map(() => "?").join(",")})`,
      )
      .all(since, ...types) as {
      id: number;
      type: string;
      dedup_key: string;
      payload: string;
      created_at: number;
    }[];
    for (const row of rows) {
      let p: Record<string, unknown>;
      try {
        p = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const cid = typeof p.conditionId === "string" ? p.conditionId : null;
      const title = typeof p.title === "string" ? p.title : null;
      if (row.type === "consensus") {
        const walletCount =
          typeof p.walletCount === "number" ? p.walletCount : 0;
        if (walletCount < Number(s.consensus.minWallets ?? 0)) continue;
        emit(
          "consensus",
          `alert:${row.id}`,
          cid,
          title,
          {
            outcome: p.outcome ?? null,
            walletCount,
            totalNetUsd: p.totalNetUsd ?? null,
            slug: p.slug ?? null,
            eventSlug: p.eventSlug ?? null,
          },
          row.created_at,
        );
      } else {
        const size = p.size;
        const price = p.price;
        if (typeof size !== "number" || typeof price !== "number") continue;
        const usd = notionalUsd({ size, price });
        if (usd < Number(s.large.minUsd ?? 0)) continue;
        emit(
          "large",
          `alert:${row.id}`,
          cid,
          title,
          {
            usd,
            side: p.side ?? null,
            outcome: p.outcome ?? null,
            price,
            wallet: p.proxyWallet ?? null,
            slug: p.slug ?? null,
            eventSlug: p.eventSlug ?? null,
          },
          row.created_at,
        );
      }
    }
  }

  // ---- 聪明钱发现:新进白名单池的成员 ----
  if (s.discovery.enabled) {
    const rows = db
      .prepare(
        `SELECT address, score, source, updated_at FROM smart_wallets
          WHERE is_whitelist = 1 AND updated_at >= ? AND score >= ?`,
      )
      .all(since, Number(s.discovery.minScore ?? 0)) as {
      address: string;
      score: number | null;
      source: string | null;
      updated_at: number;
    }[];
    for (const r of rows) {
      emit(
        "discovery",
        `wallet:${r.address}`,
        null,
        null,
        { address: r.address, score: r.score, source: r.source },
        r.updated_at,
      );
    }
  }

  if (written > 0) {
    console.log(
      `[signalBus] projected ${written} signal(s): ${Object.entries(byType)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`,
    );
  }
  return { written, byType };
}
