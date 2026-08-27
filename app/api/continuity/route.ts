import { openDb } from "../../../lib/db";
import { readContinuity } from "../../../lib/continuity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 数据连续性 · 30 天起算时钟(公开,无鉴权 —— 与 /api/health 同一受众:
// 「监控是不是一直在看着市场」是每个订阅方都有权核验的事实)。
// 判定材料与口径见 lib/continuity.ts;/status 的连续性区渲染的就是本响应。
export async function GET() {
  try {
    const db = openDb(process.env.DASH_DB || "data.sqlite");
    try {
      return Response.json(readContinuity(db));
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
