import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import {
  buildConvictionIndex,
  CONVICTION_MIN_VOLUME_USD,
} from "./convictionIndex";

// 确信指数(第一梯队五件套):品类×日的「激辩度」0-100,高=激辩/恐慌、低=确信
// (VIX 语义)。四分量全部来自 market_daily 现成列 —— 簿面数据不存在,故没有
// 簿厚分量(第三轮脑暴 §评估已记录)。与 buildPulse 同纪律:读取侧现算,
// 评分不落库,分量逐项返回。

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
    subcategory: null,
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

describe("buildConvictionIndex — 空库与门槛", () => {
  it("空库:latestDay null、零品类,不炸", () => {
    const db = openDb(":memory:");
    const r = buildConvictionIndex(db);
    expect(r.latestDay).toBeNull();
    expect(r.days).toBe(0);
    expect(r.categories).toEqual([]);
  });

  it("品类日总量低于门槛 → 该品类当日不进榜(1 笔小单的对峙度也是满分,材料性门槛防噪声)", () => {
    const db = openDb(":memory:");
    put(db, "2026-08-27", "c1", {
      category: "Weather",
      volume_usd: CONVICTION_MIN_VOLUME_USD - 1,
    });
    const r = buildConvictionIndex(db);
    expect(r.latestDay).toBe("2026-08-27");
    expect(r.categories).toEqual([]);
  });
});

describe("buildConvictionIndex — 分量数学(单日横截面)", () => {
  // Sports 两市场:m1 vol 60k(one_sided 0.8,价移 0.5→0.6),m2 vol 40k
  // (one_sided 0.3,平价,构成合格分歧)。category null 归 "" 桶。
  const seed = (db: DB) => {
    put(db, "2026-08-27", "m1", {
      volume_usd: 60_000,
      one_sided: 0.8,
      price_first: 0.5,
      price_last: 0.6,
    });
    put(db, "2026-08-27", "m2", {
      volume_usd: 40_000,
      one_sided: 0.3,
      small_top_outcome: "Yes",
      small_net_usd: 5_000,
      whale_top_outcome: "No",
      whale_net_usd: 50_000,
    });
    put(db, "2026-08-27", "m3", {
      category: null,
      volume_usd: 20_000,
      one_sided: null,
      price_first: null,
      price_last: null,
    });
  };

  it("contest/divergence/priceMove 量能加权;volSurge 无基线时用横截面分位", () => {
    const db = openDb(":memory:");
    seed(db);
    const r = buildConvictionIndex(db);
    expect(r.categories.length).toBe(2);
    const sports = r.categories[0]; // 量能降序:Sports 100k 在前
    expect(sports.key).toBe("Sports");
    expect(sports.volumeUsd).toBeCloseTo(100_000);
    expect(sports.markets).toBe(2);
    // contest = (60k·0.2 + 40k·0.7) / 100k = 0.4
    expect(sports.components.contest).toBeCloseTo(0.4);
    // divergence = 合格分歧市场量能占比 = 40k/100k
    expect(sports.components.divergence).toBeCloseTo(0.4);
    // priceMove = (60k·min(1,0.1/0.2) + 40k·0) / 100k = 0.3
    expect(sports.components.priceMove).toBeCloseTo(0.3);
    // volSurge:单日无自身基线 → 横截面分位(两类里量大者=1)
    expect(sports.components.volSurge).toBeCloseTo(1);
    expect(sports.volBaselineDays).toBe(0);
    // score = round(100·(0.3·0.4 + 0.3·0.4 + 0.2·0.3 + 0.2·1)) = 50
    expect(sports.score).toBe(50);

    const other = r.categories[1];
    expect(other.key).toBe(""); // category null 归空串桶,标签由 UI 决定
    // one_sided/价格全 null → contest/priceMove 无材料记 0;分位=0(量最小)
    expect(other.components.contest).toBe(0);
    expect(other.components.priceMove).toBe(0);
    expect(other.components.volSurge).toBeCloseTo(0);
    expect(other.score).toBe(0);
  });

  it("分歧分量沿用 pulse 同款门槛:小单净额差 $1 也不算", () => {
    const db = openDb(":memory:");
    put(db, "2026-08-27", "m1", {
      volume_usd: 50_000,
      small_top_outcome: "Yes",
      small_net_usd: 4_999, // < DIVERGENCE_SMALL_MIN_USD
      whale_top_outcome: "No",
      whale_net_usd: 50_000,
    });
    const r = buildConvictionIndex(db);
    expect(r.categories[0].components.divergence).toBe(0);
  });
});

describe("buildConvictionIndex — 自身基线与序列", () => {
  it("≥3 天自身基线:volSurge = clamp01(log10(今日量/基线均值))", () => {
    const db = openDb(":memory:");
    // 前三天各 10k,今日 100k → ratio 10 → log10 = 1(封顶)。
    for (const [i, day] of [
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
    ].entries()) {
      put(db, day, `b${i}`, { volume_usd: 10_000 });
    }
    put(db, "2026-08-27", "b9", { volume_usd: 100_000 });
    const r = buildConvictionIndex(db);
    const sports = r.categories[0];
    expect(sports.volBaselineDays).toBe(3);
    expect(sports.components.volSurge).toBeCloseTo(1);
    // 其余分量:contest=0.5、divergence=0、priceMove=0 → score=round(15+20)=35
    expect(sports.score).toBe(35);
  });

  it("series 升序逐日给分,低于门槛的日子直接缺席(不是 0 分)", () => {
    const db = openDb(":memory:");
    put(db, "2026-08-25", "d1", { volume_usd: 50_000 });
    put(db, "2026-08-26", "d2", { volume_usd: 5_000 }); // 低于门槛
    put(db, "2026-08-27", "d3", { volume_usd: 50_000 });
    const r = buildConvictionIndex(db);
    const sports = r.categories[0];
    expect(sports.series.map((s) => s.day)).toEqual([
      "2026-08-25",
      "2026-08-27",
    ]);
    for (const s of sports.series) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
    }
  });

  it("窗口上限 days 生效:更早的日子不进 series 也不进 days 计数", () => {
    const db = openDb(":memory:");
    put(db, "2026-07-01", "old", { volume_usd: 50_000 });
    put(db, "2026-08-26", "n1", { volume_usd: 50_000 });
    put(db, "2026-08-27", "n2", { volume_usd: 50_000 });
    const r = buildConvictionIndex(db, { days: 2 });
    expect(r.days).toBe(2);
    expect(r.categories[0].series.map((s) => s.day)).toEqual([
      "2026-08-26",
      "2026-08-27",
    ]);
  });
});
