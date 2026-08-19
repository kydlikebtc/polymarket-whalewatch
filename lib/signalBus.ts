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
import { z } from "zod";
import type { DB } from "./db";
import { categoriesFor } from "./eventCategory";
import { listBusDefs, projectionFloor } from "./busDefs";
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

/**
 * `bus[]` 单条的**唯一定义** —— 拉取 API 与 webhook 推送共用这一份
 * (lib/busWebhook.ts 直接嵌它)。此前两处各手抄一份字段表,「推拉同形」
 * 只靠注释和记性维持:加个字段要改三处,漏一处就静默分叉。
 *
 * 2026-08-19 起字段与 `active[]` 的 Signal 同名同义(见 lib/signalFeed.ts):
 *   - 归一命名:同一个「这笔多少钱」不再 large 叫 usd、consensus 叫
 *     totalNetUsd —— 一律 netUsd。消费方不必先 switch(sourceType);
 *   - 补齐身份:slug/eventSlug/category/subcategory/outcomeIndex/asset,
 *     其中分类此前完全没有,按赛道过滤事件根本做不到;
 *   - `payload` **原样保留**:additive,读 payload.usd 的老消费方零改动。
 *
 * discovery 没有市场,市场类字段一律 null —— 结构统一,消费方一套解析走到底。
 */
export const BusSignalSchema = z.object({
  id: z.number(),
  sourceType: z.string(),
  dedupKey: z.string(),
  conditionId: z.string().nullable(),
  title: z.string().nullable(),
  /** 单市场 slug —— 拼「这一个市场」的页面用(eventSlug 只能落到事件页)。 */
  slug: z.string().nullable(),
  eventSlug: z.string().nullable(),
  category: z.string().nullable(),
  subcategory: z.string().nullable(),
  outcome: z.string().nullable(),
  outcomeIndex: z.number().nullable(),
  asset: z.string().nullable(),
  /** 名义额(large)/ 总净买(consensus);discovery 无。 */
  netUsd: z.number().nullable(),
  /** 成交价(large)。 */
  avgPrice: z.number().nullable(),
  /** 参与钱包数;large 恒 1(一笔成交就是一个钱包)。 */
  walletCount: z.number().nullable(),
  /** 原始载荷,形状随 sourceType —— 保留以兼容既有消费方。 */
  payload: z.record(z.string(), z.unknown()),
  emittedAt: z.number(),
});

export type BusSignalRow = z.infer<typeof BusSignalSchema>;

// 载荷是引擎多条路径写出来的,字段随时间增减 —— 取值一律先验类型,拿不到
// 就是 null(不是 undefined:对外契约里「没有」只有一种写法)。
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

export function getBusSignals(
  db: DB,
  opts: { nowSec: number; windowSec?: number; limit?: number },
): BusSignalRow[] {
  const windowSec = opts.windowSec ?? 24 * 3600;
  const rows = (
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
    return { row: r, payload };
  });

  // 分类要按 eventSlug 批量补 —— 一次 IN 查询,不是每行点查一次。
  // 与 active[] 走同一个 categoriesFor:两份实现意味着同一个事件在两处
  // 可能给出不同分类,那种不一致最难被发现。
  const cats = categoriesFor(
    db,
    rows.map(({ payload }) => str(payload.eventSlug)),
  );

  return rows.map(({ row: r, payload }) => {
    const eventSlug = str(payload.eventSlug);
    const cat = (eventSlug ? cats[eventSlug] : null) ?? {
      category: null,
      subcategory: null,
    };
    return {
      id: r.id,
      sourceType: r.source_type,
      dedupKey: r.dedup_key,
      conditionId: r.condition_id,
      title: r.title,
      slug: str(payload.slug),
      eventSlug,
      category: cat.category,
      subcategory: cat.subcategory,
      outcome: str(payload.outcome),
      outcomeIndex: num(payload.outcomeIndex),
      asset: str(payload.asset),
      // 归一命名:large 写 usd、consensus 写 totalNetUsd,同一个语义两个名字
      // 逼着消费方先 switch(sourceType) 才知道读哪个键。
      netUsd: num(payload.usd) ?? num(payload.totalNetUsd),
      avgPrice: num(payload.price),
      // 一笔成交就是一个钱包 —— 给 1 而不是 null,消费方不必为 large 写特例。
      walletCount:
        num(payload.walletCount) ?? (r.source_type === "large" ? 1 : null),
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
  // 2026-08-19:准入改由**信号定义**(lib/busDefs,零反向依赖故可顶部
  // 导入)决定 —— 类型「开」= 存在 ≥1 个启用定义;投影下限取各启用定义的
  // 最小阈值(台账要容纳任何一个定义想要的事件,更严的定义在投递/读取侧
  // 再过滤)。
  const defs = listBusDefs(db);
  const largeFloor = projectionFloor(defs, "large");
  const consensusFloor = projectionFloor(defs, "consensus");
  const discoveryFloor = projectionFloor(defs, "discovery");
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
  if (largeFloor != null || consensusFloor != null) {
    const types: string[] = [];
    if (largeFloor != null) types.push("large", "smart");
    if (consensusFloor != null) types.push("consensus");
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
        if (walletCount < (consensusFloor ?? Infinity)) continue;
        emit(
          "consensus",
          `alert:${row.id}`,
          cid,
          title,
          {
            outcome: p.outcome ?? null,
            // 投影时就把身份字段带上 —— 读取侧的归一只能提升已有的东西,
            // 载荷里没有就永远补不出来。老事件保持 null(bus[] 窗口 24h,
            // 一天之后全量数据都齐了)。
            outcomeIndex: p.outcomeIndex ?? null,
            asset: p.asset ?? null,
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
        if (usd < (largeFloor ?? Infinity)) continue;
        emit(
          "large",
          `alert:${row.id}`,
          cid,
          title,
          {
            usd,
            side: p.side ?? null,
            outcome: p.outcome ?? null,
            outcomeIndex: p.outcomeIndex ?? null,
            asset: p.asset ?? null,
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
  if (discoveryFloor != null) {
    const rows = db
      .prepare(
        `SELECT address, score, source, updated_at FROM smart_wallets
          WHERE is_whitelist = 1 AND updated_at >= ? AND score >= ?`,
      )
      .all(since, discoveryFloor) as {
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
