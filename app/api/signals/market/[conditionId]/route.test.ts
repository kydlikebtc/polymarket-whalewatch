import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";

// 路由测试姿态照抄 app/api/signals/route.test.ts:空的内存库 + 显式钉死
// 「非公开部署」让鉴权放行 realtime,不依赖 NODE_ENV 的默认值。
//
// mock 只打在**网络边界**上(窗口抓取与 gamma 元信息),窗口层、令牌桶、卡片服务
// 全部保持真实 —— 这条路由值得测的正是它们串起来的那套语义(背压、陈旧闸、
// 响应形状),mock 掉服务层就只剩一个转发器,测了等于没测。
const budget = vi.hoisted(() => ({ limit: 100 }));

vi.mock("../../../../../lib/marketBrief", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../../lib/marketBrief")>();
  return {
    ...actual,
    fetchMarketWindow: async () => ({ trades: [], truncated: false }),
  };
});

vi.mock("../../../../../lib/gamma", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../../lib/gamma")>();
  return { ...actual, getMarketMeta: async () => ({}) };
});

vi.mock("../../../../../lib/cardBudget", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../../lib/cardBudget")>();
  return { ...actual, budgetFor: () => budget.limit };
});

import { __resetWindows } from "../../../../../lib/marketWindow";
import { GET } from "./route";

const saved = {
  dashDb: process.env.DASH_DB,
  publicReadonly: process.env.PUBLIC_READONLY,
};

beforeAll(() => {
  process.env.DASH_DB = ":memory:";
  process.env.PUBLIC_READONLY = "false";
});

afterAll(() => {
  process.env.DASH_DB = saved.dashDb;
  process.env.PUBLIC_READONLY = saved.publicReadonly;
});

beforeEach(() => {
  __resetWindows();
  budget.limit = 100;
});

const CID = `0x${"a".repeat(64)}`;

async function call(conditionId: string) {
  const res = await GET(
    new Request(`http://localhost/api/signals/market/${conditionId}`),
    { params: Promise.resolve({ conditionId }) },
  );
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/signals/market/[conditionId]", () => {
  it("非法 conditionId → 400", async () => {
    const { res } = await call("not-a-condition-id");
    expect(res.status).toBe(400);
  });

  it("大小写不同的同一个 cid 都接受(归一化在窗口层做)", async () => {
    const { res } = await call(`0x${"A".repeat(64)}`);
    expect(res.status).not.toBe(400);
  });

  it("响应带 builtAt / staleSec / live / healthy / notice —— 缺一个订阅方就得猜", async () => {
    const { body } = await call(CID);
    for (const k of [
      "card",
      "builtAt",
      "staleSec",
      "live",
      "healthy",
      "notice",
    ]) {
      expect(body).toHaveProperty(k);
    }
  });

  it("notice 是全站同一份免责声明,不另写一句", async () => {
    const { body } = await call(CID);
    expect(String(body.notice)).toContain("非投资建议");
  });

  it("预算归零且无缓存窗口 → 429 且带 Retry-After", async () => {
    // 429 在这条路由上是**背压不是错误**。没有 Retry-After,订阅方只会立刻重试,
    // 把背压变成雪崩 —— 这个头是契约的一部分,不是可选装饰。
    budget.limit = 0;
    const { res, body } = await call(CID);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(body).toHaveProperty("healthy");
  });

  it("429 的响应体不带 card —— 背压不能被误读成「这个市场没信号」", async () => {
    budget.limit = 0;
    const { body } = await call(CID);
    expect(body).not.toHaveProperty("card");
    expect(String(body.error)).toContain("budget");
  });

  it("已有热窗口时,预算归零也不 429", async () => {
    const warm = await call(CID);
    expect(warm.res.status).toBe(200);
    budget.limit = 0;
    // 工作集里已经有它,不必再向上游要任何东西 —— 这正是工作集存在的意义。
    const { res } = await call(CID);
    expect(res.status).toBe(200);
  });

  // `live:false` 的降级路径需要把窗口放到 30 秒新鲜期之外,而路由跑的是真实
  // 时钟,测不了。该语义由 lib/marketCardService.test.ts 用注入的 nowSec 覆盖
  // (「预算耗尽但窗口在闸内 —— live:false 且带 staleSec」)。
});
