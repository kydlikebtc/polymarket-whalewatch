import { parseConfig } from "../../../lib/config";
import { openDb } from "../../../lib/db";
import { consumePending, upsertAccount } from "../../../lib/xAccounts";
import { completeAuth } from "../../../lib/xOauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 𝕏 3-legged OAuth 的第三条腿:运营者在 X 点完「同意」后,浏览器被跳到
// 这里,带着 oauth_token + oauth_verifier。
//
// **本路由刻意不要求 ADMIN_TOKEN** —— X 直接跳转浏览器,带不上自定义头。
// 防重放靠三点(见 lib/xAccounts.consumePending):
//   1. oauth_token 必须是我们刚生成并存进 x_oauth_pending 的值(伪造的
//      回调查无此行,直接失败);
//   2. 取出即删除,同一个回调重放第二次必然失败;
//   3. 15 分钟 TTL。
// 成功/失败都 302 回 /manage 带上结果参数,运营者在页面上看到反馈。

function redirect(publicUrl: string, params: Record<string, string>): Response {
  const q = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 302,
    headers: { Location: `${publicUrl}/manage?${q}` },
  });
}

export async function GET(req: Request) {
  const cfg = parseConfig(process.env);
  const url = new URL(req.url);
  const oauthToken = url.searchParams.get("oauth_token");
  const verifier = url.searchParams.get("oauth_verifier");
  // 运营者在授权页点了「取消」:X 带 denied 回来,不是错误,静默返回。
  if (url.searchParams.get("denied")) {
    return redirect(cfg.publicUrl, { x_auth: "denied" });
  }
  if (!oauthToken || !verifier) {
    return redirect(cfg.publicUrl, { x_auth: "bad_request" });
  }
  const db = openDb(process.env.DASH_DB ?? "data.sqlite");
  try {
    const secret = consumePending(
      db,
      oauthToken,
      Math.floor(Date.now() / 1000),
    );
    if (!secret) {
      // 未知/已用过/过期 —— 三种都归一为「请重新发起授权」。
      return redirect(cfg.publicUrl, { x_auth: "expired" });
    }
    const acc = await completeAuth(
      { apiKey: cfg.xApiKey, apiSecret: cfg.xApiSecret },
      oauthToken,
      secret,
      verifier,
    );
    upsertAccount(db, {
      userId: acc.userId,
      screenName: acc.screenName,
      accessToken: acc.accessToken,
      accessSecret: acc.accessSecret,
      nowSec: Math.floor(Date.now() / 1000),
    });
    console.log(`[x-oauth] 账号授权成功:@${acc.screenName} (${acc.userId})`);
    return redirect(cfg.publicUrl, { x_auth: "ok", handle: acc.screenName });
  } catch (e) {
    console.error("[x-oauth] 换取 access token 失败:", e);
    return redirect(cfg.publicUrl, { x_auth: "failed" });
  } finally {
    db.close();
  }
}
