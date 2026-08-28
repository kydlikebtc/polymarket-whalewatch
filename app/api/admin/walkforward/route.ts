import { checkWriteAccess, guardExpensive } from "../../../../lib/apiGuard";
import { openDb } from "../../../../lib/db";
import type { WalkforwardReport } from "../../../../lib/walkforward";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /manage「🧪 阈值重推」卡的数据口。只读最新一行 walkforward_reports ——
// 报告由 scripts/walkforward.ts 手动产出落库,本路由不触发任何计算(重推是
// 分钟级离线活,绝不塞进请求路径)。ADMIN_TOKEN 后台数据,与其它 admin 路由
// 同一姿态;报告涉及全部档位的参数与网格,属运营内部事,不走公开 API。

const LIMITS = { perIp: 60, global: 120 };

export async function GET(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const limited = guardExpensive(req, "admin-walkforward", LIMITS, {});
  if (limited) return limited;
  const db = openDb(process.env.DASH_DB ?? "data.sqlite");
  try {
    const row = db
      .prepare(
        `SELECT id, created_at, window_from, window_to, grid_size, report_json
           FROM walkforward_reports
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get() as
      | {
          id: number;
          created_at: number;
          window_from: number;
          window_to: number;
          grid_size: number;
          report_json: string;
        }
      | undefined;
    if (!row) {
      // 空态是一等状态:卡要能告诉运营者「怎么产出第一份报告」。
      return Response.json({ report: null });
    }
    let report: WalkforwardReport | null = null;
    try {
      report = JSON.parse(row.report_json) as WalkforwardReport;
    } catch (e) {
      console.error("[admin-walkforward] report_json 解析失败:", e);
      return Response.json(
        { error: `报告行 id=${row.id} 的 report_json 损坏` },
        { status: 500 },
      );
    }
    return Response.json({
      id: row.id,
      createdAt: row.created_at,
      windowFrom: row.window_from,
      windowTo: row.window_to,
      gridSize: row.grid_size,
      report,
    });
  } finally {
    db.close();
  }
}
