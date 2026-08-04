import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import {
  fetchEventCategories,
  fetchMarketMeta,
  getEventCategories,
  getMarketMeta,
  parseUmaDisputed,
  tradeMarketContext,
  type MarketMeta,
} from "./gamma";

// Live-shape gamma row: liquidity as string, stringified JSON arrays.
const gammaRow = (cid: string, over: Record<string, unknown> = {}) => ({
  conditionId: cid,
  volume24hr: 627072.18,
  liquidity: "229073.1289",
  liquidityNum: 229073.1289,
  endDate: "2026-07-03T22:00:00Z",
  closed: false,
  category: null,
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.905", "0.095"]',
  ...over,
});

const meta = (cid: string, over: Partial<MarketMeta> = {}): MarketMeta => ({
  conditionId: cid,
  volume24hr: 100_000,
  liquidity: 50_000,
  endDate: "2026-07-03T22:00:00Z",
  closed: false,
  category: "Sports",
  outcomes: ["Yes", "No"],
  outcomePrices: [0.9, 0.1],
  feesEnabled: false,
  feeType: null,
  feeSchedule: null,
  umaDisputed: false,
  ...over,
});

describe("fetchMarketMeta", () => {
  it("normalizes live field shapes (string liquidity, stringified arrays)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => [gammaRow("0xc1")] });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchMarketMeta(["0xc1"]);
    const m = out["0xc1"];
    expect(m.liquidity).toBeCloseTo(229073.1289);
    expect(m.outcomes).toEqual(["Yes", "No"]);
    expect(m.outcomePrices).toEqual([0.905, 0.095]);
    expect(m.closed).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toContain("condition_ids=0xc1");
  });

  it("采集费率与 UMA 争议字段（同一响应免费带回，零新增上游调用）", async () => {
    // 实测形状(2026-08-04):72/100 头部市场 feesEnabled=true,7 个品类。
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        gammaRow("0xc1", {
          feesEnabled: true,
          feeType: "sports_fees_v2",
          feeSchedule: {
            exponent: 1,
            rate: 0.05,
            takerOnly: true,
            rebateRate: 0.15,
          },
          umaResolutionStatuses: '["proposed"]',
        }),
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const m = (await fetchMarketMeta(["0xc1"]))["0xc1"];
    expect(m.feesEnabled).toBe(true);
    expect(m.feeType).toBe("sports_fees_v2");
    expect(m.feeSchedule).toEqual({
      exponent: 1,
      rate: 0.05,
      takerOnly: true,
      rebateRate: 0.15,
    });
    expect(m.umaDisputed).toBe(false);
  });

  it("费率字段缺失的市场诚实置空（免费市场 feesEnabled=false）", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => [gammaRow("0xc1")] });
    vi.stubGlobal("fetch", fetchMock);
    const m = (await fetchMarketMeta(["0xc1"]))["0xc1"];
    expect(m.feesEnabled).toBe(false);
    expect(m.feeSchedule).toBeNull();
    expect(m.umaDisputed).toBeNull(); // 字段缺席 = 未知,不是"没争议"
  });

  it("keeps successful chunks when another chunk fails (independent failure)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ids = Array.from({ length: 25 }, (_, i) => `0xc${i}`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ids.slice(0, 20).map((c) => gammaRow(c)),
      })
      // Non-transient failure (a 5xx would now be retried and recover via the
      // fallback mock below): the chunk is skipped immediately, others kept.
      .mockResolvedValueOnce({ ok: false, status: 400 })
      // closed=true retry sweep for the failed chunk's ids — also empty here.
      .mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchMarketMeta(ids);
    expect(Object.keys(out)).toHaveLength(20); // chunk 1 kept, chunk 2 skipped
    warnSpy.mockRestore();
  });

  it("retries a transient 5xx chunk and recovers it instead of skipping", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [gammaRow("0xc1")],
      });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchMarketMeta(["0xc1"]);
    expect(out["0xc1"]).toBeDefined(); // recovered on retry, not skipped
    expect(fetchMock).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("finds SETTLED markets via the closed=true second sweep (plain query excludes them)", async () => {
    // Verified live: /markets?condition_ids= returns 0 rows for a closed
    // market unless closed=true is passed — the settlement backfill depends
    // on this second sweep.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) // open sweep: not found
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          gammaRow("0xsettled", { closed: true, outcomePrices: '["1", "0"]' }),
        ],
      });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchMarketMeta(["0xsettled"]);
    expect(out["0xsettled"]?.closed).toBe(true);
    expect(out["0xsettled"]?.outcomePrices).toEqual([1, 0]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("closed=true");
  });

  it("chunks large id sets into multiple requests", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `0xc${i}`);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ids.map((c) => gammaRow(c)),
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchMarketMeta(ids);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 20 + 5
  });
});

describe("getMarketMeta", () => {
  it("caches fetched meta and serves it within the TTL", async () => {
    const db = openDb(":memory:");
    const fetcher = vi.fn(async (ids: string[]) =>
      Object.fromEntries(ids.map((c) => [c, meta(c)])),
    );
    await getMarketMeta(db, ["0xc1"], { fetcher, nowSec: 1000 });
    const second = await getMarketMeta(db, ["0xc1"], {
      fetcher,
      nowSec: 1000 + 100,
    });
    expect(second["0xc1"]).toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refreshes an OPEN market after the TTL but keeps a CLOSED one forever", async () => {
    const db = openDb(":memory:");
    const fetcher = vi.fn(async (ids: string[]) =>
      Object.fromEntries(
        ids.map((c) => [c, meta(c, { closed: c === "0xclosed" })]),
      ),
    );
    await getMarketMeta(db, ["0xopen", "0xclosed"], { fetcher, nowSec: 1000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await getMarketMeta(db, ["0xopen", "0xclosed"], {
      fetcher,
      nowSec: 1000 + 100_000, // far past the 1h TTL
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Only the open market was refetched.
    expect(fetcher.mock.calls[1][0]).toEqual(["0xopen"]);
  });

  it("schema 版本变更让旧缓存行失效 —— 否则 CLOSED 市场永远拿不到新字段", async () => {
    // closed 市场的缓存"永不过期"是结算回填赖以成立的前提,代价是新增字段
    // 对老行永久为空。版本号是唯一的解法。
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO market_meta (condition_id, meta_json, fetched_at) VALUES (?, ?, ?)",
    ).run(
      "0xclosed",
      JSON.stringify({ conditionId: "0xclosed", closed: true }), // 无 v 的老行
      1000,
    );
    const fetcher = vi.fn(async (ids: string[]) =>
      Object.fromEntries(ids.map((c) => [c, meta(c, { closed: true })])),
    );
    const out = await getMarketMeta(db, ["0xclosed"], {
      fetcher,
      nowSec: 1100,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(out["0xclosed"].feesEnabled).toBe(false);
    // 重取后带上版本号,下一次命中缓存。
    await getMarketMeta(db, ["0xclosed"], { fetcher, nowSec: 1200 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("closed 但争议中的市场继续刷新 —— 不享有 immutable 缓存", async () => {
    // 这段逻辑曾被一次「只改文档」的提交静默回退,而 733 个测试无一变红:
    // 它当时零覆盖。争议中的临时结果若被永久缓存,即使 UMA 后来翻案也永不重取。
    const db = openDb(":memory:");
    const fetcher = vi.fn(async (ids: string[]) =>
      Object.fromEntries(
        ids.map((c) => [c, meta(c, { closed: true, umaDisputed: true })]),
      ),
    );
    await getMarketMeta(db, ["0xd"], { fetcher, nowSec: 1000 });
    await getMarketMeta(db, ["0xd"], { fetcher, nowSec: 1000 + 100_000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("争议态 TTL 取 min —— 绝不把调用方更短的 ttlSec 拉长", async () => {
    // /api/consensus 用 ttlSec=60 读「现价」,若被争议分支放大到 1800s,
    // 「仍可跟 +1.2¢ / 已跑」会基于半小时前的价格给出结论。
    const db = openDb(":memory:");
    const fetcher = vi.fn(async (ids: string[]) =>
      Object.fromEntries(
        ids.map((c) => [c, meta(c, { closed: false, umaDisputed: true })]),
      ),
    );
    await getMarketMeta(db, ["0xd"], { fetcher, nowSec: 1000, ttlSec: 60 });
    await getMarketMeta(db, ["0xd"], { fetcher, nowSec: 1600, ttlSec: 60 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("degrades to an empty result when the fetcher throws", async () => {
    const db = openDb(":memory:");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await getMarketMeta(db, ["0xc1"], {
      fetcher: async () => {
        throw new Error("boom");
      },
      nowSec: 1000,
    });
    expect(out).toEqual({});
    warnSpy.mockRestore();
  });
});

describe("event categories", () => {
  const event = (slug: string, labels: string[]) => ({
    slug,
    tags: labels.map((label) => ({ id: "1", label, slug: label })),
  });

  it("picks the primary category over niche tags (Sports beats Soccer/Games)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        event("ev-a", ["Soccer", "Games", "Sports", "FIFA World Cup"]),
        event("ev-b", ["Bitcoin", "Crypto"]),
        event("ev-c", []), // tagless → known-none ""
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchEventCategories(["ev-a", "ev-b", "ev-c"]);
    expect(out["ev-a"]).toBe("Sports");
    expect(out["ev-b"]).toBe("Crypto");
    expect(out["ev-c"]).toBe(""); // resolved but unknown
    expect(fetchMock.mock.calls[0][0]).toContain("slug=ev-a");
  });

  it("falls back to the first tag label when no primary category matches", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [event("ev-x", ["Chess", "Board Games"])],
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchEventCategories(["ev-x"]);
    expect(out["ev-x"]).toBe("Chess");
  });

  it("getEventCategories caches known results (including known-none) permanently", async () => {
    const db = openDb(":memory:");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ "ev-a": "Sports", "ev-b": "" });
    const first = await getEventCategories(db, ["ev-a", "ev-b"], { fetcher });
    expect(first).toEqual({ "ev-a": "Sports", "ev-b": null });
    const second = await getEventCategories(db, ["ev-a", "ev-b"], { fetcher });
    expect(second).toEqual({ "ev-a": "Sports", "ev-b": null });
    expect(fetcher).toHaveBeenCalledTimes(1); // both served from cache
  });

  it("getEventCategories leaves failed-chunk slugs uncached for retry", async () => {
    const db = openDb(":memory:");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({}) // chunk failed — slug absent
      .mockResolvedValueOnce({ "ev-a": "Politics" });
    const first = await getEventCategories(db, ["ev-a"], { fetcher });
    expect(first["ev-a"]).toBeNull();
    const second = await getEventCategories(db, ["ev-a"], { fetcher });
    expect(second["ev-a"]).toBe("Politics");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("parseUmaDisputed 单数字段优先", () => {
  // 实测分布(2026-08-04):300 个 closed 市场单数字段 100% 为 "resolved";
  // 100 个 open 市场里 缺席 88 / "proposed" 10 / "disputed" 2。
  // 真正争议中的形态是 closed=false + 单数 "disputed"。
  it.each([
    ["单数 disputed → 争议中", "disputed", true],
    ["单数 resolved → 已终局", "resolved", false],
    ["单数 proposed → 待过期,未争议", "proposed", false],
  ])("%s", (_n, status, expected) => {
    expect(parseUmaDisputed(status)).toBe(expected);
  });

  it("⚠️ DVM 终裁形态：数组停在 disputed 但单数已 resolved —— 必须判为已终局", () => {
    // 这是本函数最初的 bug:第二次争议升级到 UMA 的 DVM 投票后,仲裁结果
    // 不会再作为一次 "proposed" 追加进数组,数组永远停在 "disputed"。只看
    // 数组末位会把这类【已终局】市场永久判为争议中 —— 仓位永不结算、告警
    // 永不进战绩,且无自愈路径。两个真实市场(均 closed + outcomePrices
    // ["1","0"]):0x99180dac…(infinex 公售)、0x6f4f3632…(伊朗领空)。
    const arr = '["proposed","disputed","proposed","disputed"]';
    expect(parseUmaDisputed("resolved", arr)).toBe(false);
    // 单数缺席时才回退数组 —— 数组本身分不清"争议中"与"争议后已仲裁"。
    expect(parseUmaDisputed(undefined, arr)).toBe(true);
  });

  it("单数字段优先级高于数组，且未观测取值 → null", () => {
    expect(parseUmaDisputed("disputed", '["proposed"]')).toBe(true);
    expect(parseUmaDisputed("resolved", '["disputed"]')).toBe(false);
    expect(parseUmaDisputed("某个新状态", '["disputed"]')).toBeNull();
  });
});

describe("parseUmaDisputed 数组回退（单数字段缺席时）", () => {
  // 数组是字符串化 JSON(不是数组),元素见过 "proposed" / "disputed" / "resolved"。
  // 只在单数字段缺席时使用 —— 它分不清「争议中」与「争议后已仲裁」。
  it.each([
    ['"[]" 尚未提案 → 未争议', "[]", false],
    ["单次提案 → 未争议", '["proposed"]', false],
    ["提案后被争议 → 争议中", '["proposed","disputed"]', true],
    ["末位 resolved → 已终局", '["proposed","disputed","resolved"]', false],
    [
      "争议后重新提案且未再被争议 → 已不在争议中",
      '["proposed","disputed","proposed"]',
      false,
    ],
  ])("%s", (_name, raw, expected) => {
    expect(parseUmaDisputed(undefined, raw)).toBe(expected);
  });

  it("两个字段都缺席 / 坏 JSON / 未观测取值 → null（fail-open）", () => {
    expect(parseUmaDisputed(undefined, undefined)).toBeNull();
    expect(parseUmaDisputed(null, null)).toBeNull();
    expect(parseUmaDisputed(undefined, "不是 JSON")).toBeNull();
    expect(parseUmaDisputed(undefined, '["settled"]')).toBeNull();
    expect(parseUmaDisputed(undefined, '{"a":1}')).toBeNull();
    expect(parseUmaDisputed(undefined, '["proposed", 42]')).toBeNull();
  });

  it("已经是数组的形态也接受（上游若改回真数组不会静默失灵）", () => {
    expect(parseUmaDisputed(undefined, ["proposed", "disputed"])).toBe(true);
  });
});

describe("tradeMarketContext", () => {
  const NOW = Math.floor(Date.parse("2026-07-01T22:00:00Z") / 1000);

  it("computes impact, liquidity share, and hours to end", () => {
    const ctx = tradeMarketContext(20_000, meta("0xc1"), NOW);
    expect(ctx?.impact24h).toBeCloseTo(0.2);
    expect(ctx?.liquidityShare).toBeCloseTo(0.4);
    expect(ctx?.hoursToEnd).toBeCloseTo(48);
  });

  it("returns null hoursToEnd for a closed market and null ctx for missing meta", () => {
    const closed = tradeMarketContext(
      1000,
      meta("0xc1", { closed: true }),
      NOW,
    );
    expect(closed?.hoursToEnd).toBeNull();
    expect(tradeMarketContext(1000, undefined, NOW)).toBeNull();
  });

  it("clamps a past endDate to 0 hours and handles zero volume", () => {
    const past = tradeMarketContext(
      1000,
      meta("0xc1", { endDate: "2026-06-30T00:00:00Z", volume24hr: 0 }),
      NOW,
    );
    expect(past?.hoursToEnd).toBe(0);
    expect(past?.impact24h).toBeNull();
  });
});
