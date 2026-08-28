import { openDb } from "../../../lib/db";
import { buildDiscoveryView } from "../../../lib/discoveryView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The discovery funnel read-model: candidate wallets (30d evidence window,
// status derived — never stored) plus the program's pool output. All
// aggregation lives in lib/discoveryView (tested); this route only serves it.
export async function GET() {
  try {
    const db = openDb(process.env.DASH_DB ?? "data.sqlite");
    try {
      return Response.json(buildDiscoveryView(db));
    } finally {
      db.close();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/discovery] failed:", message);
    return Response.json({
      candidates: [],
      admitted: [],
      counts: { evidenceRows: 0, candidateWallets: 0, admitted: 0 },
      // 错误兜底与真实视图同形(additive 键也要在):渲染侧对 undefined 有
      // 防御,这里补空壳让「接口报错」与「记分卡没数据」在 UI 上可区分。
      scorecard: {
        groups: [],
        mmSplit: [],
        disclosures: {
          gradedAlerts: 0,
          rows: 0,
          feeUnknownDropped: 0,
          malformedDropped: 0,
          orphanRows: 0,
        },
        groupCount: 0,
      },
      league: {
        hall: [],
        fade: [],
        testedWallets: 0,
        disclosures: {
          gradedAlerts: 0,
          rows: 0,
          feeUnknownDropped: 0,
          malformedDropped: 0,
        },
      },
      error: message,
    });
  }
}
