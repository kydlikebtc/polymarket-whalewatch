import { openDb } from "../../../lib/db";
import { getAllSmartTags } from "../../../lib/smartWallets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The full smart-money whitelist for the clickable dialog: address + the same
// score/winRate/netPnl the tags carry, sorted best-score first. Small
// table (hundreds of rows), so serving it whole is cheap.
export async function GET() {
  try {
    const db = openDb(process.env.DASH_DB ?? "data.sqlite");
    try {
      const tags = getAllSmartTags(db);
      const wallets = [...tags.entries()]
        .map(([address, t]) => ({
          address,
          score: t.score,
          winRate: t.winRate,
          netPnl: t.netPnl,
          isWhitelist: t.isWhitelist,
        }))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return Response.json({ wallets, count: wallets.length });
    } finally {
      db.close();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/whitelist] failed:", message);
    return Response.json({ wallets: [], count: 0, error: message });
  }
}
