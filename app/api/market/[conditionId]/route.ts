import { openDb } from "../../../../lib/db";
import { getMarketMeta } from "../../../../lib/gamma";
import { getAllSmartTags } from "../../../../lib/smartWallets";
import { getWalletAges } from "../../../../lib/walletAge";
import {
  composeMarketBrief,
  fetchMarketWindow,
} from "../../../../lib/marketBrief";
import { parseAlertHit, type AlertHitRow } from "../../../../lib/alertHits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Single-market signal card: one market-scoped window (24h / $500 floor)
// composed through the same detectors every other surface uses, plus the
// tool's own alert history for the market (with validation columns) and the
// fresh-wallet unusual-flow shortlist (age lookups permanently cached, capped
// per request so a hot market can't stampede /activity).
const WINDOW_SEC = 24 * 3600;
const FRESH_MIN_FILL_USD = 5000;
const FRESH_MAX_AGE_DAYS = 7;
const FRESH_AGE_LOOKUPS = 12;
const HISTORY_LIMIT = 20;
const HISTORY_WINDOW_DAYS = 90;

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
      const nowSec = Math.floor(Date.now() / 1000);
      const [metaMap, window] = await Promise.all([
        getMarketMeta(db, [conditionId]),
        fetchMarketWindow(conditionId, { sinceSec: nowSec - WINDOW_SEC }),
      ]);
      const meta = metaMap[conditionId] ?? null;
      const smart = getAllSmartTags(db);
      const brief = composeMarketBrief(window.trades, smart, conditionId);

      // Market identity comes off the freshest trade row (gamma meta carries
      // no title); an empty window degrades to nulls, the page shows the cid.
      const head = window.trades[0] ?? null;
      const identity = head
        ? { title: head.title, slug: head.slug, eventSlug: head.eventSlug }
        : null;

      // Fresh-wallet unusual flow: biggest single non-pool BUY fills, ages
      // resolved from the permanent cache (missing = lookup failed, skipped).
      const fills = window.trades
        .filter(
          (t) =>
            t.side === "BUY" &&
            t.size * t.price >= FRESH_MIN_FILL_USD &&
            !smart.has(t.proxyWallet.toLowerCase()),
        )
        .sort((a, b) => b.size * b.price - a.size * a.price)
        .slice(0, FRESH_AGE_LOOKUPS);
      const ages = await getWalletAges(db, [
        ...new Set(fills.map((t) => t.proxyWallet.toLowerCase())),
      ]);
      const freshFlow = fills.flatMap((t) => {
        const firstTs = ages[t.proxyWallet.toLowerCase()];
        if (typeof firstTs !== "number") return [];
        const ageDays = (nowSec - firstTs) / 86_400;
        if (ageDays > FRESH_MAX_AGE_DAYS) return [];
        return [
          {
            wallet: t.proxyWallet.toLowerCase(),
            ageDays,
            usd: t.size * t.price,
            price: t.price,
            outcome: t.outcome,
            ts: t.timestamp,
          },
        ];
      });

      // The tool's own alert history for this market + validation verdicts.
      const hitRows = db
        .prepare(
          `SELECT a.type, a.payload, a.created_at,
                  ao.won, ao.price_1h, ao.price_24h, ao.resolved
           FROM alerts a
           LEFT JOIN alert_outcomes ao ON ao.alert_id = a.id
           WHERE a.created_at > ? AND a.payload LIKE ?
           ORDER BY a.created_at DESC LIMIT ?`,
        )
        .all(
          nowSec - HISTORY_WINDOW_DAYS * 86_400,
          `%${conditionId}%`,
          HISTORY_LIMIT,
        ) as (AlertHitRow & {
        won: number | null;
        price_1h: number | null;
        price_24h: number | null;
        resolved: number | null;
      })[];
      const history = hitRows.flatMap((r) => {
        const hit = parseAlertHit(r);
        if (!hit) return [];
        return [
          {
            ...hit,
            won: r.won,
            price1h: r.price_1h,
            price24h: r.price_24h,
            resolved: r.resolved === 1,
          },
        ];
      });

      return Response.json({
        conditionId,
        identity,
        meta,
        brief,
        freshFlow,
        history,
        window: {
          trades: window.trades.length,
          truncated: window.truncated,
          hours: WINDOW_SEC / 3600,
        },
      });
    } finally {
      db.close();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/market] failed:", message);
    return Response.json({ error: message }, { status: 200 });
  }
}
