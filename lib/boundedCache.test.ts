import { describe, it, expect, vi, afterEach } from "vitest";
import { createBoundedCache } from "./boundedCache";

afterEach(() => {
  vi.useRealTimers();
});

describe("createBoundedCache", () => {
  it("serves within the TTL and misses after expiry", () => {
    vi.useFakeTimers();
    const c = createBoundedCache<string>(1000);
    c.set("k", "v");
    vi.advanceTimersByTime(999);
    expect(c.get("k")).toBe("v");
    vi.advanceTimersByTime(2);
    expect(c.get("k")).toBeUndefined();
  });

  it("未写入的键返回 undefined", () => {
    expect(createBoundedCache<string>(1000).get("nope")).toBeUndefined();
  });

  it("超过上限时逐出最老的键(地址可从公开榜单枚举,不能无界增长)", () => {
    const c = createBoundedCache<string>(60_000, 2);
    c.set("a", "1");
    c.set("b", "2");
    c.set("c", "3"); // 挤掉 a
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe("2");
    expect(c.get("c")).toBe("3");
  });

  it("刷新已有键会把它移到最新位置 —— 否则最热的键反而最先被逐出", () => {
    const c = createBoundedCache<string>(60_000, 2);
    c.set("hot", "1");
    c.set("cold", "2");
    c.set("hot", "1b"); // 刷新 hot:它应变成最新,cold 才是最老
    c.set("new", "3"); // 该逐出 cold
    expect(c.get("hot")).toBe("1b");
    expect(c.get("new")).toBe("3");
    expect(c.get("cold")).toBeUndefined();
  });

  it("两个实例各走各的 TTL —— /api/wallet 拆分 profile 与 holdings 的前提", () => {
    vi.useFakeTimers();
    const slow = createBoundedCache<string>(600_000); // profile:贵、慢变
    const fast = createBoundedCache<string>(60_000); // holdings:便宜、快变
    slow.set("w", "profile");
    fast.set("w", "holdings");
    vi.advanceTimersByTime(61_000);
    expect(slow.get("w")).toBe("profile"); // 仍新鲜,不该重拉 2000 笔成交
    expect(fast.get("w")).toBeUndefined(); // 已过期,持仓必须重新拉
  });
});
