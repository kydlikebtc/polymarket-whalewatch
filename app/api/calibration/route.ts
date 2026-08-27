import { guardExpensive } from "../../../lib/apiGuard";
import { openDb } from "../../../lib/db";
import { buildCalibration } from "../../../lib/calibration";
import { createPromiseCache } from "../../../lib/promiseCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 市场校准研究。公开、零上游;样本随结算回填缓慢增长,10 分钟缓存足够。
const CACHE_TTL_MS = 600_000;
const cache = createPromiseCache<unknown>(CACHE_TTL_MS);

export async function GET(req: Request) {
  const limited = guardExpensive(
    req,
    "calibration",
    { perIp: 30, global: 150 },
    {},
  );
  if (limited) return limited;
  try {
    const body = await cache("calibration", async () => {
      const db = openDb(process.env.DASH_DB ?? "data.sqlite");
      try {
        return buildCalibration(db);
      } finally {
        db.close();
      }
    });
    return Response.json(body, {
      headers: { "Cache-Control": "public, max-age=600" },
    });
  } catch (error) {
    console.error("[/api/calibration] failed:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
