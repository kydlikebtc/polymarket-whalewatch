import { describe, expect, it } from "vitest";
import { catLabel, catLabelFine, subLabel } from "./categoryLabel";

describe("catLabel(自 ui.tsx 移入,行为不变)", () => {
  it("已知一级译中,未知原样透传,空值归「其他」", () => {
    expect(catLabel("Sports")).toBe("体育");
    expect(catLabel("Crypto")).toBe("加密");
    expect(catLabel("Chess")).toBe("Chess"); // 税法随时间增长,未知透传
    expect(catLabel(null)).toBe("其他");
    expect(catLabel(undefined)).toBe("其他");
    expect(catLabel("")).toBe("其他");
  });
});

describe("subLabel", () => {
  it("已知二级译中,联盟缩写原样,未知透传", () => {
    expect(subLabel("Soccer")).toBe("足球");
    expect(subLabel("Tennis")).toBe("网球");
    expect(subLabel("Bitcoin")).toBe("比特币");
    expect(subLabel("Geopolitics")).toBe("地缘政治");
    expect(subLabel("NBA")).toBe("NBA"); // 拉丁缩写无需译
    expect(subLabel("Formula 1")).toBe("F1");
    expect(subLabel("Unknown League")).toBe("Unknown League");
  });
});

describe("catLabelFine(合成「一级·二级」)", () => {
  it("有二级 → 「体育·NBA」;无二级 → 只一级", () => {
    expect(catLabelFine("Sports", "NBA")).toBe("体育·NBA");
    expect(catLabelFine("Sports", "Soccer")).toBe("体育·足球");
    expect(catLabelFine("Crypto", "Bitcoin")).toBe("加密·比特币");
    expect(catLabelFine("Sports", null)).toBe("体育");
    expect(catLabelFine("Sports", undefined)).toBe("体育");
    expect(catLabelFine("Sports", "")).toBe("体育");
  });

  it("二级译名与一级相同 → 只显示一次(不出「电竞·电竞」)", () => {
    // Esports 事件的一级可能是 Sports(带 Esports 二级)或 Esports 本身;
    // 后者派生层已跳过同名,这里防的是译名撞车(两个 EN 标签译到同一中文)。
    expect(catLabelFine("Esports", "Esports")).toBe("电竞");
  });

  it("一级缺失但有二级 → 「其他·二级」照常合成(信息不丢)", () => {
    expect(catLabelFine(null, "NBA")).toBe("其他·NBA");
  });
});
