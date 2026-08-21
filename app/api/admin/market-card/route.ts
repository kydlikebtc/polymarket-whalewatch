import { z } from "zod";
import { checkWriteAccess, guardExpensive } from "../../../../lib/apiGuard";
import { openDb } from "../../../../lib/db";
import {
  DEFAULT_CARD_SETTINGS,
  getCardSettings,
  setCardSettings,
} from "../../../../lib/cardSettings";
import { windowStats } from "../../../../lib/marketWindow";
import { getEngineStart, getHeartbeats } from "../../../../lib/heartbeat";
import { evaluateHealth } from "../../../../lib/health";
import { budgetFor } from "../../../../lib/cardBudget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /manage 的「市场深度卡」区块数据接口。全部动作走 ADMIN_TOKEN,与其它 admin
// 路由同一姿态。
//
// **计数是进程内的**:它回答「这个进程活着这段时间里,预算花在哪了」,不是历史
// 统计,重启归零。这点必须在 UI 上写明,否则运维会拿它当日报看。
//
// 同样重要的是 effectiveBudget:配置里的 budgetPerMin 是上限,而此刻真正允许的
// 额度由引擎健康度决定(循环漂移降到 25%、停跳归零)。只显示配置值会让运维在
// 引擎喘不过气时看不懂「为什么 refused 在涨」。

const SettingsBody = z.object({
  budgetPerMin: z.number().int().min(0),
  windowTtlSec: z.number().int().min(1),
  staleGateSec: z.number().int().min(1),
  lruMax: z.number().int().min(1),
});

const LIMITS = { perIp: 60, global: 120 };

function openDash() {
  return openDb(process.env.DASH_DB ?? "data.sqlite");
}

export async function GET(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const limited = guardExpensive(req, "admin-market-card", LIMITS, {});
  if (limited) return limited;
  const db = openDash();
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const health = evaluateHealth(
      getHeartbeats(db),
      nowSec,
      getEngineStart(db),
    );
    const settings = getCardSettings(db);
    const archived = (
      db.prepare("SELECT COUNT(*) AS n FROM market_window_cache").get() as {
        n: number;
      }
    ).n;
    return Response.json({
      settings,
      defaults: DEFAULT_CARD_SETTINGS,
      stats: windowStats(),
      /** 此刻真正允许的额度(已按引擎健康度打折);与 settings.budgetPerMin 可能不同。 */
      effectiveBudget: budgetFor(health, settings.budgetPerMin),
      healthy: health.ok,
      staleLoops: health.staleLoops,
      /** 落盘的窗口存档行数(跨重启,与进程内工作集是两回事)。 */
      archivedWindows: archived,
    });
  } finally {
    db.close();
  }
}

export async function POST(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const limited = guardExpensive(req, "admin-market-card", LIMITS, {});
  if (limited) return limited;
  let body: z.infer<typeof SettingsBody>;
  try {
    body = SettingsBody.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  const db = openDash();
  try {
    // setCardSettings 自己会夹取并修正跨字段不变式 —— 这里不重复一遍规则,
    // 回读结果告诉 UI 实际生效的是什么(可能与提交值不同,那正是要展示的)。
    setCardSettings(db, body);
    return Response.json({ settings: getCardSettings(db) });
  } finally {
    db.close();
  }
}
