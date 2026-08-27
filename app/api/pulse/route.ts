import { guardExpensive } from "../../../lib/apiGuard";
import { openDb } from "../../../lib/db";
import { buildPulse } from "../../../lib/marketPulse";
import { createPromiseCache } from "../../../lib/promiseCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 市场脉搏(异常日榜 + 散户vs鲸鱼分歧)。公开、零上游 —— 全部从 market_daily
// 现算;数据按日更新,5 分钟缓存绰绰有余。
const CACHE_TTL_MS = 300_000;
const cache = createPromiseCache<unknown>(CACHE_TTL_MS);

export async function GET(req: Request) {
  const limited = guardExpensive(req, "pulse", { perIp: 60, global: 300 }, {});
  if (limited) return limited;
  try {
    const body = await cache("pulse", async () => {
      const db = openDb(process.env.DASH_DB ?? "data.sqlite");
      try {
        return buildPulse(db);
      } finally {
        db.close();
      }
    });
    return Response.json(body, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch (error) {
    console.error("[/api/pulse] failed:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
