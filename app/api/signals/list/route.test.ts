import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../../../../lib/db";
import { issueApiKey } from "../../../../lib/apiKeys";
import { createBusDef } from "../../../../lib/busDefs";

// 名录端点。设计见 docs/plans/2026-08-27-signal-catalog-api-design.md。
//
// 这里钉死的两件事,任何一件破了都是**订阅方看到不该看到的信号清单**:
//   1. 过滤口径与 /api/signals 一致(keyAllows,服务端执行);
//   2. 缓存键含订阅范围 —— 否则全量 key 烤热的缓存会被受限 key 命中。
const throwing = vi.hoisted(() => ({ catalog: false }));

vi.mock("../../../../lib/signalCatalog", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../lib/signalCatalog")>();
  return {
    ...actual,
    buildSignalCatalog: (
      ...args: Parameters<typeof actual.buildSignalCatalog>
    ) => {
      if (throwing.catalog) throw new Error("模拟内部异常：名录查询失败");
      return actual.buildSignalCatalog(...args);
    },
  };
});

import { GET } from "./route";
import { __resetCatalogCache } from "./route";

const saved = {
  dashDb: process.env.DASH_DB,
  publicReadonly: process.env.PUBLIC_READONLY,
  feedToken: process.env.SIGNAL_FEED_TOKEN,
};

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "catalog-route-"));
  process.env.DASH_DB = join(dir, "test.sqlite");
  // 公开部署:走真实鉴权分支,而不是本地开发的全放行。
  process.env.PUBLIC_READONLY = "true";
  delete process.env.SIGNAL_FEED_TOKEN;
});

afterAll(() => {
  process.env.DASH_DB = saved.dashDb;
  process.env.PUBLIC_READONLY = saved.publicReadonly;
  if (saved.feedToken == null) delete process.env.SIGNAL_FEED_TOKEN;
  else process.env.SIGNAL_FEED_TOKEN = saved.feedToken;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // 缓存跨用例会串味 —— 越权那条用例正是靠缓存状态才有意义,必须每次干净。
  __resetCatalogCache();
});

afterEach(() => {
  throwing.catalog = false;
  vi.restoreAllMocks();
});

const req = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/signals/list", { headers });

/** 建一个开着的定义 + 放开一档,返回可用的 key。 */
function seed(opts: { scopes?: string[] | null } = {}) {
  const db = openDb(process.env.DASH_DB!);
  try {
    db.prepare("DELETE FROM bus_defs").run();
    db.prepare("UPDATE follow_strategies SET push_enabled = 0").run();
    createBusDef(db, {
      sourceType: "large",
      label: "大额 ≥$50k",
      threshold: 50_000,
    });
    createBusDef(db, {
      sourceType: "consensus",
      label: "共识 ≥2 人",
      threshold: 2,
    });
    db.prepare(
      "UPDATE follow_strategies SET push_enabled = 1 WHERE name = '超级巨鲸'",
    ).run();
    return issueApiKey(db, {
      label: "测试订户",
      tier: "delayed",
      busTypes: opts.scopes ?? null,
    });
  } finally {
    db.close();
  }
}

describe("GET /api/signals/list", () => {
  it("无 key:与 /api/signals 同语义 —— 有活跃 key 时 401", async () => {
    seed();
    const res = await GET(req());
    expect(res.status).toBe(401);
    // 401/403 的响应体是 {error},没有名录结构 —— 订阅方可以拿它当
    // 「我的 key 还活着吗」的探针,不必为了探活去拉一整份 feed。
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect(body.signals).toBeUndefined();
  });

  it("有效 key:两段名录 + tier", async () => {
    const key = seed();
    const res = await GET(req({ "x-feed-token": key.key }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tier: string;
      updatedAt: number;
      signals: {
        bus: { type: string; threshold: number }[];
        strategy: { code: string | null; source: string }[];
      };
    };
    expect(body.tier).toBe("delayed");
    expect(body.updatedAt).toBeGreaterThan(0);
    expect(body.signals.bus).toEqual([
      { type: "consensus", threshold: 2 },
      { type: "large", threshold: 50_000 },
    ]);
    expect(body.signals.strategy).toEqual([
      { code: "mega_whale", source: "heavy" },
    ]);
  });

  it("全 ASCII:中文档名/label 不出现在响应里", async () => {
    const key = seed();
    const res = await GET(req({ "x-feed-token": key.key }));
    const text = await res.text();
    expect(text).not.toContain("巨鲸");
    expect(text).not.toContain("大额");
    // 非 ASCII 字符一个都不该有(响应里全是英文字段名与 code)。
    expect(/[^\x00-\x7F]/.test(text)).toBe(false);
  });

  it("Bearer 写法等价", async () => {
    const key = seed();
    const res = await GET(req({ authorization: `Bearer ${key.key}` }));
    expect(res.status).toBe(200);
  });

  it("受限 key 只看到自己范围内的类型", async () => {
    const key = seed({ scopes: ["large"] });
    const res = await GET(req({ "x-feed-token": key.key }));
    const body = (await res.json()) as {
      signals: { bus: { type: string }[]; strategy: unknown[] };
    };
    expect(body.signals.bus.map((b) => b.type)).toEqual(["large"]);
    expect(body.signals.strategy).toEqual([]);
  });

  it("越权隔离:全量 key 先烤热缓存,受限 key 不得命中它", async () => {
    // 同一 tier、不同范围。缓存键漏了范围,这里就会把 consensus 与
    // strategy 泄给一把只订了 large 的 key —— 那是越权,不是多给数据。
    const db = openDb(process.env.DASH_DB!);
    let full: { key: string };
    let limited: { key: string };
    try {
      db.prepare("DELETE FROM bus_defs").run();
      db.prepare("UPDATE follow_strategies SET push_enabled = 0").run();
      createBusDef(db, { sourceType: "large", label: "L", threshold: 1 });
      createBusDef(db, { sourceType: "consensus", label: "C", threshold: 2 });
      db.prepare(
        "UPDATE follow_strategies SET push_enabled = 1 WHERE name = '超级巨鲸'",
      ).run();
      full = issueApiKey(db, {
        label: "全量",
        tier: "delayed",
        busTypes: null,
      });
      limited = issueApiKey(db, {
        label: "只订 large",
        tier: "delayed",
        busTypes: ["large"],
      });
    } finally {
      db.close();
    }

    const hot = (await (
      await GET(req({ "x-feed-token": full.key }))
    ).json()) as { signals: { bus: { type: string }[]; strategy: unknown[] } };
    expect(hot.signals.bus).toHaveLength(2);
    expect(hot.signals.strategy).toHaveLength(1);

    const cold = (await (
      await GET(req({ "x-feed-token": limited.key }))
    ).json()) as { signals: { bus: { type: string }[]; strategy: unknown[] } };
    expect(cold.signals.bus.map((b) => b.type)).toEqual(["large"]);
    expect(cold.signals.strategy).toEqual([]);
  });

  it("内部异常返 503,绝不返回一份「什么都收不到」的合法名录", async () => {
    const key = seed();
    throwing.catalog = true;
    const res = await GET(req({ "x-feed-token": key.key }));
    // 这里刻意与 /api/signals 的 §11 相反。在 feed 上,空数组的谎言是
    // 「今天没信号」;在名录上,空名录的谎言是「你的 key 被削了范围」——
    // 订阅方会照着它去找运营者理论,或者干脆停掉集成。
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect(body.signals).toBeUndefined();
  });
});
