import { z } from "zod";
import { checkWriteAccess, guardExpensive } from "../../../../lib/apiGuard";
import {
  issueApiKey,
  listApiKeys,
  revokeApiKey,
} from "../../../../lib/apiKeys";
import { openDb } from "../../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 对外信号批次 2:api key 管理(签发/列表/吊销)。
// 全部动作走 ADMIN_TOKEN(x-admin-token)—— 这是运营者的写凭证,与订户的
// 只读 feed 凭证是两个世界;公开部署未配置 ADMIN_TOKEN 时 fail-closed。
// 明文 key 只出现在 POST 响应里一次,库中只有 sha256(泄库不泄 key)。

const IssueBody = z.object({
  label: z.string().min(1).max(64),
  tier: z.enum(["realtime", "delayed"]).default("delayed"),
  // 订阅范围:该 key 能拿到哪些信号类型。省略/空 = 不限(既有行为)。
  busTypes: z.array(z.string().min(1)).optional(),
  // 𝕏 发帖队列能力(写权限)。默认 false —— 与 busTypes 的「不限」相反,
  // 因为这把 key 要长期躺在浏览器扩展里,写权限只能默认拒绝。
  canXQueue: z.boolean().optional(),
});

const LIMITS = { perIp: 30, global: 60 };

function openDash() {
  return openDb(process.env.DASH_DB ?? "data.sqlite");
}

export async function POST(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const limited = guardExpensive(req, "admin-keys", LIMITS, {});
  if (limited) return limited;
  let body: z.infer<typeof IssueBody>;
  try {
    body = IssueBody.parse(await req.json());
  } catch (e) {
    return Response.json(
      { error: `请求体不合法:${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    );
  }
  const db = openDash();
  try {
    const issued = issueApiKey(db, body);
    return Response.json({
      id: issued.id,
      key: issued.key,
      label: body.label,
      tier: body.tier,
      busTypes: body.busTypes?.length ? body.busTypes : null,
      canXQueue: !!body.canXQueue,
      notice: "明文 key 只显示这一次,库中仅存哈希 — 请立即保存",
    });
  } finally {
    db.close();
  }
}

export async function GET(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const limited = guardExpensive(req, "admin-keys", LIMITS, { keys: [] });
  if (limited) return limited;
  const db = openDash();
  try {
    return Response.json({ keys: listApiKeys(db) });
  } finally {
    db.close();
  }
}

export async function DELETE(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const limited = guardExpensive(req, "admin-keys", LIMITS, {});
  if (limited) return limited;
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "缺少合法的 ?id=" }, { status: 400 });
  }
  const db = openDash();
  try {
    return Response.json({ id, revoked: revokeApiKey(db, id) });
  } finally {
    db.close();
  }
}
