import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { issueApiKey, revokeApiKey } from "./apiKeys";
import { checkFeedAccess, checkXQueueAccess } from "./feedAuth";

// 对外信号批次 2:/api/signals 鉴权升级 —— env 单 token(兼容 mm-mobile,
// 等价 realtime)∪ api_keys 多租户(tier 分层)。fail-closed 语义保持:
// 公开部署下两边都没配置 = feed 关闭(403)。

const reqWith = (headers: Record<string, string> = {}): Request =>
  new Request("http://localhost/api/signals", { headers });

const PROD = { NODE_ENV: "production" } as Record<string, string>;

describe("checkFeedAccess", () => {
  it("本地开发(非公开部署)直接放行,tier=realtime", () => {
    const db = openDb(":memory:");
    const r = checkFeedAccess(reqWith(), db, { NODE_ENV: "development" });
    expect(r).toEqual({ ok: true, tier: "realtime" });
    db.close();
  });

  it("env token 命中 → realtime(mm-mobile 兼容路径,行为与 v1 一致)", () => {
    const db = openDb(":memory:");
    const env = { ...PROD, SIGNAL_FEED_TOKEN: "tok-abc" };
    const viaHeader = checkFeedAccess(
      reqWith({ "x-feed-token": "tok-abc" }),
      db,
      env,
    );
    expect(viaHeader.ok && viaHeader.tier).toBe("realtime");
    const viaBearer = checkFeedAccess(
      reqWith({ authorization: "Bearer tok-abc" }),
      db,
      env,
    );
    expect(viaBearer.ok && viaBearer.tier).toBe("realtime");
    db.close();
  });

  it("api_keys 命中 → 按 key 的 tier;吊销后回 401(还有别的活跃凭证时)", () => {
    const db = openDb(":memory:");
    const issued = issueApiKey(db, { label: "订户", tier: "delayed" }, 1000);
    // 第二把活跃 key:生产常态(mm-mobile env token 或其他订户)。吊销一个
    // 订户不应让整个 feed 显示「未开放」。
    issueApiKey(db, { label: "另一订户", tier: "realtime" }, 1000);
    const ok = checkFeedAccess(
      reqWith({ "x-feed-token": issued.key }),
      db,
      PROD,
    );
    expect(ok.ok && ok.tier).toBe("delayed");
    expect(ok.ok && ok.keyId).toBe(issued.id);
    revokeApiKey(db, issued.id, 2000);
    const after = checkFeedAccess(
      reqWith({ "x-feed-token": issued.key }),
      db,
      PROD,
    );
    expect(after.ok).toBe(false);
    expect(!after.ok && after.status).toBe(401);
    db.close();
  });

  it("最后一把 key 吊销后回到 fail-closed 403(feed 等价于未配置)", () => {
    const db = openDb(":memory:");
    const only = issueApiKey(db, { label: "唯一", tier: "delayed" }, 1000);
    revokeApiKey(db, only.id, 2000);
    const r = checkFeedAccess(reqWith({ "x-feed-token": only.key }), db, PROD);
    expect(!r.ok && r.status).toBe(403);
    db.close();
  });

  it("fail-closed:公开部署 + 无 env token + 无活跃 key → 403;有任一配置但 token 错 → 401", () => {
    const db = openDb(":memory:");
    const closed = checkFeedAccess(reqWith({ "x-feed-token": "x" }), db, PROD);
    expect(!closed.ok && closed.status).toBe(403);
    issueApiKey(db, { label: "a", tier: "delayed" }, 1000);
    const wrong = checkFeedAccess(reqWith({ "x-feed-token": "x" }), db, PROD);
    expect(!wrong.ok && wrong.status).toBe(401);
    const noToken = checkFeedAccess(reqWith(), db, PROD);
    expect(!noToken.ok && noToken.status).toBe(401);
    db.close();
  });
});

describe("checkXQueueAccess", () => {
  const PROD = { NODE_ENV: "production" } as Record<string, string | undefined>;
  const withToken = (t: string): Request =>
    new Request("http://localhost/api/x-queue", {
      headers: { "x-feed-token": t },
    });

  it("有能力位的 key 放行,并带回 keyId(路由据此打心跳)", () => {
    const db = openDb(":memory:");
    const k = issueApiKey(db, {
      label: "ext",
      tier: "realtime",
      canXQueue: true,
    });
    const r = checkXQueueAccess(withToken(k.key), db, PROD);
    expect(r.ok).toBe(true);
    expect(r.ok && r.keyId).toBeGreaterThan(0);
  });

  it("没有能力位 → 403(而不是 401):key 有效,只是权限不够", () => {
    const db = openDb(":memory:");
    const k = issueApiKey(db, { label: "reader", tier: "realtime" });
    expect(checkXQueueAccess(withToken(k.key), db, PROD)).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("无效/缺失 key → 401", () => {
    const db = openDb(":memory:");
    expect(checkXQueueAccess(withToken("garbage"), db, PROD)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(
      checkXQueueAccess(new Request("http://localhost/api/x-queue"), db, PROD),
    ).toMatchObject({ ok: false, status: 401 });
  });

  it("吊销后立刻 401 —— 插件下次拉取就会自清配置", () => {
    const db = openDb(":memory:");
    const k = issueApiKey(db, {
      label: "ext",
      tier: "realtime",
      canXQueue: true,
    });
    revokeApiKey(db, 1);
    expect(checkXQueueAccess(withToken(k.key), db, PROD)).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("**不接受 ADMIN_TOKEN** —— 那是全站可写权限,不该躺在浏览器扩展里", () => {
    const db = openDb(":memory:");
    const env = { NODE_ENV: "production", ADMIN_TOKEN: "super-secret" };
    const req = new Request("http://localhost/api/x-queue", {
      headers: { "x-admin-token": "super-secret" },
    });
    expect(checkXQueueAccess(req, db, env)).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("本地开发放行(与 checkFeedAccess 同一条无摩擦纪律)", () => {
    expect(
      checkXQueueAccess(withToken(""), openDb(":memory:"), {
        NODE_ENV: "development",
      }),
    ).toMatchObject({ ok: true });
  });
});
