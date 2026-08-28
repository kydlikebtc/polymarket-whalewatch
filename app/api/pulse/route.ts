import { guardExpensive } from "../../../lib/apiGuard";
import { buildConvictionIndex } from "../../../lib/convictionIndex";
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
        const pulse = buildPulse(db);
        // 确信指数(additive 键):品类×日激辩度。任何失败只降级为 null ——
        // 日榜/分歧是本端点的主产品,新增指数不得拖垮整个 payload。
        let conviction = null;
        try {
          conviction = buildConvictionIndex(db);
        } catch (e) {
          console.warn("[/api/pulse] conviction 现算失败,降级 null:", e);
        }
        return { ...pulse, conviction };
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
