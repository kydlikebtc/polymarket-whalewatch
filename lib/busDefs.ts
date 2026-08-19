import type { DB } from "./db";

// 刻意零依赖 signalBus:signalBus.projectBusSignals 需要值导入本模块,
// 反向再值导入就是真 require 环。BusSourceType 用结构化字符串代替类型
// 导入;seed 迁移自己读 legacy 配置(bus_signal_settings),不借道
// getBusSettings。
type BusSourceType = "large" | "consensus" | "discovery" | string;

// 信号定义(2026-08-19)—— ① 原始事件线的一等实体。
//
// 此前每个事件类型只有一个开关 + 一个阈值,「大额 ≥$50k 给频道 A、
// 大额 ≥$500k 给端点 B」这种需求表达不了。本模块把「类型 + 阈值 + 启停」
// 升格为可命名、可多档、可被管线单独订阅的**信号定义**:
//
//   事件类型(large/consensus/discovery) —— 客观事实的分类,不可配置;
//   信号定义(def)                        —— 类型上的命名过滤器:阈值 + 启停;
//   管线订阅                             —— webhook 端点可订「整个类型」
//                                           (类型名)或「某个定义」(def:<id>)。
//
// 三条纪律:
//   1. **defs 是唯一真相**:类型「开着」= 该类型存在 ≥1 个启用的定义。
//      旧的 per-type 设置(bus_signal_settings)只在首次迁移时读一次,此后
//      不再参与任何判定 —— 两套真相互相追赶正是要消灭的东西。
//   2. 事件台账保持纯净:bus_signals 行不写 def 归属 —— 定义可改,事件
//      不可变,匹配在读/投递时算(payload 里有 usd/walletCount/score)。
//   3. 阈值语义统一为「下限」(≥):三类的既有阈值(minUsd/minWallets/
//      minScore)本来就都是 floor,新定义不引入其它比较方向。

export interface BusDef {
  id: number;
  sourceType: BusSourceType;
  label: string;
  /** 下限阈值(语义随类型:USD / 钱包数 / 评分)。 */
  threshold: number;
  enabled: boolean;
  createdAt: number;
}

/** 各类型的阈值字段名与默认值 —— 与 BUS_TYPES 注册表对齐。 */
export const DEF_THRESHOLD: Record<
  string,
  { key: string; fallback: number } | undefined
> = {
  large: { key: "minUsd", fallback: 100_000 },
  consensus: { key: "minWallets", fallback: 2 },
  discovery: { key: "minScore", fallback: 60 },
};

const SEED_MARK = "bus_defs_seed_v";

/**
 * 一次性迁移:把 legacy per-type 设置里 enabled 的类型各生成一条「默认」
 * 定义。未开启的类型不建(保持关)。生产此前三类全关 → 空表 → 零行为变化。
 */
export function seedBusDefs(db: DB, nowSec: number): void {
  const mark = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(SEED_MARK) as { value: string | null } | undefined;
  if (mark?.value === "1") return;
  // legacy 设置直读 config(不借道 signalBus.getBusSettings —— 见文件头
  // 的零依赖说明)。坏 JSON = 视为全关,与 getBusSettings 的降级一致。
  let legacy: Record<string, Record<string, unknown>> = {};
  try {
    const raw = db
      .prepare("SELECT value FROM config WHERE key = 'bus_signal_settings'")
      .get() as { value: string | null } | undefined;
    if (raw?.value) {
      const parsed: unknown = JSON.parse(raw.value);
      if (typeof parsed === "object" && parsed !== null) {
        legacy = parsed as Record<string, Record<string, unknown>>;
      }
    }
  } catch {
    legacy = {};
  }
  const ins = db.prepare(
    "INSERT INTO bus_defs (source_type, label, params_json, enabled, created_at) VALUES (?, ?, ?, 1, ?)",
  );
  for (const type of Object.keys(DEF_THRESHOLD)) {
    const st = legacy[type];
    const thr = DEF_THRESHOLD[type];
    if (st?.enabled !== true || !thr) continue;
    const v =
      typeof st[thr.key] === "number" ? (st[thr.key] as number) : thr.fallback;
    ins.run(type, "默认", JSON.stringify({ [thr.key]: v }), nowSec);
  }
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, '1')").run(
    SEED_MARK,
  );
}

function rowToDef(r: {
  id: number;
  source_type: string;
  label: string;
  params_json: string;
  enabled: number;
  created_at: number;
}): BusDef {
  const thr = DEF_THRESHOLD[r.source_type];
  let threshold = thr?.fallback ?? 0;
  try {
    const p = JSON.parse(r.params_json) as Record<string, unknown>;
    const v = thr ? p[thr.key] : undefined;
    if (typeof v === "number" && Number.isFinite(v)) threshold = v;
  } catch {
    // 坏参数:退默认阈值,定义仍可见可修复。
  }
  return {
    id: r.id,
    sourceType: r.source_type as BusSourceType,
    label: r.label,
    threshold,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
  };
}

export function listBusDefs(db: DB): BusDef[] {
  seedBusDefs(db, Math.floor(Date.now() / 1000));
  return (
    db
      .prepare(
        "SELECT id, source_type, label, params_json, enabled, created_at FROM bus_defs ORDER BY source_type, id",
      )
      .all() as Parameters<typeof rowToDef>[0][]
  ).map(rowToDef);
}

export function createBusDef(
  db: DB,
  input: { sourceType: BusSourceType; label: string; threshold: number },
  nowSec: number = Math.floor(Date.now() / 1000),
): number {
  const thr = DEF_THRESHOLD[input.sourceType];
  if (!thr) throw new Error(`类型 ${input.sourceType} 不支持信号定义`);
  const res = db
    .prepare(
      "INSERT INTO bus_defs (source_type, label, params_json, enabled, created_at) VALUES (?, ?, ?, 1, ?)",
    )
    .run(
      input.sourceType,
      input.label,
      JSON.stringify({ [thr.key]: input.threshold }),
      nowSec,
    );
  return Number(res.lastInsertRowid);
}

export function updateBusDef(
  db: DB,
  id: number,
  patch: { label?: string; threshold?: number; enabled?: boolean },
): boolean {
  const row = db
    .prepare("SELECT source_type, params_json FROM bus_defs WHERE id = ?")
    .get(id) as { source_type: string; params_json: string } | undefined;
  if (!row) return false;
  const thr = DEF_THRESHOLD[row.source_type];
  let params = row.params_json;
  if (patch.threshold != null && thr) {
    params = JSON.stringify({ [thr.key]: patch.threshold });
  }
  const res = db
    .prepare(
      `UPDATE bus_defs SET
         label = COALESCE(?, label),
         params_json = ?,
         enabled = COALESCE(?, enabled)
       WHERE id = ?`,
    )
    .run(
      patch.label ?? null,
      params,
      patch.enabled == null ? null : patch.enabled ? 1 : 0,
      id,
    );
  return res.changes === 1;
}

export function deleteBusDef(db: DB, id: number): boolean {
  return db.prepare("DELETE FROM bus_defs WHERE id = ?").run(id).changes === 1;
}

/** 该事件行的比较值(与阈值同量纲)。取不出 = null(视为不匹配任何定义)。 */
export function eventValue(
  sourceType: string,
  payload: Record<string, unknown>,
): number | null {
  const key =
    sourceType === "large"
      ? "usd"
      : sourceType === "consensus"
        ? "walletCount"
        : sourceType === "discovery"
          ? "score"
          : null;
  if (!key) return null;
  const v = payload[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 某事件匹配到的启用定义(阈值语义恒为「≥ 下限」)。 */
export function matchedDefs(
  defs: BusDef[],
  sourceType: string,
  payload: Record<string, unknown>,
): BusDef[] {
  const v = eventValue(sourceType, payload);
  if (v == null) return [];
  return defs.filter(
    (d) => d.enabled && d.sourceType === sourceType && v >= d.threshold,
  );
}

/**
 * 投影视角:该类型当前的准入下限。null = 类型关(无启用定义)。
 * 取启用定义的最小阈值 —— 台账要容纳「任何一个定义想要的事件」,
 * 更严的定义在投递/读取侧再过滤。
 */
export function projectionFloor(
  defs: BusDef[],
  sourceType: string,
): number | null {
  const enabled = defs.filter((d) => d.enabled && d.sourceType === sourceType);
  if (enabled.length === 0) return null;
  return Math.min(...enabled.map((d) => d.threshold));
}
