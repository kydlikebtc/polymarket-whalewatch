import { openDb } from "../../../../lib/db";
import { buildMarketCard } from "../../../../lib/marketCard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin wrapper: the card composition lives in lib/marketCard (shared with the
// Telegram bot's 🎯 query reply so the two surfaces can never drift apart).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ conditionId: string }> },
) {
  const { conditionId } = await params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(conditionId)) {
    return Response.json({ error: "invalid conditionId" }, { status: 400 });
  }
  try {
    const db = openDb(process.env.DASH_DB ?? "data.sqlite");
    try {
      return Response.json(await buildMarketCard(db, conditionId));
    } finally {
      db.close();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/market] failed:", message);
    return Response.json({ error: message }, { status: 200 });
  }
}
