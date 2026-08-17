import { openDb } from "../../../lib/db";
import { buildSignalFeed } from "../../../lib/signalFeed";
import { buildStrategyFeed } from "../../../lib/strategyFeed";
import { checkFeedAccess } from "../../../lib/feedAuth";
import { getEngineStart, getHeartbeats } from "../../../lib/heartbeat";
import { evaluateHealth } from "../../../lib/health";
import { createPromiseCache } from "../../../lib/promiseCache";
import { parseConfig } from "../../../lib/config";
import { getBusSignals } from "../../../lib/signalBus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Machine-facing feed for the mobile 信号 tab. The intended topology is
// deliberately NOT app→here:
//
//   whalewatch  ──1 poll/min──▶  app backend (cache + JWT)  ──▶  app clients
//
// This process is a single-machine Next + SQLite research service with an
// in-process rate-limit map; it cannot be the origin for app traffic, and it
// does not need to be. One consumer polling once a minute is a load it already
// carries — which is why integrating the tab requires no architecture change
// here. If someone points app clients straight at this route, that decision,
// not this code, is the outage.
//
// Every field is served from persisted state — zero upstream calls — so a
// burst can never reach into the data-api budget the engine loop depends on.
//
// v2(对外信号批次 2):
//   - 鉴权升级为 env SIGNAL_FEED_TOKEN(恒 realtime,mm-mobile 零感知)∪
//     api_keys 多租户(lib/feedAuth.ts)。
//   - 新增 strategies 段(策略中心 13 档的买入触发/认账/各档 30d 战绩)。
//   - tier='delayed' 的 key 拿到「delaySec 前的世界」:整个 feed 以
//     nowSec - delaySec 构建(时移语义,字段不阉割),响应带 delayedMin。
//     健康位仍按真实 now 评估 —— 延迟订户同样必须知道引擎死没死。
//   - 既有 v1 字段只增不改。
const CACHE_TTL_MS = 30_000;
const feedCache = createPromiseCache<unknown>(CACHE_TTL_MS);

// 模块级解析一次:延迟分钟数来自部署环境,进程生命周期内不变。
const SIGNAL_PUBLIC_DELAY_MIN = parseConfig(process.env).signalPublicDelayMin;

const ALLOWED_WINDOW_HOURS = new Set([6, 12, 24, 48]);

function clampWindow(raw: string | null): number {
  const n = Number(raw);
  return ALLOWED_WINDOW_HOURS.has(n) ? n : 24;
}

export async function GET(req: Request) {
  const dbPath = process.env.DASH_DB ?? "data.sqlite";
  // 鉴权用短连接(verifyApiKey 会写 last_used_at):routes 每请求开连接是
  // 本仓惯例,SQLite 打开成本亚毫秒级。
  const authDb = openDb(dbPath);
  let access: ReturnType<typeof checkFeedAccess>;
  try {
    access = checkFeedAccess(req, authDb);
  } finally {
    authDb.close();
  }
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const delaySec = access.tier === "delayed" ? SIGNAL_PUBLIC_DELAY_MIN * 60 : 0;
  const windowHours = clampWindow(
    new URL(req.url).searchParams.get("windowHours"),
  );
  try {
    const body = await feedCache(
      `feed:${windowHours}:${access.tier}`,
      async () => {
        const db = openDb(dbPath);
        try {
          const realNow = Math.floor(Date.now() / 1000);
          const nowSec = realNow - delaySec;
          // 健康按真实 now 评估:延迟视图延迟的是数据,不是「引擎死了」这个
          // 事实 —— healthy:false 的冻结义务对所有 tier 一致。
          const health = evaluateHealth(
            getHeartbeats(db),
            realNow,
            getEngineStart(db),
          );
          return {
            ...buildSignalFeed(db, { nowSec, windowHours }),
            strategies: buildStrategyFeed(db, { nowSec }),
            // 统一信号总线(大单/共识/发现…):既有字段只增不改,订阅方按
            // sourceType 自行过滤。延迟层同样按时移后的 nowSec 取。
            bus: getBusSignals(db, { nowSec, windowSec: windowHours * 3600 }),
            delayedMin: delaySec / 60,
            healthy: health.ok,
            staleLoops: health.staleLoops,
          };
        } finally {
          db.close();
        }
      },
    );
    return Response.json(body);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/signals] failed:", message);
    // Degrade to a well-formed empty feed marked unhealthy: a consumer that
    // parses this must never mistake a failure for "no signals today".
    return Response.json(
      {
        updatedAt: Math.floor(Date.now() / 1000),
        windowHours,
        active: [],
        settled: [],
        record30d: { settled: 0, wins: 0, implied: 0, excess: 0, sd: 0 },
        strategies: { active: [], settled: [], recordByStrategy: {} },
        bus: [],
        delayedMin: delaySec / 60,
        healthy: false,
        error: message,
      },
      { status: 200 },
    );
  }
}
