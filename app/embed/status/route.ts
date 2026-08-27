import { guardExpensive } from "../../../lib/apiGuard";
import { openDb } from "../../../lib/db";
import { getEngineStart, getHeartbeats } from "../../../lib/heartbeat";
import { evaluateHealth } from "../../../lib/health";
import { readContinuity } from "../../../lib/continuity";
import { parseTheme, renderStatusEmbed } from "../../../lib/embedCards";
import { createPromiseCache } from "../../../lib/promiseCache";
import { siteBase } from "../../../lib/seo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 可嵌入状态徽章:引擎存活 + 连续性时钟读数,与 /api/health、/api/continuity
// 同源同口径。形态裁决同 /embed/record(Route Handler 直出自包含 HTML)。
const CACHE_TTL_MS = 60_000;
const cache = createPromiseCache<string>(CACHE_TTL_MS);

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "public, max-age=60",
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
    const html = await cache(`status:${theme}`, async () => {
      const db = openDb(process.env.DASH_DB ?? "data.sqlite");
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const health = evaluateHealth(
          getHeartbeats(db),
          nowSec,
          getEngineStart(db),
        );
        return renderStatusEmbed(health, readContinuity(db, nowSec), {
          theme,
          baseUrl: siteBase(),
        });
      } finally {
        db.close();
      }
    });
    return new Response(html, { headers: HTML_HEADERS });
  } catch (error) {
    console.error("[/embed/status] failed:", error);
    return new Response("embed unavailable", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
