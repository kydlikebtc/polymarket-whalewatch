import { describe, expect, it } from "vitest";
import {
  CircuitBreaker,
  CHANNEL_ERROR_THRESHOLD,
  PROBE_INTERVAL_MS,
} from "./breaker";

describe("CircuitBreaker", () => {
  it("默认闭合,允许消费", () => {
    expect(new CircuitBreaker().canRun(0)).toBe(true);
  });

  it(`连续 ${CHANNEL_ERROR_THRESHOLD} 次通道故障才跳闸`, () => {
    const b = new CircuitBreaker();
    for (let i = 1; i < CHANNEL_ERROR_THRESHOLD; i++) {
      b.recordChannelError(0);
      expect(b.canRun(0)).toBe(true);
    }
    b.recordChannelError(0);
    expect(b.canRun(0)).toBe(false);
    expect(b.isOpen()).toBe(true);
  });

  it("中间成功一次即清零 —— 偶发抖动不该攒成跳闸", () => {
    // 阈值管的是「持续性故障」(掉登录/DOM 改版),不是「偶尔一次超时」。
    const b = new CircuitBreaker();
    b.recordChannelError(0);
    b.recordChannelError(0);
    b.recordSuccess();
    b.recordChannelError(0);
    expect(b.canRun(0)).toBe(true);
  });

  it("跳闸后按探活间隔放行一次", () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < CHANNEL_ERROR_THRESHOLD; i++)
      b.recordChannelError(1000);
    expect(b.canRun(1000)).toBe(false);
    expect(b.canRun(1000 + PROBE_INTERVAL_MS - 1)).toBe(false);
    expect(b.canRun(1000 + PROBE_INTERVAL_MS)).toBe(true);
  });

  it("探活失败重新计时,不会每轮都放行", () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < CHANNEL_ERROR_THRESHOLD; i++)
      b.recordChannelError(1000);
    const probeAt = 1000 + PROBE_INTERVAL_MS;
    expect(b.canRun(probeAt)).toBe(true);
    b.recordChannelError(probeAt); // 探活也失败
    expect(b.canRun(probeAt + 1)).toBe(false);
    expect(b.canRun(probeAt + PROBE_INTERVAL_MS)).toBe(true);
  });

  it("探活成功即完全复位", () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < CHANNEL_ERROR_THRESHOLD; i++)
      b.recordChannelError(1000);
    b.recordSuccess();
    expect(b.isOpen()).toBe(false);
    expect(b.canRun(1001)).toBe(true);
  });

  it("暴露最近一条故障原因给 popup 显示", () => {
    const b = new CircuitBreaker();
    b.recordChannelError(0, "找不到 X 编辑器（多半是掉登录了）");
    expect(b.lastError()).toContain("掉登录");
  });
});
