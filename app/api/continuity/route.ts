import { openDb } from "../../../lib/db";
import {
  computeContinuity,
  CONTINUITY_WINDOW_DAYS,
} from "../../../lib/continuity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 数据连续性 · 30 天起算时钟(公开,无鉴权 —— 与 /api/health 同一受众:
// 「监控是不是一直在看着市场」是每个订阅方都有权核验的事实)。
// 判定材料与口径见 lib/continuity.ts;/status 的连续性区渲染的就是本响应。
export async function GET() {
  try {
    const db = openDb(process.env.DASH_DB || "data.sqlite");
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const todayStart = nowSec - (nowSec % 86_400);
      // 比展示窗多取 2 天:跨越窗口左边界的断档要靠余量里的行才看得见。
      const fetchStartSec = todayStart - (CONTINUITY_WINDOW_DAYS + 2) * 86_400;
      const ts = (
        db
          .prepare(
            "SELECT ts FROM cycle_metrics WHERE loop = 'consensus' AND ts >= ? ORDER BY ts ASC",
          )
          .all(fetchStartSec) as { ts: number }[]
      ).map((r) => r.ts);
      // 记录起点与取数窗无关 —— 全表 MIN 走 (loop, ts) 索引,常数代价。
      const era = db
        .prepare(
          "SELECT MIN(ts) AS t FROM cycle_metrics WHERE loop = 'consensus'",
        )
        .get() as { t: number | null };
      return Response.json(
        computeContinuity(ts, { nowSec, eraFirstTs: era.t, fetchStartSec }),
      );
    } finally {
      db.close();
    }
  } catch (error) {
    console.error("[/api/continuity] failed:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
