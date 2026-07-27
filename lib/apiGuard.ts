// Bare specifier on purpose: the worktree/webpack dev fallback can't resolve
// the "node:" scheme in server bundles (UnhandledSchemeError), while bare
// builtin names work in webpack AND turbopack.
import { createHash, timingSafeEqual } from "crypto";

// Public-deployment API guard. The dashboard began life as a localhost tool
// with zero auth; once it sits behind a public domain, every mutating route is
// a tamper vector (anyone can rewrite alert thresholds mid-record and the
// config_history audit trail would show an unexplained drift), and every
// upstream-fanout route is a free proxy for burning the shared data-api rate
// budget the engine itself depends on. This module centralizes the deployment
// posture:
//   - public deployment → writes require ADMIN_TOKEN, expensive routes are
//     per-IP rate limited;
//   - local dev → everything stays friction-free (no token, no limits).
// "Public deployment" is NODE_ENV=production unless PUBLIC_READONLY overrides
// it explicitly either way (the docker image sets NODE_ENV=production, so a
// compose deploy is guarded by default with zero configuration).

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export type EnvLike = Record<string, string | undefined>;

export function isPublicDeployment(env: EnvLike = process.env): boolean {
  const raw = (env.PUBLIC_READONLY ?? "").trim().toLowerCase();
  if (TRUTHY.has(raw)) return true;
  if (FALSY.has(raw)) return false;
  return env.NODE_ENV === "production";
}

// Constant-time comparison over sha256 digests: hashing first equalizes the
// lengths (timingSafeEqual throws on length mismatch, and the length itself
// must not leak).
export function tokenMatches(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(provided), h(expected));
}

export type WriteAccess =
  { ok: true } | { ok: false; status: 401 | 403; error: string };

/**
 * Gate for mutating routes (config writes). In a public deployment the caller
 * must present the ADMIN_TOKEN via the `x-admin-token` header; with no token
 * configured at all, remote writes are fully disabled (fail closed).
 */
export function checkWriteAccess(
  req: Request,
  env: EnvLike = process.env,
): WriteAccess {
  if (!isPublicDeployment(env)) return { ok: true };
  const expected = (env.ADMIN_TOKEN ?? "").trim();
  if (!expected) {
    return {
      ok: false,
      status: 403,
      error:
        "远程写入已禁用：公开部署未配置 ADMIN_TOKEN（在服务器 .env 设置后重启即可启用带令牌的远程调参）",
    };
  }
  const provided = req.headers.get("x-admin-token") ?? "";
  if (tokenMatches(provided, expected)) return { ok: true };
  return {
    ok: false,
    status: 401,
    error: "需要有效的管理令牌（x-admin-token）",
  };
}

// --- Two-tier fixed-window rate limiter (in-memory, single process) --------
// The unit being protected is the UPSTREAM (data-api / CLOB / RPC) request
// budget the engine shares with the dashboard — not request count for its own
// sake. Two tiers, because per-IP attribution alone is not trustworthy:
//
//   per-IP  — fair-use shaping. The client IP comes from cf-connecting-ip /
//             x-forwarded-for, which are CLIENT-SETTABLE whenever someone
//             reaches the origin port directly instead of through Cloudflare.
//             Rotating a fake header mints a fresh bucket every request, so
//             this tier is best-effort ATTRIBUTION, never a guarantee.
//   global  — the actual ceiling. One bucket per route, keyed by nothing the
//             caller controls, so no amount of header rotation raises it. Set
//             it well above real browsing but far below "can exhaust the
//             upstream budget".
//
// Both tiers charge `cost` (batch size), because these routes fan out per
// wallet/id: 30 requests × 200 wallets is 6000 upstream calls, and a limiter
// that counts requests instead of work would wave that through.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 4096;

export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "unattributed";
}

/**
 * true = allowed. Fixed window keyed by `key`; `cost` is how much of the
 * window's budget this call consumes (default 1).
 *
 * At MAX_BUCKETS the map sweeps expired entries and then REFUSES to mint new
 * keys (the request is allowed through this tier — the global tier is what
 * actually holds the line). Sweeping alone was not a bound: a header-rotating
 * flood produces keys that are all still fresh, so nothing was ever evictable
 * and the map grew with the attack.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  nowMs: number = Date.now(),
  cost = 1,
): boolean {
  const b = buckets.get(key);
  if (!b || nowMs >= b.resetAt) {
    if (buckets.size >= MAX_BUCKETS) {
      for (const [k, v] of buckets) if (nowMs >= v.resetAt) buckets.delete(k);
      if (buckets.size >= MAX_BUCKETS) return true;
    }
    buckets.set(key, { count: cost, resetAt: nowMs + windowMs });
    return cost <= limit;
  }
  b.count += cost;
  return b.count <= limit;
}

/** Test hook: clear the shared limiter state between cases. */
export function resetRateLimiter(): void {
  buckets.clear();
}

/** Test/diagnostic hook: current live bucket count. */
export function rateLimiterSize(): number {
  return buckets.size;
}

export interface ExpensiveLimits {
  /** Per-client-IP budget per minute (best-effort attribution). */
  perIp: number;
  /** Route-wide budget per minute — the spoof-proof ceiling. */
  global: number;
  /** Units this request consumes from both budgets (batch size). Default 1. */
  cost?: number;
}

/**
 * Gate for expensive (upstream-fanout) routes. Returns a 429 Response to send
 * back, or null to proceed. No-op outside public deployments so local dev and
 * tests never trip it. `bodyShape` keeps each route's error envelope intact so
 * existing clients degrade gracefully instead of crashing on a new shape.
 */
export function guardExpensive(
  req: Request,
  route: string,
  limits: ExpensiveLimits,
  bodyShape: Record<string, unknown>,
  env: EnvLike = process.env,
): Response | null {
  if (!isPublicDeployment(env)) return null;
  const cost = Math.max(1, Math.floor(limits.cost ?? 1));
  const nowMs = Date.now();
  // Charge BOTH tiers on every call (no short-circuit): the global ceiling
  // must see the work even when the per-IP tier already rejected it, or a
  // rotating attacker's spend would be invisible to the tier that stops them.
  const ipOk = rateLimit(
    `${route}:${clientIp(req)}`,
    limits.perIp,
    60_000,
    nowMs,
    cost,
  );
  const globalOk = rateLimit(
    `${route}:__all__`,
    limits.global,
    60_000,
    nowMs,
    cost,
  );
  if (ipOk && globalOk) return null;
  return Response.json(
    { ...bodyShape, error: "rate limited — retry in a minute" },
    { status: 429 },
  );
}
