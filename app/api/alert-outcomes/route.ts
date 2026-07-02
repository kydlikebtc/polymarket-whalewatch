import { openDb } from "../../../lib/db";
import { computeAlertOutcomes } from "../../../lib/alertOutcomes";
import { getMarketMeta } from "../../../lib/gamma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Each cold alert can cost up to two prices-history calls; results are cached
// permanently (immutable history), so only first views pay.
const MAX = 100;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const raw: unknown[] = Array.isArray(body?.ids) ? body.ids : [];
  const ids = [
    ...new Set(
      raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0),
    ),
  ].slice(0, MAX);
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
