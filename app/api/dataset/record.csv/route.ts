import { guardExpensive } from "../../../../lib/apiGuard";
import { openDb } from "../../../../lib/db";
import { buildRecordCsv } from "../../../../lib/datasetExport";
import { createPromiseCache } from "../../../../lib/promiseCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 公开数据集:已发布信号全量台账 CSV(docs/plans/2026-08-27-outlet-trio-design.md #3)。
// 零上游、全量现生成(千行级毫秒);限流从紧 —— 这是给研究者的批量出口,
// 不是给爬虫的轮询面,正常用法是「拿一次、本地分析」。
const CACHE_TTL_MS = 300_000;
const cache = createPromiseCache<string>(CACHE_TTL_MS);

export async function GET(req: Request) {
  const limited = guardExpensive(req, "dataset", { perIp: 6, global: 30 }, {});
  if (limited) {
    return new Response("rate limited — retry in a minute", {
      status: 429,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  try {
    const csv = await cache("record.csv", async () => {
      const db = openDb(process.env.DASH_DB ?? "data.sqlite");
      try {
        return buildRecordCsv(db);
      } finally {
        db.close();
      }
    });
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="whalewatch-record.csv"',
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (error) {
    console.error("[/api/dataset/record.csv] failed:", error);
    return new Response("dataset unavailable", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
