import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import {
  buildPulse,
  DIVERGENCE_SMALL_MIN_USD,
  DIVERGENCE_WHALE_MIN_USD,
  PULSE_MIN_VOLUME_USD,
} from "./marketPulse";

function put(
  db: DB,
  day: string,
  cid: string,
  over: Partial<Record<string, unknown>> = {},
) {
  const base: Record<string, unknown> = {
    title: `M${cid}`,
    slug: `s-${cid}`,
    event_slug: `e-${cid}`,
    category: "Sports",
    subcategory: "NBA",
    trades: 10,
    volume_usd: 50_000,
    wallet_count: 5,
    top_outcome: "Yes",
    one_sided: 0.5,
    small_usd: 10_000,
    small_net_usd: 0,
    small_top_outcome: null,
    whale_usd: 0,
    whale_net_usd: 0,
    whale_top_outcome: null,
    price_first: 0.5,
    price_last: 0.5,
    covered_from_sec: 0,
    truncated: 0,
    ...over,
  };
  db.prepare(
    `INSERT OR REPLACE INTO market_daily
       (day, condition_id, title, slug, event_slug, category, subcategory,
        trades, volume_usd, wallet_count, top_outcome, one_sided,
        small_usd, small_net_usd, small_top_outcome,
        whale_usd, whale_net_usd, whale_top_outcome,
        price_first, price_last, covered_from_sec, truncated)
     VALUES (@day, @cid, @title, @slug, @event_slug, @category, @subcategory,
        @trades, @volume_usd, @wallet_count, @top_outcome, @one_sided,
        @small_usd, @small_net_usd, @small_top_outcome,
        @whale_usd, @whale_net_usd, @whale_top_outcome,
        @price_first, @price_last, @covered_from_sec, @truncated)`,
  ).run({ day, cid, ...base });
}

describe("buildPulse — 空库与元信息", () => {
  it("空库:latestDay null、零榜单,不炸", () => {
    const db = openDb(":memory:");
    const r = buildPulse(db);
    expect(r.latestDay).toBeNull();
    expect(r.top).toEqual([]);
    expect(r.divergences).toEqual([]);
    expect(r.dayCount).toBe(0);
    db.close();
  });
  it("dayCount 报底座积累天数,latestDay 取最新日", () => {
    const db = openDb(":memory:");
    put(db, "2026-08-25", "0xa");
    put(db, "2026-08-26", "0xa");
    const r = buildPulse(db);
    expect(r.latestDay).toBe("2026-08-26");
    expect(r.dayCount).toBe(2);
    db.close();
  });
});

describe("buildPulse — 异常评分", () => {
  it("自身基线 ≥3 天:量能 10 倍 → volSurge 拉满,volRatio 如实", () => {
    const db = openDb(":memory:");
    for (const d of ["2026-08-23", "2026-08-24", "2026-08-25"]) {
      put(db, d, "0xa", { volume_usd: 10_000 });
    }
    put(db, "2026-08-26", "0xa", {
      volume_usd: 100_000,
      one_sided: 0,
      whale_usd: 0,
    });
    const r = buildPulse(db);
    const m = r.top[0];
    expect(m.volBaselineDays).toBe(3);
    expect(m.volRatio).toBeCloseTo(10, 6);
    expect(m.components.volSurge).toBe(1);
    // 0.35×1 + 0 + 0 + 0 = 35
    expect(m.score).toBe(35);
    db.close();
  });

  it("基线不足 3 天:退化为横截面分位,volRatio 为 null", () => {
    const db = openDb(":memory:");
    put(db, "2026-08-26", "0xbig", { volume_usd: 200_000, one_sided: 0 });
    put(db, "2026-08-26", "0xmid", { volume_usd: 50_000, one_sided: 0 });
    put(db, "2026-08-26", "0xsm", { volume_usd: 20_000, one_sided: 0 });
    const r = buildPulse(db);
    const big = r.top.find((m) => m.conditionId === "0xbig")!;
    expect(big.volRatio).toBeNull();
    expect(big.volBaselineDays).toBe(0);
    expect(big.components.volSurge).toBe(1); // 3 个市场里排最高
    db.close();
  });

  it("材料性门槛:总量 < $10k 不进榜(1 笔小单单边度也是 1.0)", () => {
    const db = openDb(":memory:");
    put(db, "2026-08-26", "0xtiny", {
      volume_usd: PULSE_MIN_VOLUME_USD - 1,
      one_sided: 1,
    });
    put(db, "2026-08-26", "0xok", { volume_usd: PULSE_MIN_VOLUME_USD });
    const r = buildPulse(db);
    expect(r.top.map((m) => m.conditionId)).toEqual(["0xok"]);
    db.close();
  });

  it("四分量齐活时按权重合成并降序;价移 20¢ 封顶", () => {
    const db = openDb(":memory:");
    put(db, "2026-08-26", "0xhot", {
      volume_usd: 100_000,
      one_sided: 1,
      whale_usd: 100_000,
      price_first: 0.3,
      price_last: 0.9, // 60¢ 移动,封顶到 1
    });
    put(db, "2026-08-26", "0xcold", {
      volume_usd: 50_000,
      one_sided: 0,
      whale_usd: 0,
    });
    const r = buildPulse(db);
    expect(r.top[0].conditionId).toBe("0xhot");
    expect(r.top[0].components.priceMove).toBe(1);
    // 横截面分位:0xhot 最高 → volSurge 1;0.35+0.25+0.2+0.2 = 100
    expect(r.top[0].score).toBe(100);
    db.close();
  });
});

describe("buildPulse — 散户 vs 鲸鱼分歧", () => {
  it("方向不同且双边材料性达标才入列,按 min(两净额) 降序", () => {
    const db = openDb(":memory:");
    put(db, "2026-08-26", "0xdiv", {
      small_top_outcome: "Yes",
      small_net_usd: 8_000,
      whale_top_outcome: "No",
      whale_net_usd: 90_000,
    });
    put(db, "2026-08-26", "0xdiv2", {
      small_top_outcome: "Yes",
      small_net_usd: 20_000,
      whale_top_outcome: "No",
      whale_net_usd: 60_000,
    });
    const r = buildPulse(db);
    expect(r.divergences.map((d) => d.conditionId)).toEqual([
      "0xdiv2",
      "0xdiv",
    ]);
    expect(r.divergences[0].strength).toBe(20_000);
    db.close();
  });

  it("同向不算分歧;单边不足门槛不算", () => {
    const db = openDb(":memory:");
    put(db, "2026-08-26", "0xsame", {
      small_top_outcome: "Yes",
      small_net_usd: 50_000,
      whale_top_outcome: "Yes",
      whale_net_usd: 200_000,
    });
    put(db, "2026-08-26", "0xweak", {
      small_top_outcome: "Yes",
      small_net_usd: DIVERGENCE_SMALL_MIN_USD - 1,
      whale_top_outcome: "No",
      whale_net_usd: DIVERGENCE_WHALE_MIN_USD,
    });
    const r = buildPulse(db);
    expect(r.divergences).toEqual([]);
    db.close();
  });
});
