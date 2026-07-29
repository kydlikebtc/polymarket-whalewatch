import { openDb } from "../../../../lib/db";
import { buildMarketCard } from "../../../../lib/marketCard";
import { createPromiseCache } from "../../../../lib/promiseCache";
import { guardExpensive } from "../../../../lib/apiGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin wrapper: the card composition lives in lib/marketCard (shared with the
// Telegram bot's 🎯 query reply so the two surfaces can never drift apart).
//
// A cold card is one of the most expensive reads here: a gamma call, a
// multi-page /trades window, and up to a dozen wallet-age probes. That was
// survivable while the only callers were a human on the dashboard and the
// bot. Once a mobile client renders this per market view, the same rate lands
// on the data-api budget the 4-second engine loop shares — and the failure
// mode is "cards time out" and "the channel goes quiet" at the same moment.
// Two layers, same pattern scan/consensus/accumulation already use: a
// per-conditionId promise cache (concurrent misses join ONE in-flight load)
// plus the public-deployment rate limiter.
const CACHE_TTL_MS = 60_000;
const cardCache = createPromiseCache<unknown>(CACHE_TTL_MS);

// Cost 2: cheaper than a full wallet profile, dearer than one batch row.
const LIMITS = { perIp: 120, global: 600, cost: 2 };

export async function GET(
  req: Request,
  { params }: { params: Promise<{ conditionId: string }> },
) {
  const { conditionId } = await params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(conditionId)) {
    return Response.json({ error: "invalid conditionId" }, { status: 400 });
  }
  const limited = guardExpensive(req, "market-card", LIMITS, {
    error: "rate limited",
  });
  if (limited) return limited;
  try {
    // Key on the normalized id so 0xAB… and 0xab… share one entry.
    const card = await cardCache(conditionId.toLowerCase(), async () => {
      const db = openDb(process.env.DASH_DB ?? "data.sqlite");
      try {
        return await buildMarketCard(db, conditionId);
      } finally {
        db.close();
      }
    });
    return Response.json(card);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/market] failed:", message);
    return Response.json({ error: message }, { status: 200 });
  }
}
