import { openDb } from "../../../lib/db";
import { getEventCategories } from "../../../lib/gamma";
import { buildFollowView, type FollowPositionRow } from "../../../lib/follow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One follow_strategies row as read for the view (params_json parsed in
// buildFollowView; enabled is 0/1).
type StrategyRow = {
  id: number;
  name: string;
  enabled: number;
  params_json: string | null;
};

// follow_positions row read for the view: exactly the FollowPositionRow columns
// PLUS event_slug + title — the route needs the slug to look up each position's
// event category, and the /follow board wants the human market title next to the
// outcome. Both are structurally harmless when passed to buildFollowView (which
// only reads the FollowPositionRow fields) and flow through untouched into the
// open/settled arrays, so the client can render title/slug without extra fetches.
type PositionRow = FollowPositionRow & { event_slug: string; title: string };

// Read-only: strategies + their paper positions + per-strategy metrics. No live
// upstream fetch except the (cached, degradable) event-category enrichment.
export async function GET() {
  try {
    const db = openDb(process.env.DASH_DB ?? "data.sqlite");
    try {
      const strategies = db
        .prepare(
          "SELECT id, name, enabled, params_json FROM follow_strategies ORDER BY id",
        )
        .all() as StrategyRow[];

      const positions = db
        .prepare(
          `SELECT strategy_id, condition_id, outcome, title, event_slug, size_usd,
                  entry_price, smart_avg_price, shares, status, entry_ts,
                  exit_ts, exit_price, realized_pnl
             FROM follow_positions`,
        )
        .all() as PositionRow[];

      // Categories live in EVENT TAGS (getEventCategories → slug -> category).
      // A fetch/DB failure degrades to {} so every position reads "未分类" — the
      // strategy/position/metrics payload is the product; category is enrichment
      // and must not be able to fail the whole endpoint.
      const slugs = [
        ...new Set(positions.map((p) => p.event_slug).filter(Boolean)),
      ];
      let catBySlug: Record<string, string | null> = {};
      try {
        catBySlug = await getEventCategories(db, slugs);
      } catch (e) {
        console.warn(
          "[/api/follow] getEventCategories failed, 全部按未分类降级:",
          e,
        );
      }
      const categoryByCid: Record<string, string | null> = {};
      for (const p of positions) {
        categoryByCid[p.condition_id] = catBySlug[p.event_slug] ?? null;
      }

      return Response.json(
        buildFollowView(strategies, positions, categoryByCid),
      );
    } finally {
      db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[/api/follow] failed:", message);
    // Degrade to HTTP 200 + { strategies: [], error } like every other read-only
    // route (consensus/accumulation): the page reads the body's error field and
    // renders a graceful callout instead of a hard fetch rejection on a 500.
    return Response.json({ strategies: [], error: message });
  }
}
