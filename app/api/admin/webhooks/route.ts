import { z } from "zod";
import { checkWriteAccess, guardExpensive } from "../../../../lib/apiGuard";
import { busTypeAllowed, parseBusTypes } from "../../../../lib/apiKeys";
import { openDb } from "../../../../lib/db";
import {
  deleteWebhook,
  postTestEvent,
  registerWebhook,
  setWebhookActive,
} from "../../../../lib/webhookDelivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 对外信号批次 3:webhook 端点管理。端点由运营者登记(ADMIN_TOKEN),不是
// 订户自助 —— SSRF/滥用面收窄到信任边界内。挂在 realtime tier 的 api_key 上,
// key 吊销即端点整体失效(listActiveWebhooks 的 join 保证)。
//
// POST 一个入口承接五个动作。action 是**可选**的:不传即 register ——
// docs/signals-api.md 已发布的登记契约照旧,运营者手边的 curl 脚本不用改。

const RegisterBody = z.object({
  action: z.literal("register").optional(),
  apiKeyId: z.number().int().positive(),
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://") || u.startsWith("http://"), {
      message: "仅支持 http(s) URL",
    }),
  // HMAC 密钥:太短的 secret 让签名防线形同虚设。
  secret: z.string().min(16).max(128),
  // 端点推送类型(2026-08-19)。刻意用枚举而非自由字符串(keys 路由是后者):
  // 打错的类型名不会报错,只会让该端点永远收不到那类事件 —— 对运营者配置,
  // 当场拒绝比静默空转仁慈。省略 = 仅策略信号(历史默认)。
  busTypes: z
    .array(z.enum(["strategy", "large", "consensus", "discovery"]))
    .nonempty()
    .optional(),
});

// 端点运维:测试(只读探针)/ 停用↔恢复 / 硬删。
const ActionBody = z.object({
  action: z.enum(["test", "enable", "disable", "delete"]),
  id: z.number().int().positive(),
});

const LIMITS = { perIp: 30, global: 60 };

function openDash() {
  return openDb(process.env.DASH_DB ?? "data.sqlite");
}

interface EndpointRow {
  id: number;
  url: string;
  secret: string;
  active: number;
  key_label: string;
  key_tier: string;
  key_revoked_at: number | null;
}

/** 端点运维动作。一律先确认端点存在(404),再执行。 */
async function handleAction(
  cmd: z.infer<typeof ActionBody>,
): Promise<Response> {
  const db = openDash();
  try {
    const ep = db
      .prepare(
        `SELECT w.id, w.url, w.secret, w.active, k.label AS key_label,
                k.tier AS key_tier, k.revoked_at AS key_revoked_at
         FROM webhook_endpoints w JOIN api_keys k ON k.id = w.api_key_id
         WHERE w.id = ?`,
      )
      .get(cmd.id) as EndpointRow | undefined;
    if (!ep) {
      return Response.json(
        { error: `端点 #${cmd.id} 不存在` },
        { status: 404 },
      );
    }

    if (cmd.action === "test") {
      // secret 从库里取,不经前端往返(与 tg-targets 的 bot_token 同一纪律)。
      const result = await postTestEvent({ url: ep.url, secret: ep.secret });
      console.log(
        `[admin/webhooks] test #${ep.id} ${ep.url} → ok=${result.ok} status=${result.status ?? "-"} ${result.ms}ms`,
      );
      // HTTP 仍是 200 —— 探测本身成功了(哪怕探到的是个坏端点),ok 才是结论。
      return Response.json(result);
    }

    if (cmd.action === "enable") {
      // 这两道拒绝必须在这里,不能只靠前端置灰:恢复一个投递查询根本不会
      // 选中的端点,只会在后台留下「活跃」的假象,比停用更难排查。
      if (ep.key_revoked_at != null) {
        return Response.json(
          {
            error: `端点挂在已吊销的 key(${ep.key_label})上,恢复了也不会投递 —— 投递查询会过滤掉它。请先为该订户签发新的 realtime key 并重新登记端点。`,
          },
          { status: 400 },
        );
      }
      if (ep.key_tier !== "realtime") {
        return Response.json(
          {
            error: `端点挂的 key 是 ${ep.key_tier} tier,webhook 只服务 realtime tier(延迟数据请用拉取 API)`,
          },
          { status: 400 },
        );
      }
      setWebhookActive(db, ep.id, true);
      console.log(
        `[admin/webhooks] enable #${ep.id} ${ep.url}(连败计数与 last_error 已清零)`,
      );
      return Response.json({ ok: true });
    }

    if (cmd.action === "disable") {
      setWebhookActive(db, ep.id, false);
      console.log(`[admin/webhooks] disable #${ep.id} ${ep.url}`);
      return Response.json({ ok: true });
    }

    deleteWebhook(db, ep.id);
    console.log(`[admin/webhooks] delete #${ep.id} ${ep.url}(secret 一并销毁)`);
    return Response.json({ ok: true });
  } finally {
    db.close();
  }
}

export async function POST(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const limited = guardExpensive(req, "admin-webhooks", LIMITS, {});
  if (limited) return limited;

  // 先按 action 分流再校验(而不是 z.union):union 失败时的报错会把两条分支的
  // issue 糊在一起,运营者看不懂自己到底哪个字段写错了。
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const action =
    typeof (raw as { action?: unknown })?.action === "string"
      ? (raw as { action: string }).action
      : "register";

  if (action !== "register") {
    let cmd: z.infer<typeof ActionBody>;
    try {
      cmd = ActionBody.parse(raw);
    } catch (e) {
      return Response.json(
        { error: `请求体不合法:${e instanceof Error ? e.message : String(e)}` },
        { status: 400 },
      );
    }
    return handleAction(cmd);
  }

  let body: z.infer<typeof RegisterBody>;
  try {
    body = RegisterBody.parse(raw);
  } catch (e) {
    return Response.json(
      { error: `请求体不合法:${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    );
  }
  const db = openDash();
  try {
    const key = db
      .prepare(
        "SELECT id, tier, revoked_at, bus_types FROM api_keys WHERE id = ?",
      )
      .get(body.apiKeyId) as
      | {
          id: number;
          tier: string;
          revoked_at: number | null;
          bus_types: string | null;
        }
      | undefined;
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
    // 勾选必须落在 key 的授权范围内。放进去也不会投(运行时按交集兜底),
    // 但「登记成功、永远不投」是最难排查的配置错误 —— 当场拒绝。
    const keyScope = parseBusTypes(key.bus_types);
    const outOfScope = (body.busTypes ?? []).filter(
      (t) => !busTypeAllowed(keyScope, t),
    );
    if (outOfScope.length > 0) {
      return Response.json(
        {
          error: `key #${key.id} 的订阅范围不含:${outOfScope.join("、")} —— 先重新签发范围更大的 key,或去掉这些勾选`,
        },
        { status: 400 },
      );
    }
    const id = registerWebhook(db, body);
    return Response.json({
      id,
      url: body.url,
      busTypes: body.busTypes ?? null,
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
  const limited = guardExpensive(req, "admin-webhooks", LIMITS, {
    webhooks: [],
  });
  if (limited) return limited;
  const db = openDash();
  try {
    const rows = db
      .prepare(
        `SELECT w.id, w.api_key_id, w.url, w.active, w.consecutive_failures,
                w.last_error, w.created_at, w.bus_types, k.label AS key_label, k.tier AS key_tier,
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
