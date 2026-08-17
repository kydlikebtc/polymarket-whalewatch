import { openDb } from "../../lib/db";
import { llmsTxt, siteBase } from "../../lib/seo";

// GEO 站点说明书(llms.txt 规范):给 AI 爬虫/助手的结构化站点导览,
// 内容在 lib/seo.llmsTxt(已单测)。活数(钱包/告警计数)要求请求时读库。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = openDb(process.env.DASH_DB ?? "data.sqlite");
  return new Response(llmsTxt(db, siteBase()), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
