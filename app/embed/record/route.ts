import { guardExpensive } from "../../../lib/apiGuard";
import { openDb } from "../../../lib/db";
import { buildRecordFeed } from "../../../lib/recordFeed";
import { parseTheme, renderRecordEmbed } from "../../../lib/embedCards";
import { createPromiseCache } from "../../../lib/promiseCache";
import { siteBase } from "../../../lib/seo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 可嵌入战绩卡(docs/plans/2026-08-27-outlet-trio-design.md #2)。
// Route Handler 直出自包含 HTML 而非 app 页面:根 layout 对所有 page 强制
// 包裹 TopNav/Provider,嵌入卡要的是极简自包含 —— 这里干净绕开。
// 数据与 /record 页同源(buildRecordFeed),两处永不打架。
const CACHE_TTL_MS = 60_000;
const cache = createPromiseCache<string>(CACHE_TTL_MS);

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "public, max-age=60",
  // 嵌入片段不该抢主页面的搜索位。
  "X-Robots-Tag": "noindex",
};

export async function GET(req: Request) {
  const limited = guardExpensive(req, "embed", { perIp: 60, global: 300 }, {});
  if (limited) {
    return new Response("rate limited — retry in a minute", {
      status: 429,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const theme = parseTheme(new URL(req.url).searchParams.get("theme"));
  try {
    const html = await cache(`record:${theme}`, async () => {
      const db = openDb(process.env.DASH_DB ?? "data.sqlite");
      try {
        return renderRecordEmbed(buildRecordFeed(db), {
          theme,
          baseUrl: siteBase(),
        });
      } finally {
        db.close();
      }
    });
    return new Response(html, { headers: HTML_HEADERS });
  } catch (error) {
    console.error("[/embed/record] failed:", error);
    return new Response("embed unavailable", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
