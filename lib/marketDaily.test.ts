import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import type { Trade } from "./types";
import { HEAVY_MIN_USD } from "./signalFeed";
import {
  aggregateMarketDay,
  MARKET_DAILY_LAST_DAY_KEY,
  runMarketDailyCycle,
  SMALL_MAX_USD,
  SMALL_MIN_USD,
  WHALE_MIN_USD,
} from "./marketDaily";

const DAY = 86_400;
const NOW = Math.floor(Date.UTC(2026, 7, 27, 0, 40) / 1000); // 今天 00:40
const TODAY = NOW - (NOW % DAY);
const Y = TODAY - DAY; // 昨天 00:00

let seq = 0;
function trade(over: Partial<Trade> = {}): Trade {
  seq++;
  return {
    proxyWallet: `0xw${seq}`,
    side: "BUY",
    asset: "a1",
    conditionId: "0xc1",
    size: 10_000,
    price: 0.5,
    timestamp: Y + 3600 + seq,
    title: "Chiefs win?",
    slug: "chiefs",
    eventSlug: "sb",
    outcome: "Yes",
    outcomeIndex: 0,
    transactionHash: `0xh${seq}`,
    ...over,
  };
}

const OPTS = {
  dayStart: Y,
  dayEnd: TODAY,
  coveredFromSec: Y,
  truncated: false,
};

describe("分桶尺", () => {
  it("鲸鱼桶下限与 heavy 信号同一把尺(HEAVY_MIN_USD)", () => {
    expect(WHALE_MIN_USD).toBe(HEAVY_MIN_USD);
  });
});

describe("aggregateMarketDay", () => {
  it("窗口过滤 + dedupKey 去重:昨日外与重复行不入账", () => {
    const dup = trade({ size: 20_000 });
    const rows = aggregateMarketDay(
      [
        dup,
        { ...dup }, // 同 dedupKey(同 hash/asset/wallet/side/size)
        trade({ timestamp: TODAY + 60, size: 30_000 }), // 今天的 —— 不属于昨天
        trade({ timestamp: Y - 60, size: 30_000 }), // 前天的
      ],
      OPTS,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].trades).toBe(1);
    expect(rows[0].volumeUsd).toBe(20_000 * 0.5);
  });

  it("分桶边界:恰 $10k 不是小单、恰 $50k 是鲸鱼、中间桶两头不沾", () => {
    const rows = aggregateMarketDay(
      [
        trade({ size: SMALL_MIN_USD / 0.5, price: 0.5 }), // $2k 恰好入小单
        trade({ size: SMALL_MAX_USD / 0.5, price: 0.5 }), // $10k 恰好出小单
        trade({ size: WHALE_MIN_USD / 0.5, price: 0.5 }), // $50k 恰好入鲸鱼
      ],
      OPTS,
    );
    const r = rows[0];
    expect(r.smallUsd).toBe(SMALL_MIN_USD);
    expect(r.whaleUsd).toBe(WHALE_MIN_USD);
    expect(r.volumeUsd).toBe(SMALL_MIN_USD + SMALL_MAX_USD + WHALE_MIN_USD);
  });

  it("顶结果按毛量,单边度=顶结果|净|/总量;卖单是负流", () => {
    const rows = aggregateMarketDay(
      [
        trade({ outcome: "Yes", size: 40_000, price: 0.5 }), // +20k Yes
        trade({ outcome: "Yes", side: "SELL", size: 8_000, price: 0.5 }), // -4k Yes
        trade({ outcome: "No", size: 8_000, price: 0.5 }), // +4k No(毛量小)
      ],
      OPTS,
    );
    const r = rows[0];
    expect(r.topOutcome).toBe("Yes");
    // |20k-4k| / 28k
    expect(r.oneSided).toBeCloseTo(16_000 / 28_000, 10);
  });

  it("桶内全在卖 → 该桶无「在买」方向(null),不拿卖得最少的冒充", () => {
    const rows = aggregateMarketDay(
      [
        trade({ side: "SELL", size: 6_000, price: 0.5 }), // 小单卖
        trade({ size: 120_000, price: 0.5, outcome: "No" }), // 鲸鱼买 No
      ],
      OPTS,
    );
    const r = rows[0];
    expect(r.smallTopOutcome).toBeNull();
    expect(r.whaleTopOutcome).toBe("No");
    expect(r.whaleNetUsd).toBe(60_000);
  });

  it("首末价锚定顶结果并按时间排序;钱包数按去重地址", () => {
    const rows = aggregateMarketDay(
      [
        trade({ timestamp: Y + 100, price: 0.4, proxyWallet: "0xa" }),
        trade({ timestamp: Y + 900, price: 0.6, proxyWallet: "0xa" }),
        trade({
          timestamp: Y + 500,
          price: 0.99,
          outcome: "No",
          proxyWallet: "0xb",
        }),
      ],
      OPTS,
    );
    const r = rows[0];
    expect(r.priceFirst).toBe(0.4);
    expect(r.priceLast).toBe(0.6);
    expect(r.walletCount).toBe(2);
  });
});

describe("runMarketDailyCycle", () => {
  const winOf = (trades: Trade[], truncated = false) => ({
    fetchWindow: async () => ({
      trades,
      truncated,
      effectiveSinceSec: truncated ? Y + 6 * 3600 : Y,
    }),
    nowSec: NOW,
  });

  it("聚合昨日、写分类、置日标记;同日第二轮直接跳过", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO event_category (event_slug, category, subcategory, fetched_at) VALUES ('sb','Sports','NFL',?)",
    ).run(NOW);
    const r1 = await runMarketDailyCycle(db, winOf([trade(), trade()]));
    expect(r1).toMatchObject({ ran: true, markets: 1 });
    const row = db
      .prepare("SELECT * FROM market_daily WHERE condition_id = '0xc1'")
      .get() as Record<string, unknown>;
    expect(row.day).toBe(new Date(Y * 1000).toISOString().slice(0, 10));
    expect(row.category).toBe("Sports");
    expect(row.subcategory).toBe("NFL");
    const r2 = await runMarketDailyCycle(db, winOf([trade()]));
    expect(r2.ran).toBe(false);
    db.close();
  });

  it("截断窗口如实落 covered_from 与 truncated —— 覆盖打折要看得见", async () => {
    const db = openDb(":memory:");
    await runMarketDailyCycle(db, winOf([trade()], true));
    const row = db
      .prepare("SELECT covered_from_sec, truncated FROM market_daily")
      .get() as {
      covered_from_sec: number;
      truncated: number;
    };
    expect(row.truncated).toBe(1);
    expect(row.covered_from_sec).toBe(Y + 6 * 3600);
    db.close();
  });

  it("抓取失败:不写标记,下一轮重试(与 claim-first 相反的裁决)", async () => {
    const db = openDb(":memory:");
    await expect(
      runMarketDailyCycle(db, {
        fetchWindow: async () => {
          throw new Error("upstream 503");
        },
        nowSec: NOW,
      }),
    ).rejects.toThrow("upstream 503");
    const marker = db
      .prepare("SELECT value FROM config WHERE key = ?")
      .get(MARKET_DAILY_LAST_DAY_KEY);
    expect(marker).toBeUndefined();
    db.close();
  });
});
