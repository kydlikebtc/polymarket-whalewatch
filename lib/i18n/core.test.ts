import { describe, it, expect } from "vitest";
import { interpolate, pickLang, translate } from "./core";

describe("translate", () => {
  const dict = {
    已结算胜率: "Settled win rate",
    "共 {n} 笔": "{n} fills total",
  };
  it("zh 原样返回,en 查字典", () => {
    expect(translate(dict, "zh", "已结算胜率")).toBe("已结算胜率");
    expect(translate(dict, "en", "已结算胜率")).toBe("Settled win rate");
  });
  it("en 缺译回退中文(永不空串)", () => {
    expect(translate(dict, "en", "没有这条")).toBe("没有这条");
  });
  it("中英模板都做占位符插值;缺参数保留原占位符", () => {
    expect(translate(dict, "zh", "共 {n} 笔", { n: 5 })).toBe("共 5 笔");
    expect(translate(dict, "en", "共 {n} 笔", { n: 5 })).toBe("5 fills total");
    expect(interpolate("{a}+{b}", { a: 1 })).toBe("1+{b}");
  });
});

describe("pickLang", () => {
  it("cookie 显式值最优先", () => {
    expect(pickLang("en", "zh-CN")).toBe("en");
    expect(pickLang("zh", "en-US")).toBe("zh");
    expect(pickLang("junk", "en-US")).toBe("en");
  });
  it("无 cookie 按 Accept-Language:en 先于 zh 才选 en", () => {
    expect(pickLang(undefined, "en-US,en;q=0.9")).toBe("en");
    expect(pickLang(undefined, "en-US,zh-CN;q=0.8")).toBe("en");
    expect(pickLang(undefined, "zh-CN,en;q=0.8")).toBe("zh");
    expect(pickLang(undefined, "fr-FR")).toBe("zh");
    expect(pickLang(undefined, null)).toBe("zh");
  });
});
