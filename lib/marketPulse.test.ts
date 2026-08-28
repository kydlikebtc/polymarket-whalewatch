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
    wash_usd: null,
    max_fill_usd: null,
    ...over,
  };
  db.prepare(
    `INSERT OR REPLACE INTO market_daily
       (day, condition_id, title, slug, event_slug, category, subcategory,
        trades, volume_usd, wallet_count, top_outcome, one_sided,
        small_usd, small_net_usd, small_top_outcome,
        whale_usd, whale_net_usd, whale_top_outcome,
        price_first, price_last, covered_from_sec, truncated,
        wash_usd, max_fill_usd)
     VALUES (@day, @cid, @title, @slug, @event_slug, @category, @subcategory,
        @trades, @volume_usd, @wallet_count, @top_outcome, @one_sided,
        @small_usd, @small_net_usd, @small_top_outcome,
        @whale_usd, @whale_net_usd, @whale_top_outcome,
        @price_first, @price_last, @covered_from_sec, @truncated,
        @wash_usd, @max_fill_usd)`,
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


// --- 第二梯队八件套(2026-08-28):无鲸异动 + 洗量榜 ---

describe("buildPulse — ghosts(无鲸异动)", () => {
  it("价移 ≥10¢ 且单笔最大 <$10k 才进榜;max_fill 未知(老日份)不进 —— 不知道不等于没有鲸", () => {
    const db = openDb(":memory:");
    put(db, "2026-08-27", "g1", {
      volume_usd: 50_000,
      price_first: 0.4,
      price_last: 0.55,
      max_fill_usd: 8_000,
    });
    put(db, "2026-08-27", "g2", {
      volume_usd: 50_000,
      price_first: 0.4,
      price_last: 0.55,
      max_fill_usd: 12_000, // 有大单付账,不是无鲸
    });
    put(db, "2026-08-27", "g3", {
      volume_usd: 50_000,
      price_first: 0.5,
      price_last: 0.54, // 4¢,不够剧烈
      max_fill_usd: 5_000,
    });
    put(db, "2026-08-27", "g4", {
      volume_usd: 50_000,
      price_first: 0.4,
      price_last: 0.6,
      max_fill_usd: null, // 老日份
    });
    const r = buildPulse(db);
    expect(r.ghosts.map((g) => g.conditionId)).toEqual(["g1"]);
    expect(r.ghosts[0].moveCents).toBeCloseTo(15);
    expect(r.ghosts[0].maxFillUsd).toBe(8_000);
  });
});

describe("buildPulse — washRatio 与 washTop", () => {
  it("日榜行带 washRatio = 2·wash_usd/volume(单腿存库,双腿口径展示);老行 null", () => {
    const db = openDb(":memory:");
    put(db, "2026-08-27", "w1", { volume_usd: 60_000, wash_usd: 6_000 });
    put(db, "2026-08-27", "w2", { volume_usd: 60_000, wash_usd: null });
    const r = buildPulse(db);
    const w1 = r.top.find((m) => m.conditionId === "w1")!;
    const w2 = r.top.find((m) => m.conditionId === "w2")!;
    expect(w1.washRatio).toBeCloseTo(0.2);
    expect(w2.washRatio).toBeNull();
  });

  it("washTop:占比 ≥20% 且量 ≥$10k,按占比降序", () => {
    const db = openDb(":memory:");
    put(db, "2026-08-27", "w1", { volume_usd: 60_000, wash_usd: 6_000 }); // 20%
    put(db, "2026-08-27", "w2", { volume_usd: 40_000, wash_usd: 12_000 }); // 60%
    put(db, "2026-08-27", "w3", { volume_usd: 60_000, wash_usd: 3_000 }); // 10%,不进
    const r = buildPulse(db);
    expect(r.washTop.map((w) => w.conditionId)).toEqual(["w2", "w1"]);
    expect(r.washTop[0].washRatio).toBeCloseTo(0.6);
  });
});
