import { openDb } from "../../../../lib/db";
import { guardExpensive } from "../../../../lib/apiGuard";
import { budgetFor, takeCardToken } from "../../../../lib/cardBudget";
import { getCardSettings } from "../../../../lib/cardSettings";
import { serveMarketCard } from "../../../../lib/marketCardService";
import { getEngineStart, getHeartbeats } from "../../../../lib/heartbeat";
import { evaluateHealth } from "../../../../lib/health";

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
//
// 2026-08-21:窗口层接管缓存与预算(lib/marketCardService)。这条路由自己的
// 60s promise cache 已删 —— 在途合并与新鲜度都归窗口层管,两层缓存叠在一起
// 只会让「这张卡到底多新」多一个说不清的来源。
//
// 与对外路由(/api/market-card/[cid])**共用同一个工作集与同一个令牌桶**:
// 上游预算本来就是同一份,分两个桶只是把同一个天花板切成两半;而人在网页上看的
// 热门市场正好也是订阅方在看的,共享工作集是净收益(互相预热)。
// guardExpensive 保留,叠在桶之上 —— 它防的是单 IP 滥用,那是另一件事。

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
  const db = openDb(process.env.DASH_DB ?? "data.sqlite");
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const health = evaluateHealth(
      getHeartbeats(db),
      nowSec,
      getEngineStart(db),
    );
    const cfg = getCardSettings(db);
    const out = await serveMarketCard(db, conditionId, {
      nowSec,
      staleGateSec: cfg.staleGateSec,
      ttlSec: cfg.windowTtlSec,
      lruMax: cfg.lruMax,
      takeToken: (cost) => takeCardToken(budgetFor(health, cfg.budgetPerMin), cost),
    });
    if (!out.ok) {
      return Response.json(
        { error: "upstream budget exhausted — retry shortly" },
        {
          status: out.status,
          headers: { "retry-after": String(out.retryAfterSec) },
        },
      );
    }
    // 卡片字段平铺在顶层(网页与 bot 的既有读法),额外三项是 additive ——
    // 老调用方忽略即可。
    return Response.json({
      ...out.card,
      builtAt: out.builtAt,
      staleSec: out.staleSec,
      live: out.live,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/market] failed:", message);
    return Response.json({ error: message }, { status: 200 });
  } finally {
    db.close();
  }
}
