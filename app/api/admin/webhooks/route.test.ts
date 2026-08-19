import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../../../../lib/db";
import {
  issueApiKey,
  revokeApiKey,
  type ApiKeyTier,
} from "../../../../lib/apiKeys";
import { registerWebhook } from "../../../../lib/webhookDelivery";

// /api/admin/webhooks 的动作分发。这条路由承载三件危险程度递增的运维动作
// (测试 / 停用↔恢复 / 硬删),外加一条**必须原样不变**的老契约:不传 action
// 就是登记端点(docs/signals-api.md 已发布,运营者的 curl 脚本照着它写)。

let dir: string;
const saved = {
  dashDb: process.env.DASH_DB,
  publicReadonly: process.env.PUBLIC_READONLY,
};

beforeAll(() => {
  // 必须是真文件:route 每次自己 openDb,`:memory:` 会让 seed 与被测代码
  // 看到两个不相干的空库。
  dir = mkdtempSync(join(tmpdir(), "wh-route-"));
  process.env.DASH_DB = join(dir, "test.sqlite");
  process.env.PUBLIC_READONLY = "false";
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env.DASH_DB = saved.dashDb;
  process.env.PUBLIC_READONLY = saved.publicReadonly;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const { POST } = await import("./route");

function seed(opts: { revoked?: boolean; tier?: ApiKeyTier } = {}) {
  const db = openDb(process.env.DASH_DB!);
  const key = issueApiKey(
    db,
    { label: "订户", tier: opts.tier ?? "realtime" },
    1000,
  );
  if (opts.revoked) revokeApiKey(db, key.id, 1500);
  const id = registerWebhook(db, {
    apiKeyId: key.id,
    url: "https://订户.test/hook",
    secret: "s".repeat(20),
  });
  db.close();
  return { keyId: key.id, id };
}

function row(id: number) {
  const db = openDb(process.env.DASH_DB!);
  const r = db
    .prepare(
      "SELECT active, consecutive_failures, last_error FROM webhook_endpoints WHERE id=?",
    )
    .get(id) as
    | {
        active: number;
        consecutive_failures: number;
        last_error: string | null;
      }
    | undefined;
  db.close();
  return r;
}

function fail(db: ReturnType<typeof openDb>, id: number, n: number) {
  db.prepare(
    "UPDATE webhook_endpoints SET consecutive_failures = ?, last_error = 'timeout', active = 0 WHERE id = ?",
  ).run(n, id);
}

async function post(body: unknown) {
  const res = await POST(
    new Request("http://localhost/api/admin/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("向后兼容", () => {
  it("不传 action 仍是「登记端点」—— 已发布的老契约不能被 action 化改掉", async () => {
    const db = openDb(process.env.DASH_DB!);
    const key = issueApiKey(db, { label: "老脚本", tier: "realtime" }, 1000);
    db.close();
    const { res, body } = await post({
      apiKeyId: key.id,
      url: "https://legacy.test/hook",
      secret: "s".repeat(20),
    });
    expect(res.status).toBe(200);
    expect(typeof body.id).toBe("number");
    expect(body.url).toBe("https://legacy.test/hook");
    expect(row(body.id as number)?.active).toBe(1);
  });
});

describe("action=test", () => {
  it("回传状态码/耗时/人话诊断,HTTP 本身仍是 200(探测成功地测出了坏端点)", async () => {
    const { id } = seed();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 })),
    );
    const { res, body } = await post({ action: "test", id });
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe(200);
    expect(typeof body.ms).toBe("number");
    expect(String(body.detail)).toContain("200");
  });

  it("是只读探针:测失败也不推高连败计数、不改 active", async () => {
    const { id } = seed();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    const { body } = await post({ action: "test", id });
    expect(body.ok).toBe(false);
    // 手点的探针不该污染自动投递的健康账本。
    expect(row(id)).toMatchObject({
      active: 1,
      consecutive_failures: 0,
      last_error: null,
    });
  });

  it("停用中的端点也能测 —— 「先测通再恢复」正是它存在的意义", async () => {
    const { id } = seed();
    const db = openDb(process.env.DASH_DB!);
    fail(db, id, 10);
    db.close();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 })),
    );
    const { body } = await post({ action: "test", id });
    expect(body.ok).toBe(true);
    expect(row(id)?.active).toBe(0); // 测通不等于自动恢复,那是另一个按钮
  });

  it("secret 从库里取,不经前端往返,也不回显", async () => {
    const { id } = seed();
    const spy = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response("", { status: 200 }),
    );
    vi.stubGlobal("fetch", spy);
    const { body } = await post({ action: "test", id });
    const init = spy.mock.calls[0][1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers["x-signal-test"]).toBe("1");
    expect(JSON.stringify(body)).not.toContain("s".repeat(20));
  });

  it("端点不存在 → 404", async () => {
    const { res, body } = await post({ action: "test", id: 999999 });
    expect(res.status).toBe(404);
    expect(body.error).toBeTruthy();
  });
});

describe("action=enable / disable", () => {
  it("恢复:active=1 且连败计数与 last_error 一并清零", async () => {
    const { id } = seed();
    const db = openDb(process.env.DASH_DB!);
    fail(db, id, 10);
    db.close();
    const { res, body } = await post({ action: "enable", id });
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(row(id)).toMatchObject({
      active: 1,
      consecutive_failures: 0,
      last_error: null,
    });
  });

  it("key 已吊销的端点拒绝恢复 —— 投递查询会过滤掉它,恢复了也发不出去", async () => {
    const { id } = seed({ revoked: true });
    const db = openDb(process.env.DASH_DB!);
    fail(db, id, 10);
    db.close();
    const { res, body } = await post({ action: "enable", id });
    expect(res.status).toBe(400);
    expect(String(body.error)).toContain("吊销");
    expect(row(id)?.active).toBe(0); // 拒绝要彻底,不能留个假活跃状态
  });

  it("非 realtime tier 的端点同样拒绝恢复", async () => {
    const { id } = seed({ tier: "delayed" });
    const db = openDb(process.env.DASH_DB!);
    fail(db, id, 3);
    db.close();
    const { res, body } = await post({ action: "enable", id });
    expect(res.status).toBe(400);
    expect(String(body.error)).toContain("realtime");
    expect(row(id)?.active).toBe(0);
  });

  it("停用:active=0,连败计数保留做投递史", async () => {
    const { id } = seed();
    const db = openDb(process.env.DASH_DB!);
    db.prepare(
      "UPDATE webhook_endpoints SET consecutive_failures = 4 WHERE id = ?",
    ).run(id);
    db.close();
    const { body } = await post({ action: "disable", id });
    expect(body.ok).toBe(true);
    expect(row(id)).toMatchObject({ active: 0, consecutive_failures: 4 });
  });
});

describe("action=delete", () => {
  it("硬删:行消失,重复删 404", async () => {
    const { id } = seed();
    const { res, body } = await post({ action: "delete", id });
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(row(id)).toBeUndefined();
    const again = await post({ action: "delete", id });
    expect(again.res.status).toBe(404);
  });
});
