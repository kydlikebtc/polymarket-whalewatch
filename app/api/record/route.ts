import { guardExpensive } from "../../../lib/apiGuard";
import { openDb } from "../../../lib/db";
import { createPromiseCache } from "../../../lib/promiseCache";
import { buildRecordFeed } from "../../../lib/recordFeed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 对外信号批次 3:/record 公开战绩页的数据接口。
// 刻意无鉴权 —— 公开可验证记录是产品护城河,拦住读者就没有护城河;
// 靠限流 + 60s 缓存 + 零上游调用自保(与 /api/signals 同一自保姿态)。
const CACHE_TTL_MS = 60_000;
const cache = createPromiseCache<unknown>(CACHE_TTL_MS);

export async function GET(req: Request) {
  const limited = guardExpensive(
    req,
    "record",
    { perIp: 60, global: 300 },
    { strategies: [] },
  );
  if (limited) return limited;
  try {
    const body = await cache("record", async () => {
      const db = openDb(process.env.DASH_DB ?? "data.sqlite");
      try {
        return buildRecordFeed(db);
      } finally {
        db.close();
      }
    });
    return Response.json(body);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/record] failed:", message);
    return Response.json(
      {
        updatedAt: Math.floor(Date.now() / 1000),
        strategies: [],
        digest: { day: null, tail: null },
        error: message,
      },
      { status: 200 },
    );
  }
}
