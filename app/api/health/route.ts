import { openDb } from "../../../lib/db";
import { getEngineStart, getHeartbeats } from "../../../lib/heartbeat";
import { evaluateHealth } from "../../../lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness probe for external watchers (uptime pingers, docker healthcheck,
// host cron): 200 while every engine loop has beaten within its threshold,
// 503 otherwise. "No signals" and "engine died" look identical in the channel
// — this endpoint is where they stop looking identical.
export async function GET() {
  try {
    const db = openDb(process.env.DASH_DB || "data.sqlite");
    try {
      const report = evaluateHealth(
        getHeartbeats(db),
        Math.floor(Date.now() / 1000),
        getEngineStart(db),
      );
      return Response.json(report, { status: report.ok ? 200 : 503 });
    } finally {
      db.close();
    }
  } catch (error) {
    // A db that can't even open is the least healthy state of all.
    console.error("[/api/health] failed:", error);
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
