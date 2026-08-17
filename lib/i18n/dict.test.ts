import { describe, it, expect } from "vitest";
import { DICT } from "./dict";

// 字典卫生:三条规则挡住三类真实事故 ——
//  1. 空译文 → 英文界面出现空洞;
//  2. 译文=原文 → 假翻译(键值抄反或占位没删);
//  3. 占位符集合不一致 → 英文丢变量({n} 消失,数字不见)。
function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe("DICT hygiene", () => {
  const entries = Object.entries(DICT);
  it("has entries", () => {
    expect(entries.length).toBeGreaterThan(0);
  });
  it("no empty translations", () => {
    const empty = entries.filter(([, v]) => v.trim() === "");
    expect(empty.map(([k]) => k)).toEqual([]);
  });
  it("no value === key fake translations (只查含汉字的键 —— 语言中立键天然同形)", () => {
    const fake = entries.filter(([k, v]) => k === v && /[一-鿿]/.test(k));
    expect(fake.map(([k]) => k)).toEqual([]);
  });
  it("placeholder sets match between zh key and en value", () => {
    const mismatched = entries.filter(
      ([k, v]) =>
        JSON.stringify(placeholders(k)) !== JSON.stringify(placeholders(v)),
    );
    expect(mismatched.map(([k]) => k)).toEqual([]);
  });
});
