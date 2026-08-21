// Bare specifier on purpose (next.config.mjs 约定):webpack dev fallback 解析
// 不了 "node:" scheme,裸内置名在 webpack 与 turbopack 都工作。
import { createHash, randomBytes } from "crypto";
import type { DB } from "./db";

// 对外信号批次 2:多租户只读密钥。
// 与 SIGNAL_FEED_TOKEN(env 单 token)的关系:env token 保留为 mm-mobile
// 兼容路径(等价 realtime),api_keys 承载可增删的订户 —— 单 key 吊销不牵连
// 他人,这是放弃 env 管全部订户的原因。
// 存储纪律:库里只有 sha256 hex,明文只在签发返回值里出现一次;泄库不泄 key。

export type ApiKeyTier = "realtime" | "delayed";

const hashKey = (k: string): string =>
  createHash("sha256").update(k).digest("hex");

export interface IssuedKey {
  id: number;
  /** 明文,只在这里出现一次 —— 调用方展示后即弃。 */
  key: string;
}

export function issueApiKey(
  db: DB,
  opts: {
    label: string;
    tier: ApiKeyTier;
    /**
     * 订阅范围:该 key 能拿到哪些信号类型(bus 类型 + "strategy")。
     * 省略/空数组 = 全部 —— 既有 key 与不关心分类的订阅方语义不变。
     */
    busTypes?: string[] | null;
  },
  nowSec: number = Math.floor(Date.now() / 1000),
): IssuedKey {
  // 24 字节随机 → base64url ≈ 32 字符;"wlk_" 前缀让日志/工单里一眼可辨
  // 这是什么 token(也便于将来按前缀扫泄漏)。
  const key = `wlk_${randomBytes(24).toString("base64url")}`;
  const res = db
    .prepare(
      "INSERT INTO api_keys (key_hash, label, tier, created_at, bus_types) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      hashKey(key),
      opts.label,
      opts.tier,
      nowSec,
      // 空数组与 undefined 都存 NULL:「没勾任何类型」在业务上只能理解为
      // 「不限」,存成空数组会变成「什么都收不到」这种没人想要的配置。
      opts.busTypes && opts.busTypes.length > 0
        ? JSON.stringify(opts.busTypes)
        : null,
    );
  return { id: Number(res.lastInsertRowid), key };
}

export interface ApiKeyInfo {
  id: number;
  label: string;
  tier: ApiKeyTier;
  /** null = 不限(全部类型);数组 = 只订阅这些。 */
  busTypes: string[] | null;
}

/**
 * 校验 token:sha256 查表(hash 等值查找,不做明文比较)+ 吊销过滤。
 * 命中顺手更新 last_used_at(审计「这个 key 还活着吗」)。未知 tier 值按
 * delayed 兜底 —— 宁降级不越权。
 */
export function verifyApiKey(
  db: DB,
  token: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): ApiKeyInfo | null {
  if (!token) return null;
  const row = db
    .prepare(
      "SELECT id, label, tier, bus_types FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL",
    )
    .get(hashKey(token)) as
    | { id: number; label: string; tier: string; bus_types: string | null }
    | undefined;
  if (!row) return null;
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(
    nowSec,
    row.id,
  );
  return {
    id: row.id,
    label: row.label,
    tier: row.tier === "realtime" ? "realtime" : "delayed",
    busTypes: parseBusTypes(row.bus_types),
  };
}

/**
 * 订阅范围解析。坏 JSON / 非数组 / 空数组一律回落 null(=不限)——
 * 宁可多给也不能让一个存坏了的字段静默切断订阅方的数据流:后者的表现是
 * 「接口通、返回 200、就是没数据」,最难排查。
 */
export function parseBusTypes(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    const list = v.filter((x): x is string => typeof x === "string");
    return list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

// --- 两个权限域 ------------------------------------------------------------
//
// 「这把 **key** 能访问什么」与「这个 **webhook 端点** 推什么事件」实现恰好相同
// (列表包含判断),于是长期共用一个 `busTypeAllowed`。但域早就分叉了:
//
//   · key 范围含 `market`(市场深度卡)—— 那是一种**能力**,不是事件类型;
//   · 端点推送域不含它 —— 深度卡是拉取的,**没有事件可推**。
//
// 当初把 market 塞进来时的别扭、以及 /manage 里可授予范围被迫拆成两份清单,
// 根源都在这一处合并。名字也一直在撒谎:`bus_types` 里从来就装着 `strategy`,
// 而策略信号住在 strategy_signals,根本不是 bus 类型。
//
// 拆成两个函数不是为了好看:合成一个时,「把 market 当可推送类型去检查」是一句
// 写得出来的话,拆开后它在调用点上就显得不对了。库表列名 `bus_types` 保持不动
// (改列要迁移,而列名只有维护者看得见;撒谎的是概念,不是存储)。

// 域的定义在 lib/keyScopes(零依赖,/manage 的客户端组件也从那里取)——
// 这里只再导出,免得调用方为了一个常量去认第二个模块。
export { KEY_SCOPES, PUSHABLE_TYPES } from "./keyScopes";

/** 两个域共用的判断:null / 空 = 不限,一律放行。 */
const listAllows = (list: string[] | null | undefined, v: string): boolean =>
  !list || list.length === 0 || list.includes(v);

/** 这把 key 的范围是否放行某项能力(域见 KEY_SCOPES)。 */
export function keyAllows(
  scopes: string[] | null | undefined,
  scope: string,
): boolean {
  return listAllows(scopes, scope);
}

/** 这个 webhook 端点是否推送某个事件类型(域见 PUSHABLE_TYPES)。 */
export function endpointPushes(
  types: string[] | null | undefined,
  type: string,
): boolean {
  return listAllows(types, type);
}

/** 吊销(软删,revoked_at 时间戳即审计)。已吊销/未知 id 返回 false。 */
export function revokeApiKey(
  db: DB,
  id: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  const res = db
    .prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    )
    .run(nowSec, id);
  return res.changes === 1;
}

export interface ApiKeyRow {
  id: number;
  label: string;
  tier: string;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

/** 管理列表:无明文无 hash(hash 也是秘密的影子,列表用不着它)。 */
export function listApiKeys(db: DB): ApiKeyRow[] {
  return (
    db
      .prepare(
        "SELECT id, label, tier, created_at, revoked_at, last_used_at, bus_types FROM api_keys ORDER BY id",
      )
      .all() as {
      id: number;
      label: string;
      tier: string;
      created_at: number;
      revoked_at: number | null;
      last_used_at: number | null;
      bus_types: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    label: r.label,
    tier: r.tier,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    lastUsedAt: r.last_used_at,
    busTypes: parseBusTypes(r.bus_types),
  }));
}
