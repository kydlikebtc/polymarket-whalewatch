import { z } from "zod";
import { checkWriteAccess, guardExpensive } from "../../../../lib/apiGuard";
import { parseConfig } from "../../../../lib/config";
import { openDb } from "../../../../lib/db";
import {
  activateAccount,
  deleteAccount,
  listAccounts,
  savePending,
} from "../../../../lib/xAccounts";
import { startAuth } from "../../../../lib/xOauth";
import {
  DEFAULT_X_KINDS,
  getXKindSwitches,
  getXPostHistory,
  setXKindSwitches,
  type XKindSwitches,
  type XPostKind,
} from "../../../../lib/xSettings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 𝕏 播报账号管理(/manage 的「𝕏 播报账号」区)。
// 全部动作走 ADMIN_TOKEN(x-admin-token),与 keys/webhooks 同一套运营者
// 写凭证。注意:OAuth 回调 GET /api/x-callback 不能要求令牌(X 直接跳
// 浏览器过来,带不上自定义头),它的防重放靠 pending 一次性消费。
// access token 属于账号故进库;consumer key/secret 属于 App,只从 .env 读。

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("activate"), id: z.number().int().positive() }),
  z.object({ action: z.literal("delete"), id: z.number().int().positive() }),
  z.object({
    action: z.literal("kinds"),
    // 逐键可选:UI 只提交被改动的那个开关,不必回传整份配置。
    kinds: z.object({
      whale: z.boolean().optional(),
      consensus: z.boolean().optional(),
      pregame: z.boolean().optional(),
      weekly: z.boolean().optional(),
    }),
  }),
]);

const LIMITS = { perIp: 30, global: 60 };

function openDash() {
  return openDb(process.env.DASH_DB ?? "data.sqlite");
}

export async function GET(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const db = openDash();
  try {
    const cfg = parseConfig(process.env);
    const history = getXPostHistory(db, Math.floor(Date.now() / 1000));
    return Response.json({
      accounts: listAccounts(db),
      kinds: getXKindSwitches(db),
      history,
      budgetUsd: cfg.xMonthlyBudgetUsd,
      // App 未配置时前端直接提示去 .env 补,而不是让人点了授权才报错。
      appConfigured: cfg.xAppConfigured,
      // env 单账号回退是否在用(库里没有账号时才生效)。
      envFallback: !!(cfg.xAccessToken && cfg.xAccessSecret),
      callbackUrl: `${cfg.publicUrl}/api/x-callback`,
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
  const limited = guardExpensive(req, "admin-x-accounts", LIMITS, {});
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
  const cfg = parseConfig(process.env);
  const db = openDash();
  try {
    if (body.action === "start") {
      if (!cfg.xAppConfigured) {
        return Response.json(
          {
            error:
              "未配置 X App 凭据:请先在服务器 .env 设置 X_API_KEY / X_API_SECRET 并重启",
          },
          { status: 400 },
        );
      }
      // 回调地址必须与 X App 后台登记的 Callback URI 完全一致。
      const callbackUrl = `${cfg.publicUrl}/api/x-callback`;
      try {
        const link = await startAuth(
          { apiKey: cfg.xApiKey, apiSecret: cfg.xApiSecret },
          callbackUrl,
        );
        savePending(
          db,
          link.oauthToken,
          link.oauthTokenSecret,
          Math.floor(Date.now() / 1000),
        );
        return Response.json({ url: link.url, callbackUrl });
      } catch (e) {
        // 最常见的失败:callback 未登记在 App 后台(X 报 403)。
        return Response.json(
          {
            error: `向 X 请求授权链接失败:${e instanceof Error ? e.message : String(e)}(请确认 App 后台的 Callback URI 已登记 ${callbackUrl})`,
          },
          { status: 502 },
        );
      }
    }
    if (body.action === "kinds") {
      const next: XKindSwitches = { ...getXKindSwitches(db) };
      for (const k of Object.keys(DEFAULT_X_KINDS) as XPostKind[]) {
        const v = body.kinds[k];
        if (typeof v === "boolean") next[k] = v;
      }
      setXKindSwitches(db, next);
      return Response.json({ ok: true, kinds: next });
    }
    if (body.action === "activate") {
      return activateAccount(db, body.id)
        ? Response.json({ ok: true })
        : Response.json({ error: "账号不存在" }, { status: 404 });
    }
    return deleteAccount(db, body.id)
      ? Response.json({ ok: true })
      : Response.json({ error: "账号不存在" }, { status: 404 });
  } finally {
    db.close();
  }
}
