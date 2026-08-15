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
  opts: { label: string; tier: ApiKeyTier },
  nowSec: number = Math.floor(Date.now() / 1000),
): IssuedKey {
  // 24 字节随机 → base64url ≈ 32 字符;"wlk_" 前缀让日志/工单里一眼可辨
  // 这是什么 token(也便于将来按前缀扫泄漏)。
  const key = `wlk_${randomBytes(24).toString("base64url")}`;
  const res = db
    .prepare(
      "INSERT INTO api_keys (key_hash, label, tier, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(hashKey(key), opts.label, opts.tier, nowSec);
  return { id: Number(res.lastInsertRowid), key };
}

export interface ApiKeyInfo {
  id: number;
  label: string;
  tier: ApiKeyTier;
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
      "SELECT id, label, tier FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL",
    )
    .get(hashKey(token)) as
    { id: number; label: string; tier: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(
    nowSec,
    row.id,
  );
  return {
    id: row.id,
    label: row.label,
    tier: row.tier === "realtime" ? "realtime" : "delayed",
  };
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
        "SELECT id, label, tier, created_at, revoked_at, last_used_at FROM api_keys ORDER BY id",
      )
      .all() as {
      id: number;
      label: string;
      tier: string;
      created_at: number;
      revoked_at: number | null;
      last_used_at: number | null;
    }[]
  ).map((r) => ({
    id: r.id,
    label: r.label,
    tier: r.tier,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    lastUsedAt: r.last_used_at,
  }));
}
