import { isPublicDeployment, tokenMatches, type EnvLike } from "./apiGuard";
import { verifyApiKey, type ApiKeyTier } from "./apiKeys";
import type { DB } from "./db";

// 对外信号批次 2:/api/signals 鉴权(从 route 抽出以便测试)。
// 两条并联的合法路径:
//   1. env SIGNAL_FEED_TOKEN(v1 兼容,mm-mobile 的既有配置)→ 恒 realtime;
//   2. api_keys 表(多租户)→ tier 按 key 分层(realtime / delayed)。
// fail-closed 语义保持 v1:公开部署下两边都没配置 = feed 关闭(403);
// 配置了但 token 不对 = 401。本地开发照旧全开(realtime)。

export type FeedAccess =
  | {
      ok: true;
      tier: ApiKeyTier;
      keyId?: number;
      /** 订阅范围;null/缺省 = 不限(env token 与本地开发都是不限)。 */
      busTypes?: string[] | null;
    }
  | { ok: false; status: 401 | 403; error: string };

export function checkFeedAccess(
  req: Request,
  db: DB,
  env: EnvLike = process.env,
): FeedAccess {
  if (!isPublicDeployment(env)) return { ok: true, tier: "realtime" };
  const provided =
    req.headers.get("x-feed-token") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const envToken = (env.SIGNAL_FEED_TOKEN ?? "").trim();
  if (envToken && provided && tokenMatches(provided, envToken)) {
    return { ok: true, tier: "realtime" };
  }
  const viaKey = provided ? verifyApiKey(db, provided) : null;
  if (viaKey)
    return {
      ok: true,
      tier: viaKey.tier,
      keyId: viaKey.id,
      busTypes: viaKey.busTypes,
    };
  const activeKeys = (
    db
      .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL")
      .get() as { n: number }
  ).n;
  if (!envToken && activeKeys === 0) {
    return {
      ok: false,
      status: 403,
      error:
        "信号 feed 未开放：公开部署未配置 SIGNAL_FEED_TOKEN 也未签发任何 api key（scripts/issue-key.ts 或 /api/admin/keys 签发后即可对接）",
    };
  }
  return {
    ok: false,
    status: 401,
    error: "需要有效的 feed 令牌（x-feed-token 或 Bearer）",
  };
}
