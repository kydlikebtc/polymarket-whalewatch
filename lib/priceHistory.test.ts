import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchPriceAt } from "./priceHistory";

// CLOB prices-history 桩:{history:[{t,p}]}(实测形状,见 priceHistory.ts 注释)。
const stubHistory = (points: { t: number; p: number }[]) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ history: points }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPriceAt", () => {
  it("默认取距 targetTs 最近的点(可以在 targetTs 之后)——现有行为不变", async () => {
    stubHistory([
      { t: 980, p: 0.4 },
      { t: 1010, p: 0.6 }, // 距离 10 < 20 → 最近
    ]);
    expect(await fetchPriceAt("tok", 1000)).toBe(0.6);
  });

  it("atOrBefore:只在 t <= targetTs 的点里取最近的(防前视偏差)", async () => {
    // 形成后价格通常朝进场方向移动:取"之后的最近点"会系统性低估延迟成本。
    stubHistory([
      { t: 950, p: 0.35 },
      { t: 980, p: 0.4 }, // ≤1000 中最近 → 应选它
      { t: 1010, p: 0.6 }, // 之后的点更近,但必须被排除
    ]);
    expect(await fetchPriceAt("tok", 1000, { atOrBefore: true })).toBe(0.4);
  });

  it("atOrBefore:t == targetTs 的点可用(≤ 含等号)", async () => {
    stubHistory([
      { t: 1000, p: 0.55 },
      { t: 1010, p: 0.6 },
    ]);
    expect(await fetchPriceAt("tok", 1000, { atOrBefore: true })).toBe(0.55);
  });

  it("atOrBefore:全部点都在 targetTs 之后 → null(默认行为则仍取最近点)", async () => {
    const points = [
      { t: 1010, p: 0.6 },
      { t: 1020, p: 0.7 },
    ];
    stubHistory(points);
    expect(await fetchPriceAt("tok", 1000, { atOrBefore: true })).toBeNull();
    stubHistory(points);
    expect(await fetchPriceAt("tok", 1000)).toBe(0.6);
  });

  it("坏点(p 非有限数/字段缺失)照旧被跳过", async () => {
    stubHistory([
      { t: 990, p: Number.NaN },
      { t: 960, p: 0.42 },
    ]);
    expect(await fetchPriceAt("tok", 1000, { atOrBefore: true })).toBe(0.42);
  });
});
