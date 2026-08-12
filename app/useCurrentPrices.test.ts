import { describe, it, expect } from "vitest";
import { dedupeAssets, mergeCurrentPrices } from "./useCurrentPrices";

describe("dedupeAssets — 持仓当前价请求前的去重", () => {
  it("空数组 → 空数组", () => {
    expect(dedupeAssets([])).toEqual([]);
  });

  it("去重,保留首次出现的顺序", () => {
    expect(dedupeAssets(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  it("过滤 undefined/null/空字符串(老仓位或异常数据兜底)", () => {
    expect(dedupeAssets(["a", undefined, "", null, "b"])).toEqual(["a", "b"]);
  });

  it("12 档持仓大面积重叠场景:多个策略持有同一 token,只出现一次", () => {
    // 模拟「保守」「激进」两档都持有同一个市场(设计文档 §9.1 的重叠场景)。
    const assets = ["tokenA", "tokenB", "tokenA", "tokenC", "tokenB", "tokenA"];
    expect(dedupeAssets(assets)).toEqual(["tokenA", "tokenB", "tokenC"]);
  });

  it("不修改入参数组", () => {
    const input = ["a", "b", "a"];
    const snapshot = [...input];
    dedupeAssets(input);
    expect(input).toEqual(snapshot);
  });
});

describe("mergeCurrentPrices — /api/current-price 响应合并", () => {
  it("解析出一个 number 价格(成功,不重试)", () => {
    const r = mergeCurrentPrices(["t1"], { prices: { t1: 0.62 } });
    expect(r.prices).toEqual({ t1: 0.62 });
    expect(r.retry).toEqual([]);
  });

  it("显式 null 视为「已解析为失败」(不重试)——取价失败/无数据的 token 不能被当成网络故障反复重试", () => {
    // 这是这个函数存在的核心理由:mock token 或太新太冷的市场,服务端已经
    // 明确问过 CLOB 拿不到价,前端必须稳定显示「—」,不能无限期显示「加载
    // 中」等一个永远不会来的重试。
    const r = mergeCurrentPrices(["t1"], { prices: { t1: null } });
    expect(r.prices).toEqual({ t1: null });
    expect(r.retry).toEqual([]);
  });

  it("响应里完全缺失某 asset → 需要重试(区别于显式 null)", () => {
    const r = mergeCurrentPrices(["t1", "t2"], { prices: { t1: 0.5 } });
    expect(r.prices).toEqual({ t1: 0.5 });
    expect(r.retry).toEqual(["t2"]);
  });

  it("响应格式异常(没有 prices 字段)→ 全部重试", () => {
    const r = mergeCurrentPrices(["t1", "t2"], {});
    expect(r.prices).toEqual({});
    expect(r.retry).toEqual(["t1", "t2"]);
  });

  it("混合批次:number 成功、null 成功、缺失重试,三种结果互不干扰", () => {
    const r = mergeCurrentPrices(["ok", "empty", "fail"], {
      prices: { ok: 0.73, empty: null },
    });
    expect(r.prices).toEqual({ ok: 0.73, empty: null });
    expect(r.retry).toEqual(["fail"]);
  });

  it("0 是合法价格(不是 falsy 兜底成失败)——0.0 与「取价失败」的 null 必须区分", () => {
    const r = mergeCurrentPrices(["t1"], { prices: { t1: 0 } });
    expect(r.prices).toEqual({ t1: 0 });
    expect(r.retry).toEqual([]);
  });
});
