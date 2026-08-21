import { describe, it, expect } from "vitest";
import { mergeWindow } from "./marketWindow";
import type { Trade } from "./types";

/** 只变 transactionHash —— dedupKey 的第一段,足以区分两笔。 */
export const trade = (ts: number, hash: string): Trade => ({
  proxyWallet: "0xa",
  side: "BUY",
  asset: "1",
  conditionId: "0xc1",
  size: 100,
  price: 0.5,
  timestamp: ts,
  title: "t",
  slug: "s",
  eventSlug: "e",
  outcome: "Yes",
  outcomeIndex: 0,
  transactionHash: hash,
});

describe("mergeWindow", () => {
  it("新成交并入既有窗口,结果按时间倒序", () => {
    const prev = [trade(200, "0xb"), trade(100, "0xa")];
    const out = mergeWindow(prev, [trade(300, "0xc")], 0);
    expect(out.map((t) => t.timestamp)).toEqual([300, 200, 100]);
  });

  it("重叠的成交只留一份 —— 续抓必然重复覆盖锚点那一笔", () => {
    const prev = [trade(200, "0xb")];
    const out = mergeWindow(prev, [trade(300, "0xc"), trade(200, "0xb")], 0);
    expect(out).toHaveLength(2);
  });

  it("滚动裁剪:超出窗口下界的尾部丢弃(窗口是滑动的,不是累积的)", () => {
    const prev = [trade(200, "0xb"), trade(100, "0xa")];
    const out = mergeWindow(prev, [], 150);
    expect(out.map((t) => t.timestamp)).toEqual([200]);
  });

  it("空续抓只做裁剪,不动既有内容", () => {
    const prev = [trade(200, "0xb")];
    expect(mergeWindow(prev, [], 0)).toHaveLength(1);
  });
});
