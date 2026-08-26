import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../../../../lib/db";
import { recordAlert } from "../../../../lib/seen";
import { guardExpensive, resetRateLimiter } from "../../../../lib/apiGuard";
import type { ActivityTrade } from "../../../../lib/walletProfile";

// /api/wallet/[address] 的降级语义。钉三件事:
//   1. 限流/上游故障 ≠ 无数据 —— 回 200 + degraded 标志 + 纯本地档案
//      (alerts 台账、战绩/年龄缓存、温内存缓存),而不是从前的一条红字死端;
//   2. 降级路径**零上游**:战绩缓存过期也照读(只读不回源),miss 不污染缓存;
//   3. 正常路径不回归(profile/holdings/stats 全量返回,无 degraded 字段)。

// 上游三件套全部 mock:profile 的 activity 拉取、holdings、PUSD RPC。
// analyzeTrades 等纯函数保留原实现(importOriginal)。
const fetchRecentTradesMock = vi.fn<(w: string) => Promise<ActivityTrade[]>>();
vi.mock("../../../../lib/walletProfile", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../../../../lib/walletProfile")>();
  return {
    ...mod,
    fetchRecentTrades: (w: string) => fetchRecentTradesMock(w),
  };
});
vi.mock("../../../../lib/holdings", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../../lib/holdings")>();
  return {
    ...mod,
    fetchCurrentHoldings: vi.fn(async () => ({
      holdings: [],
      totalValue: 500,
      totalCashPnl: 40,
      count: 1,
      truncated: false,
    })),
  };
});
vi.mock("../../../../lib/pusdBalance", () => ({
  fetchPusdBalance: vi.fn(async () => 123),
}));
// 安全网:任何漏网的上游调用(walletStats/walletAge/gamma 的默认 fetcher)
// 都会撞上这面墙 —— 测试里绝不真打 Polymarket。
vi.mock("../../../../lib/fetchWithRetry", () => ({
  fetchWithRetry: vi.fn(async () => {
    throw new Error("no real upstream in tests");
  }),
}));

const A = "0x" + "a".repeat(40); // 正常路径 + 温缓存降级
const B = "0x" + "b".repeat(40); // 冷缓存降级(限流)
const C = "0x" + "c".repeat(40); // 上游故障降级

let dir: string;
const saved = {
  dashDb: process.env.DASH_DB,
  publicReadonly: process.env.PUBLIC_READONLY,
};

const NOW = Math.floor(Date.now() / 1000);

function trade(over: Partial<ActivityTrade> = {}): ActivityTrade {
  return {
    timestamp: NOW - 600,
    conditionId: "0xc1",
    side: "BUY",
    size: 100,
    usdcSize: 60,
    price: 0.6,
    title: "Will it rain?",
    outcome: "Yes",
    eventSlug: "ev-1",
    transactionHash: "0xt1",
    ...over,
  };
}

function seed(address: string, opts: { staleStats?: boolean } = {}) {
  const db = openDb(process.env.DASH_DB!);
  // 本站告警台账:payload 里含地址即可命中 LIKE 探针。
  recordAlert(
    db,
    "large",
    `hit-${address}`,
    JSON.stringify({
      proxyWallet: address,
      side: "BUY",
      size: 1000,
      price: 0.5,
      title: "Seeded market",
      outcome: "Yes",
      eventSlug: "ev-1",
    }),
    NOW - 3600,
  );
  // 战绩缓存:staleStats 时把 fetched_at 拨到 10 天前(远超 1 天 TTL)——
  // 降级路径必须仍能读到它(只读缓存,过期胜于没有)。
  db.prepare(
    `INSERT OR REPLACE INTO wallet_stats
       (wallet, win_rate, realized_pnl, roi, settled_count, truncated, markets_traded, fetched_at)
     VALUES (?, 0.6, 1000, 0.2, 25, 0, 40, ?)`,
  ).run(address, opts.staleStats ? NOW - 10 * 86400 : NOW - 60);
  db.prepare(
    "INSERT OR REPLACE INTO wallet_age (wallet, first_ts, fetched_at) VALUES (?, ?, ?)",
  ).run(address, NOW - 90 * 86400, NOW);
  // 事件分类缓存(正常路径 getEventCategories 与降级路径 readEventCategories
  // 都吃它,种上后两条路径都零上游)。
  db.prepare(
    "INSERT OR REPLACE INTO event_category (event_slug, category, subcategory, fetched_at) VALUES ('ev-1','Sports','NBA',?)",
  ).run(NOW);
  db.close();
}

beforeAll(() => {
  // 必须是真文件:route 每次自己 openDb,`:memory:` 会让 seed 与被测代码
  // 看到两个不相干的空库。
  dir = mkdtempSync(join(tmpdir(), "wallet-route-"));
  process.env.DASH_DB = join(dir, "test.sqlite");
  process.env.PUBLIC_READONLY = "false";
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env.DASH_DB = saved.dashDb;
  process.env.PUBLIC_READONLY = saved.publicReadonly;
});

beforeEach(() => {
  resetRateLimiter();
  fetchRecentTradesMock.mockReset();
  fetchRecentTradesMock.mockResolvedValue([
    trade(),
    trade({ side: "SELL", usdcSize: 30, timestamp: NOW - 300 }),
  ]);
});

const { GET } = await import("./route");

async function get(address: string) {
  const res = await GET(new Request(`http://localhost/api/wallet/${address}`), {
    params: Promise.resolve({ address }),
  });
  return {
    res,
    body: (await res.json()) as Record<string, unknown> & {
      profile: { tradeCount: number } | null;
      stats: { settledCount: number } | null;
      alertHits: unknown[];
      holdings: { count: number };
    },
  };
}

// 灌满 "wallet-profile" 池(与 route 同一 limiter 模块实例、同一
// "unattributed" IP 桶):40 × cost3 = 120 = perIp 上限,下一次必拒。
function exhaustBudget() {
  for (let i = 0; i < 40; i++) {
    guardExpensive(
      new Request("http://localhost/x"),
      "wallet-profile",
      { perIp: 120, global: 400, cost: 3 },
      {},
    );
  }
}

describe("正常路径(非公开部署,限流不生效)", () => {
  it("全量档案:profile/holdings/stats/alertHits 齐活,无 degraded", async () => {
    seed(A);
    const { res, body } = await get(A);
    expect(res.status).toBe(200);
    expect(body.degraded).toBeUndefined();
    expect(body.profile?.tradeCount).toBe(2);
    expect(body.holdings.count).toBe(1);
    expect(body.pusdBalance).toBe(123);
    expect(body.stats?.settledCount).toBe(25);
    expect(body.alertHits).toHaveLength(1);
    // 分类装饰来自本地 event_category 缓存。
    expect(body.categories).toEqual([
      { category: "Sports", usd: 90, share: 1 },
    ]);
  });
});

describe("限流降级(公开部署,预算耗尽)", () => {
  it("冷缓存钱包:200 + degraded=rate_limited + 本地字段,零上游", async () => {
    seed(B, { staleStats: true });
    process.env.PUBLIC_READONLY = "true";
    try {
      exhaustBudget();
      const { res, body } = await get(B);
      expect(res.status).toBe(200);
      expect(body.degraded).toBe("rate_limited");
      expect(body.retryAfterSec).toBe(60);
      expect(body.error).toBeUndefined();
      // 实时层缺席……
      expect(body.profile).toBeNull();
      expect(body.holdings.count).toBe(0);
      expect(body.pusdBalance).toBeNull();
      // ……但本地档案在:台账命中 + **过期的**战绩缓存照读(只读不回源)。
      expect(body.alertHits).toHaveLength(1);
      expect(body.stats?.settledCount).toBe(25);
      expect(body.firstTs).toBe(NOW - 90 * 86400);
      // 降级路径没有打过 activity 上游。
      expect(fetchRecentTradesMock).not.toHaveBeenCalled();
    } finally {
      process.env.PUBLIC_READONLY = "false";
    }
  });

  it("温缓存钱包:降级响应白拿内存里的 profile(含只读分类装饰)", async () => {
    // A 在上一组测试里已被正常路径加载 → profileCache 温着(10min TTL)。
    process.env.PUBLIC_READONLY = "true";
    try {
      exhaustBudget();
      const { body } = await get(A);
      expect(body.degraded).toBe("rate_limited");
      expect(body.profile?.tradeCount).toBe(2);
      expect(body.categories).toEqual([
        { category: "Sports", usd: 90, share: 1 },
      ]);
      expect((body.recent as unknown[]).length).toBeGreaterThan(0);
      expect(fetchRecentTradesMock).not.toHaveBeenCalled();
    } finally {
      process.env.PUBLIC_READONLY = "false";
    }
  });
});

describe("上游故障降级", () => {
  it("activity 拉取炸掉:200 + degraded=upstream_error + 本地字段", async () => {
    seed(C);
    fetchRecentTradesMock.mockRejectedValue(new Error("data-api 500"));
    const { res, body } = await get(C);
    expect(res.status).toBe(200);
    expect(body.degraded).toBe("upstream_error");
    expect(body.retryAfterSec).toBe(30);
    expect(body.profile).toBeNull();
    expect(body.alertHits).toHaveLength(1);
    expect(body.stats?.settledCount).toBe(25);
  });
});
