import { openDb } from "../../../lib/db";
import { withExitCounterfactual } from "../../../lib/exitCounterfactual";
import { getEventCategories, type EventTaxonomy } from "../../../lib/gamma";
import {
  buildFollowView,
  type FollowPositionRow,
  type TaxonomyByCid,
} from "../../../lib/follow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One follow_strategies row as read for the view (params_json parsed in
// buildFollowView; enabled is 0/1; created_at feeds the fund profile — 成立/
// 运行时长/年化 的锚点,seed 时落库,理论上非空但类型对 NULL 宽容).
type StrategyRow = {
  id: number;
  name: string;
  enabled: number;
  params_json: string | null;
  created_at: number | null;
};

// follow_positions row read for the view: exactly the FollowPositionRow columns
// PLUS event_slug + title — the route needs the slug to look up each position's
// event category, and the /follow board wants the human market title next to the
// outcome. PLUS the formation/markout attribution columns(P1 三段成本分解:
// formation_ts/formation_price 是共识形成时刻与彼时市价,markout_30m/2h 是形成后
// 30min/2h 的回填价;老仓位/取价失败为 null,前端逐行兜底)。这些额外列在传给
// buildFollowView 时结构无害(它只读 FollowPositionRow 字段),原样流入 open/settled
// 数组,客户端无需额外请求即可渲染延迟成本与 markout。
// PLUS asset(CLOB token id):持仓中列表「当前价」列需要它按 token 惰性取价
// (见 app/useCurrentPrices.ts),之前这条 SQL 没选它——不是这张表没有这一列
// (follow_positions 建表时就有 asset,写入侧 lib/follow.ts 一直在填),只是
// 之前的视图不需要它,选出来才第一次流到客户端。
type PositionRow = FollowPositionRow & {
  asset: string;
  event_slug: string;
  title: string;
  formation_ts: number | null;
  formation_price: number | null;
  markout_30m: number | null;
  markout_2h: number | null;
  // 执行层归因:开仓瞬间盘口快照模拟吃单。exec_price=模拟成交均价、
  // exec_best_ask=彼时最优卖价、exec_filled_usd=盘口能吃下的金额。老仓 null。
  exec_price: number | null;
  exec_best_ask: number | null;
  exec_filled_usd: number | null;
};

// Read-only: strategies + their paper positions + per-strategy metrics. No live
// upstream fetch except the (cached, degradable) event-category enrichment.
export async function GET() {
  try {
    const db = openDb(process.env.DASH_DB ?? "data.sqlite");
    try {
      const strategies = db
        .prepare(
          "SELECT id, name, enabled, params_json, created_at FROM follow_strategies ORDER BY id",
        )
        .all() as StrategyRow[];

      const positions = db
        .prepare(
          `SELECT id, strategy_id, condition_id, outcome, asset, title, event_slug, size_usd,
                  entry_price, smart_avg_price, shares, status, entry_ts,
                  exit_ts, exit_price, realized_pnl,
                  formation_ts, formation_price, markout_30m, markout_2h,
                  exec_price, exec_best_ask, exec_filled_usd, fee_usd
             FROM follow_positions`,
        )
        .all() as PositionRow[];

      // Categories live in EVENT TAGS (getEventCategories → slug -> 税法
      // {一级, 二级})。A fetch/DB failure degrades to {} so every position
      // reads "未分类" — the strategy/position/metrics payload is the product;
      // category is enrichment and must not be able to fail the whole endpoint.
      const slugs = [
        ...new Set(positions.map((p) => p.event_slug).filter(Boolean)),
      ];
      let catBySlug: Record<string, EventTaxonomy> = {};
      try {
        catBySlug = await getEventCategories(db, slugs);
      } catch (e) {
        console.warn(
          "[/api/follow] getEventCategories failed, 全部按未分类降级:",
          e,
        );
      }
      const taxByCid: TaxonomyByCid = {};
      for (const p of positions) {
        taxByCid[p.condition_id] = catBySlug[p.event_slug] ?? null;
      }

      const view = buildFollowView(strategies, positions, taxByCid);
      // 反事实退出摘要:bulk 读已回填的模拟结果附到每档视图上。任何失败只
      // 降级为"无摘要"(面板省略该块),绝不拖垮整个接口。
      try {
        return Response.json({
          strategies: withExitCounterfactual(db, view.strategies),
        });
      } catch (e) {
        console.warn("[/api/follow] exitCounterfactual 附加失败,降级省略:", e);
        return Response.json(view);
      }
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
