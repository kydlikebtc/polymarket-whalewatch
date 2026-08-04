import { describe, it, expect } from "vitest";
import { parseFeeSchedule, takerFeeUsd, type FeeSchedule } from "./fees";

// 实测形状(2026-08-04,gamma /markets 头部 100 市场):
// {"exponent":1,"rate":0.05,"takerOnly":true,"rebateRate":0.15}
const LIVE: FeeSchedule = {
  exponent: 1,
  rate: 0.05,
  takerOnly: true,
  rebateRate: 0.15,
};

const buy = (over: Partial<Parameters<typeof takerFeeUsd>[0]> = {}) =>
  takerFeeUsd({
    sizeUsd: 500,
    price: 0.5,
    feesEnabled: true,
    schedule: LIVE,
    ...over,
  });

describe("parseFeeSchedule", () => {
  it("解析实测返回的形状", () => {
    expect(
      parseFeeSchedule({
        exponent: 1,
        rate: 0.05,
        takerOnly: true,
        rebateRate: 0.15,
      }),
    ).toEqual(LIVE);
  });

  it("rebateRate 缺失可接受（是 maker 返佣，与吃单方无关）", () => {
    expect(
      parseFeeSchedule({ exponent: 1, rate: 0.05, takerOnly: true })
        ?.rebateRate,
    ).toBeNull();
  });

  it("rate/exponent 缺失或非数 → null（不猜）", () => {
    expect(parseFeeSchedule({ exponent: 1 })).toBeNull();
    expect(parseFeeSchedule({ rate: 0.05 })).toBeNull();
    expect(parseFeeSchedule({ exponent: "1", rate: "0.05" })).toBeNull();
  });

  it("null / 非对象 / 坏 JSON → null", () => {
    expect(parseFeeSchedule(null)).toBeNull();
    expect(parseFeeSchedule(undefined)).toBeNull();
    expect(parseFeeSchedule("{}")).toBeNull();
    expect(parseFeeSchedule(42)).toBeNull();
  });

  it("负 rate 视为坏数据 → null", () => {
    expect(parseFeeSchedule({ exponent: 1, rate: -0.05 })).toBeNull();
  });
});

describe("takerFeeUsd", () => {
  it("实测口径：$500 @0.5 · rate 0.05 → $12.50（名义额 2.5%）", () => {
    expect(buy()).toBeCloseTo(12.5, 6);
  });

  it("越接近确定的票越便宜：$500 @0.9 → $2.50（0.5%）", () => {
    expect(buy({ price: 0.9 })).toBeCloseTo(2.5, 6);
  });

  it("定额买单的闭式 = sizeUsd × rate × (1−p)，与逐股口径等价", () => {
    // shares = sizeUsd/p,fee = shares × rate × p(1−p) = sizeUsd × rate × (1−p)。
    // 结论:对固定名义金额,费率与 p 成线性反比 —— 越便宜的票相对费率越高。
    for (const p of [0.05, 0.2, 0.37, 0.5, 0.68, 0.95]) {
      expect(buy({ price: p })).toBeCloseTo(500 * LIVE.rate * (1 - p), 9);
    }
  });

  it("定额买单的费用随 p 单调递减 —— 冷门票才是贵的那一批", () => {
    // 反直觉点:公式里的 p(1−p) 在 0.5 处最大,但那是「每股」的形状。定额买单
    // 的股数 = sizeUsd/p 随 p 变小而变大,两个效应合并后是 rate×(1−p) 的线性
    // 递减。$500 在 0.2 要 $20(4%),在 0.5 只要 $12.5(2.5%)。
    const fees = [0.1, 0.3, 0.5, 0.7, 0.9].map((p) => buy({ price: p })!);
    for (let i = 1; i < fees.length; i++) {
      expect(fees[i]).toBeLessThan(fees[i - 1]);
    }
    expect(buy({ price: 0.2 })).toBeCloseTo(20);
  });

  it("feesEnabled=false → 0（这个市场是真免费，不是未知）", () => {
    expect(buy({ feesEnabled: false, schedule: null })).toBe(0);
  });

  it("feesEnabled=true 但费率表缺失 → null（未知，绝不当 0）", () => {
    expect(buy({ schedule: null })).toBeNull();
  });

  it("exponent ≠ 1 → null（样本里恒为 1，未观测的形态不猜）", () => {
    expect(buy({ schedule: { ...LIVE, exponent: 2 } })).toBeNull();
  });

  it("价格越界 / 非有限 → null", () => {
    for (const price of [0, 1, -0.1, 1.5, NaN, Infinity]) {
      expect(buy({ price })).toBeNull();
    }
  });

  it("金额非正或非有限 → null", () => {
    for (const sizeUsd of [0, -100, NaN]) {
      expect(buy({ sizeUsd })).toBeNull();
    }
  });

  it("takerOnly=false 仍然计费 —— 我们恒为吃单方", () => {
    expect(buy({ schedule: { ...LIVE, takerOnly: false } })).toBeCloseTo(12.5);
  });

  it("rebateRate 不参与计算（maker 返佣，与吃单成本无关）", () => {
    expect(buy({ schedule: { ...LIVE, rebateRate: 0.9 } })).toBeCloseTo(12.5);
  });
});
