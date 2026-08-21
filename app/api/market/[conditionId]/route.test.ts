import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";

// 网页 / TG bot 的卡片路由。它与对外路由(/api/signals/market/[cid])共用同一个
// 窗口层与同一个令牌桶 —— 上游预算本来就是同一份,分两个桶只是把同一个天花板
// 切成两半;而人在网页上看的热门市场正好也是订阅方在看的,共享工作集是净收益。
//
// mock 同对外路由:只打网络边界,窗口层/令牌桶/卡片服务全真。
const budget = vi.hoisted(() => ({ limit: 100 }));

vi.mock("../../../../lib/marketBrief", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../lib/marketBrief")>();
  return {
    ...actual,
    fetchMarketWindow: async () => ({ trades: [], truncated: false }),
  };
});

vi.mock("../../../../lib/gamma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/gamma")>();
  return { ...actual, getMarketMeta: async () => ({}) };
});

vi.mock("../../../../lib/cardBudget", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../lib/cardBudget")>();
  return { ...actual, budgetFor: () => budget.limit };
});

import { __resetWindows } from "../../../../lib/marketWindow";
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

const CID = `0x${"b".repeat(64)}`;

async function call(conditionId: string) {
  const res = await GET(
    new Request(`http://localhost/api/market/${conditionId}`),
    { params: Promise.resolve({ conditionId }) },
  );
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/market/[conditionId]", () => {
  it("正常返回卡片,并带上 builtAt / staleSec / live(additive,网页可忽略)", async () => {
    const { res, body } = await call(CID);
    expect(res.status).toBe(200);
    expect(body).toHaveProperty("identity");
    expect(body).toHaveProperty("builtAt");
    expect(body).toHaveProperty("staleSec");
    expect(body).toHaveProperty("live");
  });

  it("预算归零且无缓存窗口 → 429 —— 网页也受同一个上游预算约束", async () => {
    // 分两个桶只是把同一个天花板切成两半:网页突然爆量同样会挤掉引擎。
    budget.limit = 0;
    const { res } = await call(CID);
    expect(res.status).toBe(429);
  });

  it("非法 conditionId → 400", async () => {
    const { res } = await call("nope");
    expect(res.status).toBe(400);
  });
});
