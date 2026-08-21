import { openDb } from "../../../../../lib/db";
import { checkFeedAccess } from "../../../../../lib/feedAuth";
import { busTypeAllowed } from "../../../../../lib/apiKeys";
import { getEngineStart, getHeartbeats } from "../../../../../lib/heartbeat";
import { evaluateHealth } from "../../../../../lib/health";
import { budgetFor, takeCardToken } from "../../../../../lib/cardBudget";
import { serveMarketCard } from "../../../../../lib/marketCardService";
import { SIGNAL_DISCLAIMER } from "../../../../../lib/signalPush";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 对外的市场深度卡 —— 订阅方的用户正要下单时的那一眼。
//
// 与 /api/market/[cid](网页 + TG bot,无 key)刻意分立:那条是内部面,可随网页
// 需求自由改;这条是对外契约,要鉴权/范围/预算/陈旧闸。把两套策略塞进一个路由会
// 很脏,而且对外契约一旦定了就不该跟着网页需求漂。二者共用 buildMarketCard,
// 也共用同一个窗口层与同一个令牌桶(lib/marketCardService 文件头有理由)。
//
// 与 /api/signals 的根本差别,必须写进对外文档:那条零上游调用,这条**按需打上游**。
// 所以这里有预算、有背压(429)、有陈旧闸,而那条没有。
//
// 范围 `market` 且 realtime 专属。这不违反「延迟是唯一杠杆、字段不阉割」——
// 那条纪律管的是同一端点内不同 tier 的字段集;范围机制本来就是「没订阅就拿不到」。
// 一张延迟 30 分钟的盘面回答不了「我现在该不该进」,延迟档拿到它没有意义。

const CID_RE = /^0x[0-9a-fA-F]{64}$/;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ conditionId: string }> },
) {
  const { conditionId } = await params;
  if (!CID_RE.test(conditionId)) {
    return Response.json({ error: "invalid conditionId" }, { status: 400 });
  }
  const db = openDb(process.env.DASH_DB ?? "data.sqlite");
  try {
    const access = checkFeedAccess(req, db);
    if (!access.ok) {
      return Response.json({ error: access.error }, { status: access.status });
    }
    if (!busTypeAllowed(access.busTypes, "market")) {
      return Response.json(
        { error: "scope 'market' not granted for this key" },
        { status: 403 },
      );
    }
    if (access.tier !== "realtime") {
      return Response.json(
        { error: "market cards require the realtime tier" },
        { status: 403 },
      );
    }
    const nowSec = Math.floor(Date.now() / 1000);
    // 预算从属引擎健康度:引擎断更时继续取令牌是在加深故障 —— 断更的原因
    // 很可能正是 data-api 被挤爆。
    const health = evaluateHealth(
      getHeartbeats(db),
      nowSec,
      getEngineStart(db),
    );
    const limit = budgetFor(health);
    const out = await serveMarketCard(db, conditionId, {
      nowSec,
      takeToken: () => takeCardToken(limit),
    });
    if (!out.ok) {
      // 429 是背压不是错误:订阅方按 Retry-After 退避即可,这一点必须在文档里
      // 讲明白,否则会被当成故障上报。
      return Response.json(
        {
          error: "upstream budget exhausted — retry shortly",
          healthy: health.ok,
        },
        {
          status: out.status,
          headers: { "retry-after": String(out.retryAfterSec) },
        },
      );
    }
    return Response.json({
      card: out.card,
      builtAt: out.builtAt,
      staleSec: out.staleSec,
      live: out.live,
      // 健康位按真实 now 评估,与 /api/signals 同义:数据可以旧,但「引擎死没死」
      // 这个事实对所有订阅方一致。
      healthy: health.ok,
      notice: SIGNAL_DISCLAIMER,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/signals/market] failed:", message);
    return Response.json({ error: message }, { status: 500 });
  } finally {
    db.close();
  }
}
