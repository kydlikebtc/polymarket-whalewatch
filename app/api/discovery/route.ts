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
      error: message,
    });
  }
}
