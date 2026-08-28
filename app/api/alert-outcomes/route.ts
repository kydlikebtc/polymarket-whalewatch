import { openDb } from "../../../lib/db";
import { computeAlertOutcomes } from "../../../lib/alertOutcomes";
import { getMarketMeta } from "../../../lib/gamma";
import { guardExpensive } from "../../../lib/apiGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Each cold alert can cost up to three prices-history calls; results are cached
// permanently (immutable history), so only first views pay.
const MAX = 100;

// Public-deployment abuse cap, charged in ALERT IDS (each cold one can cost
// two prices-history calls). The worker backfill loop covers every alert on
// its own, so the interactive path only needs enough budget for real browsing
// (the alerts page already self-throttles to one call per 60s).
const LIMITS = { perIp: 400, global: 1500 };

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const raw: unknown[] = Array.isArray(body?.ids) ? body.ids : [];
  const ids = [
    ...new Set(
      raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0),
    ),
  ].slice(0, MAX);
  const limited = guardExpensive(
    req,
    "alert-outcomes",
    { ...LIMITS, cost: ids.length },
    { outcomes: {} },
  );
  if (limited) return limited;
  try {
    const db = openDb(process.env.DASH_DB ?? "data.sqlite");
    try {
      const outcomes = await computeAlertOutcomes(db, ids, {
        getMeta: (cids) => getMarketMeta(db, cids),
      });
      return Response.json({ outcomes });
    } finally {
      db.close();
    }
  } catch (e) {
    console.error("[/api/alert-outcomes] failed:", e);
    return Response.json(
      { outcomes: {}, error: e instanceof Error ? e.message : String(e) },
      { status: 200 },
    );
  }
}
