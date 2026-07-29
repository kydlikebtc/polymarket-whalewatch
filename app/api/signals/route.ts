import { openDb } from "../../../lib/db";
import { buildSignalFeed } from "../../../lib/signalFeed";
import { getEngineStart, getHeartbeats } from "../../../lib/heartbeat";
import { evaluateHealth } from "../../../lib/health";
import { createPromiseCache } from "../../../lib/promiseCache";
import { isPublicDeployment, tokenMatches } from "../../../lib/apiGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Machine-facing feed for the mobile 信号 tab. The intended topology is
// deliberately NOT app→here:
//
//   whalewatch  ──1 poll/min──▶  app backend (cache + JWT)  ──▶  app clients
//
// This process is a single-machine Next + SQLite research service with an
// in-process rate-limit map; it cannot be the origin for app traffic, and it
// does not need to be. One consumer polling once a minute is a load it already
// carries — which is why integrating the tab requires no architecture change
// here. If someone points app clients straight at this route, that decision,
// not this code, is the outage.
//
// Every field is served from persisted state — zero upstream calls — so a
// burst can never reach into the data-api budget the engine loop depends on.
const CACHE_TTL_MS = 30_000;
const feedCache = createPromiseCache<unknown>(CACHE_TTL_MS);

const ALLOWED_WINDOW_HOURS = new Set([6, 12, 24, 48]);

function clampWindow(raw: string | null): number {
  const n = Number(raw);
  return ALLOWED_WINDOW_HOURS.has(n) ? n : 24;
}

/**
 * Consumer auth. Separate from ADMIN_TOKEN on purpose: this one is read-only
 * and lives in a partner's config, so it must be revocable without touching
 * the operator's write credential. Unset in a public deployment = closed, on
 * the same fail-closed rule as config writes.
 */
function checkFeedAccess(
  req: Request,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; status: 401 | 403; error: string } {
  if (!isPublicDeployment(env)) return { ok: true };
  const expected = (env.SIGNAL_FEED_TOKEN ?? "").trim();
  if (!expected) {
    return {
      ok: false,
      status: 403,
      error:
        "信号 feed 未开放：公开部署未配置 SIGNAL_FEED_TOKEN（在服务器 .env 设置后重启即可对接）",
    };
  }
  const provided =
    req.headers.get("x-feed-token") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (tokenMatches(provided, expected)) return { ok: true };
  return {
    ok: false,
    status: 401,
    error: "需要有效的 feed 令牌（x-feed-token）",
  };
}

export async function GET(req: Request) {
  const access = checkFeedAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const windowHours = clampWindow(
    new URL(req.url).searchParams.get("windowHours"),
  );
  try {
    const body = await feedCache(`feed:${windowHours}`, async () => {
      const db = openDb(process.env.DASH_DB ?? "data.sqlite");
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const health = evaluateHealth(
          getHeartbeats(db),
          nowSec,
          getEngineStart(db),
        );
        // `healthy: false` is the consumer's cue to freeze timestamps and hide
        // act-now affordances rather than quietly serving stale state as live.
        return {
          ...buildSignalFeed(db, { nowSec, windowHours }),
          healthy: health.ok,
          staleLoops: health.staleLoops,
        };
      } finally {
        db.close();
      }
    });
    return Response.json(body);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/signals] failed:", message);
    // Degrade to a well-formed empty feed marked unhealthy: a consumer that
    // parses this must never mistake a failure for "no signals today".
    return Response.json(
      {
        updatedAt: Math.floor(Date.now() / 1000),
        windowHours,
        active: [],
        settled: [],
        record30d: { settled: 0, wins: 0, implied: 0, excess: 0, sd: 0 },
        healthy: false,
        error: message,
      },
      { status: 200 },
    );
  }
}
