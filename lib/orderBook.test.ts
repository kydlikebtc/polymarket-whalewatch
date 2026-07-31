import { describe, it, expect } from "vitest";
import { parseAskBook, simulateBookBuy } from "./orderBook";

// 实测事实(2026-07-31 live curl):CLOB GET /book 返回的 bids/asks 是
// {price:string,size:string}[],且**由外向内排序 —— 最优档在数组末尾**
// (asks 从 0.99 降到 0.61)。解析层必须防御性重排,否则模拟吃单会先吃最差档。

describe("parseAskBook", () => {
  it("实测形状:字符串数字化 + 由外向内(降序)→ 升序重排,最优价在前", () => {
    const book = parseAskBook({
      asks: [
        { price: "0.99", size: "565005" },
        { price: "0.98", size: "756198.62" },
        { price: "0.61", size: "5808.64" },
      ],
    });
    expect(book).not.toBeNull();
    expect(book!.asks.map((l) => l.price)).toEqual([0.61, 0.98, 0.99]);
    expect(book!.asks[0].size).toBeCloseTo(5808.64);
  });

  it("乱序输入同样升序化(不依赖任何来路顺序)", () => {
    const book = parseAskBook({
      asks: [
        { price: "0.5", size: "10" },
        { price: "0.3", size: "10" },
        { price: "0.7", size: "10" },
      ],
    });
    expect(book!.asks.map((l) => l.price)).toEqual([0.3, 0.5, 0.7]);
  });

  it("坏档位剔除:非数字/非正 price/size 不进簿", () => {
    const book = parseAskBook({
      asks: [
        { price: "0.5", size: "10" },
        { price: "abc", size: "10" },
        { price: "0.4", size: "0" },
        { price: "-0.1", size: "5" },
        { price: "0.6" }, // size 缺失
      ],
    });
    expect(book!.asks).toEqual([{ price: 0.5, size: 10 }]);
  });

  it("形状不对(缺 asks / 非对象 / asks 非数组)→ null", () => {
    expect(parseAskBook(null)).toBeNull();
    expect(parseAskBook({})).toBeNull();
    expect(parseAskBook({ asks: "nope" })).toBeNull();
  });

  it("asks 为空数组 → 保留空簿(由模拟层判定不可成交)", () => {
    expect(parseAskBook({ asks: [] })!.asks).toEqual([]);
  });
});

describe("simulateBookBuy", () => {
  it("单档吃满:$500 @ 0.61 × 深度足够 → 均价即档价,份额=500/0.61", () => {
    const fill = simulateBookBuy([{ price: 0.61, size: 5808 }], 500);
    expect(fill).not.toBeNull();
    expect(fill!.avgPrice).toBeCloseTo(0.61);
    expect(fill!.filledUsd).toBeCloseTo(500);
    expect(fill!.shares).toBeCloseTo(500 / 0.61);
  });

  it("跨档吃单:先吃最优档再吃次档,均价按耗资加权", () => {
    // 档1: 0.50 × 400 份额 = $200;剩 $300 吃 0.60 档 → 500 份额
    const fill = simulateBookBuy(
      [
        { price: 0.5, size: 400 },
        { price: 0.6, size: 100000 },
      ],
      500,
    );
    const shares = 400 + 300 / 0.6;
    expect(fill!.filledUsd).toBeCloseTo(500);
    expect(fill!.shares).toBeCloseTo(shares);
    expect(fill!.avgPrice).toBeCloseTo(500 / shares); // ≈0.5556,介于两档之间
  });

  it("薄盘部分成交:全簿吃穿仍不够 → filledUsd < 目标,均价按已成交部分", () => {
    const fill = simulateBookBuy(
      [
        { price: 0.4, size: 100 }, // $40
        { price: 0.5, size: 100 }, // $50
      ],
      500,
    );
    expect(fill!.filledUsd).toBeCloseTo(90);
    expect(fill!.shares).toBeCloseTo(200);
    expect(fill!.avgPrice).toBeCloseTo(90 / 200);
  });

  it("空簿 / 非正目标金额 → null", () => {
    expect(simulateBookBuy([], 500)).toBeNull();
    expect(simulateBookBuy([{ price: 0.5, size: 10 }], 0)).toBeNull();
    expect(simulateBookBuy([{ price: 0.5, size: 10 }], -5)).toBeNull();
  });
});
