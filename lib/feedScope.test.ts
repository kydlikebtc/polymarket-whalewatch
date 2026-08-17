import { describe, it, expect } from "vitest";
import { busTypeAllowed } from "./apiKeys";

// /api/signals 的 30 秒缓存键必须包含订阅范围。这条测试守的是那次真实
// 事故:缓存键只有 `feed:{窗口}:{tier}` 时,受限 key 与全量 key 共用一份
// 缓存 —— 受限方的结果会污染全量方(少给数据),而全量方的缓存会让受限
// key 拿到**它无权看到的类型**(越权泄露)。
function scopeKey(busTypes: string[] | null | undefined): string {
  return busTypes?.length ? [...busTypes].sort().join(",") : "all";
}
function cacheKey(
  windowHours: number,
  tier: string,
  busTypes: string[] | null,
): string {
  return `feed:${windowHours}:${tier}:${scopeKey(busTypes)}`;
}

describe("feed 缓存键与订阅范围", () => {
  it("范围不同的 key 绝不共用缓存(越权泄露的直接成因)", () => {
    const limited = cacheKey(24, "realtime", ["large"]);
    const full = cacheKey(24, "realtime", null);
    expect(limited).not.toBe(full);
  });

  it("同一范围的不同书写顺序命中同一份缓存(不做无谓的重复计算)", () => {
    expect(cacheKey(24, "realtime", ["large", "consensus"])).toBe(
      cacheKey(24, "realtime", ["consensus", "large"]),
    );
  });

  it("tier 与窗口仍参与分片", () => {
    expect(cacheKey(24, "realtime", null)).not.toBe(
      cacheKey(24, "delayed", null),
    );
    expect(cacheKey(6, "realtime", null)).not.toBe(
      cacheKey(24, "realtime", null),
    );
  });

  it("过滤判定与缓存分片口径一致:不限放行一切,受限只放行列内", () => {
    expect(busTypeAllowed(null, "consensus")).toBe(true);
    expect(busTypeAllowed(["large"], "consensus")).toBe(false);
  });
});
