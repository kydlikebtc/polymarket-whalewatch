import { z } from "zod";
import { checkWriteAccess, guardExpensive } from "../../../../lib/apiGuard";
import { openDb } from "../../../../lib/db";
import { registerWebhook } from "../../../../lib/webhookDelivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 对外信号批次 3:webhook 端点管理。端点由运营者登记(ADMIN_TOKEN),不是
// 订户自助 —— SSRF/滥用面收窄到信任边界内。挂在 realtime tier 的 api_key 上,
// key 吊销即端点整体失效(listActiveWebhooks 的 join 保证)。

const RegisterBody = z.object({
  apiKeyId: z.number().int().positive(),
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://") || u.startsWith("http://"), {
      message: "仅支持 http(s) URL",
    }),
  // HMAC 密钥:太短的 secret 让签名防线形同虚设。
  secret: z.string().min(16).max(128),
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
  const limited = guardExpensive(req, "admin-webhooks", LIMITS, {});
  if (limited) return limited;
  let body: z.infer<typeof RegisterBody>;
  try {
    body = RegisterBody.parse(await req.json());
  } catch (e) {
    return Response.json(
      { error: `请求体不合法:${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    );
  }
  const db = openDash();
  try {
    const key = db
      .prepare("SELECT id, tier, revoked_at FROM api_keys WHERE id = ?")
      .get(body.apiKeyId) as
      { id: number; tier: string; revoked_at: number | null } | undefined;
    if (!key || key.revoked_at != null) {
      return Response.json(
        { error: "apiKeyId 不存在或已吊销" },
        { status: 400 },
      );
    }
    if (key.tier !== "realtime") {
      return Response.json(
        { error: "webhook 只服务 realtime tier 的 key(延迟数据请用拉取 API)" },
        { status: 400 },
      );
    }
    const id = registerWebhook(db, body);
    return Response.json({ id, url: body.url });
  } finally {
    db.close();
  }
}

export async function GET(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const limited = guardExpensive(req, "admin-webhooks", LIMITS, {
    webhooks: [],
  });
  if (limited) return limited;
  const db = openDash();
  try {
    const rows = db
      .prepare(
        `SELECT w.id, w.api_key_id, w.url, w.active, w.consecutive_failures,
                w.last_error, w.created_at, k.label AS key_label, k.tier AS key_tier,
                k.revoked_at AS key_revoked_at
         FROM webhook_endpoints w JOIN api_keys k ON k.id = w.api_key_id
         ORDER BY w.id`,
      )
      .all();
    // secret 不回显 —— 与 api key 明文同一纪律。
    return Response.json({ webhooks: rows });
  } finally {
    db.close();
  }
}

export async function DELETE(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const limited = guardExpensive(req, "admin-webhooks", LIMITS, {});
  if (limited) return limited;
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "缺少合法的 ?id=" }, { status: 400 });
  }
  const db = openDash();
  try {
    // 软停用(active=0):投递史/熔断史保留可审计,重新启用 = 再 POST 一条。
    const res = db
      .prepare("UPDATE webhook_endpoints SET active = 0 WHERE id = ?")
      .run(id);
    return Response.json({ id, disabled: res.changes === 1 });
  } finally {
    db.close();
  }
}
