import { z } from "zod";
import {
  buildAdminSignalOverview,
  setStrategyPush,
} from "../../../../lib/adminOverview";
import { checkWriteAccess, guardExpensive } from "../../../../lib/apiGuard";
import { openDb } from "../../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /manage 运营页的数据接口。GET 也走 ADMIN_TOKEN —— 这是运营视角的数据
// (各档投递统计/TG 故障串/未放开档的表现),不属于公开面;公开面在 /record。
// 本地开发照旧免令牌(checkWriteAccess 的既有姿态)。

const ToggleBody = z.object({
  strategyId: z.number().int().positive(),
  pushEnabled: z.boolean(),
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
  const limited = guardExpensive(req, "admin-signals", LIMITS, {});
  if (limited) return limited;
  const db = openDash();
  try {
    return Response.json(buildAdminSignalOverview(db));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/admin/signals] GET failed:", message);
    return Response.json({ error: message }, { status: 200 });
  } finally {
    db.close();
  }
}

export async function POST(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const limited = guardExpensive(req, "admin-signals", LIMITS, {});
  if (limited) return limited;
  let body: z.infer<typeof ToggleBody>;
  try {
    body = ToggleBody.parse(await req.json());
  } catch (e) {
    return Response.json(
      { error: `请求体不合法:${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    );
  }
  const db = openDash();
  try {
    const updated = setStrategyPush(db, body.strategyId, body.pushEnabled);
    if (!updated) {
      return Response.json(
        { error: `strategyId ${body.strategyId} 不存在` },
        { status: 400 },
      );
    }
    return Response.json({
      strategyId: body.strategyId,
      pushEnabled: body.pushEnabled,
    });
  } finally {
    db.close();
  }
}
