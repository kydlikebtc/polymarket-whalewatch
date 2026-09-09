import { z } from "zod";
import { checkWriteAccess, guardExpensive } from "../../../../lib/apiGuard";
import { openDb, type DB } from "../../../../lib/db";
import {
  getConsensusWindowMode,
  listConsensusWindowModeHistory,
  setConsensusWindowMode,
} from "../../../../lib/engineSettings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /manage「引擎设置」区块的数据接口。全部动作走 ADMIN_TOKEN,与其它 admin
// 路由同一姿态(本地开发免令牌,checkWriteAccess 的既有行为)。
//
// 目前只有一个旋钮:consensus_window_mode —— windowKeeper 增量机制的事故
// 回滚开关。写入只收规范值('incremental'/'full',zod 枚举挡其余),经
// config_history 留痕;引擎每轮重读 config,改完下一轮(≤90s)生效。
// 读写语义共用 lib/engineSettings,漂移防线见 app/manage/engineParity.test.ts。

const Body = z.object({ mode: z.enum(["incremental", "full"]) });

const LIMITS = { perIp: 60, global: 120 };

function openDash() {
  return openDb(process.env.DASH_DB ?? "data.sqlite");
}

// GET 与 POST 回同一形状:开关写完 UI 需要的正是「现在到底是什么 + 这次
// 留痕了没有」,不必再发一次 GET。
function payload(db: DB) {
  return {
    mode: getConsensusWindowMode(db),
    history: listConsensusWindowModeHistory(db, 5),
  };
}

export async function GET(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const limited = guardExpensive(req, "admin-engine", LIMITS, {});
  if (limited) return limited;
  const db = openDash();
  try {
    return Response.json(payload(db));
  } finally {
    db.close();
  }
}

export async function POST(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const limited = guardExpensive(req, "admin-engine", LIMITS, {});
  if (limited) return limited;
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return Response.json(
      { error: `请求体不合法:${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    );
  }
  const db = openDash();
  try {
    setConsensusWindowMode(db, body.mode);
    return Response.json(payload(db));
  } finally {
    db.close();
  }
}
