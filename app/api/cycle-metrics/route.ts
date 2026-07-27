import { openDb } from "../../../lib/db";
import { dailyDensity } from "../../../lib/cycleMetrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Signal-density trend (P0.9): daily aggregates of the consensus cycle's
// decision metadata, newest first. Feeds the /discovery density strip — the
// dial that separates "market heat collapsed" from "thresholds drifted".
export async function GET() {
  try {
    const db = openDb(process.env.DASH_DB ?? "data.sqlite");
    try {
      return Response.json({ days: dailyDensity(db, { days: 14 }) });
    } finally {
      db.close();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/cycle-metrics] failed:", message);
    return Response.json({ days: [], error: message });
  }
}
