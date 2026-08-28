import { guardExpensive } from "../../../lib/apiGuard";
import { openDb } from "../../../lib/db";
import { createBoundedCache } from "../../../lib/boundedCache";
import { parseTheme, renderSelfTestEmbed } from "../../../lib/embedCards";
import {
  buildSelfTestVerdict,
  readLocalStats,
  readPool,
} from "../../../lib/selfTest";
import { siteBase } from "../../../lib/seo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 可嵌入判决卡(设计文档 2026-08-28-smart-money-selftest-design.md)。
// 红线:**零上游** —— 嵌入卡是病毒分发面,iframe 每次展示都是请求,取数
// 只读 wallet_stats 现存行(不限龄,卡上标数据截至日)+ smart_wallets 池。
// 地址从未被测过 → 「尚未体检」引导卡,绝不替围观者花 42 次上游调用。
// 正常分享流程里判决刚出、SQLite 行必然存在,此红线不牺牲真实场景。
//
// 缓存用 boundedCache 而非 record/status 的 promiseCache:键含地址,
// 键空间攻击者可枚举,无界 Map 是有公共触发器的慢内存泄漏。
const CACHE_TTL_MS = 60_000;
const cache = createBoundedCache<string>(CACHE_TTL_MS, 500);

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

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
  const url = new URL(req.url);
  const theme = parseTheme(url.searchParams.get("theme"));
  const address = (url.searchParams.get("address") ?? "").toLowerCase();
  if (!ADDRESS_RE.test(address)) {
    return new Response("missing or invalid ?address=0x…", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const key = `${address}:${theme}`;
  try {
    let html = cache.get(key);
    if (!html) {
      const db = openDb(process.env.DASH_DB ?? "data.sqlite");
      try {
        const { stats, fetchedAt } = await readLocalStats(db, address);
        html = renderSelfTestEmbed(
          {
            address,
            verdict: buildSelfTestVerdict(address, stats, readPool(db)),
            statsFetchedAt: fetchedAt,
          },
          { theme, baseUrl: siteBase() },
        );
      } finally {
        db.close();
      }
      cache.set(key, html);
    }
    return new Response(html, { headers: HTML_HEADERS });
  } catch (error) {
    console.error("[/embed/selftest] failed:", error);
    return new Response("embed unavailable", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
