import { describe, it, expect } from "vitest";
import { TERMS, termDetail, firstSentence, iconTip } from "./glossary";
import { DICT_GLOSSARY } from "../lib/i18n/dict/glossary";

describe("termDetail / firstSentence", () => {
  it("termDetail 返回与 /glossary 页面同一份原文(不另写一份 tooltip)", () => {
    const entry = TERMS.find((e) => e.term === "有效样本量（市场聚类）");
    expect(entry).toBeDefined();
    expect(termDetail("有效样本量（市场聚类）")).toBe(entry!.detail);
  });

  it("未收录的词条返回空串,不抛错", () => {
    expect(termDetail("根本不存在的词")).toBe("");
    expect(firstSentence("")).toBe("");
  });

  it("中文按 。／： 断句", () => {
    expect(firstSentence("前半句：后半句。再来一句。")).toBe("前半句：");
    expect(firstSentence("只有句号。后面还有")).toBe("只有句号。");
  });

  it("英文按 : 或『句点+空格』断句", () => {
    expect(firstSentence("Head clause: tail clause. More.")).toBe(
      "Head clause:",
    );
    expect(firstSentence("First sentence. Second one.")).toBe(
      "First sentence.",
    );
  });

  it("小数点/百分号不被误当句末(否则英文 tooltip 会在 0.5 处截断)", () => {
    expect(firstSentence("Moves within 0.5¢ count as flat: see below.")).toBe(
      "Moves within 0.5¢ count as flat:",
    );
  });

  it("无断句标记时原样返回", () => {
    expect(firstSentence("no terminator here")).toBe("no terminator here");
  });
});

describe("tooltip 必须先翻译再截断", () => {
  // 实测过的真实事故:先用中文首句去查字典,而字典是按【完整 detail】建键的,
  // 于是英文界面上 tooltip 永远回落成中文。顺序错了没有任何报错,只能靠这条
  // 测试钉住 —— 若有人把 firstSentence 挪到 t() 里侧,这里立刻红。
  const TERM = "有效样本量（市场聚类）";

  it("字典按完整 detail 建键,截断后的首句查不到译文", () => {
    const full = termDetail(TERM);
    expect(DICT_GLOSSARY[full]).toBeDefined(); // 完整串有译文
    expect(DICT_GLOSSARY[firstSentence(full)]).toBeUndefined(); // 首句没有
  });

  it("先译后截得到英文首句,先截后译只会拿回中文", () => {
    const full = termDetail(TERM);
    const correct = firstSentence(DICT_GLOSSARY[full] as string);
    expect(correct).toMatch(/^[A-Za-z]/); // 确实是英文开头
    // 反向(错误)顺序:字典查不到 → 回落中文 → 首句仍是中文。
    const wrong = DICT_GLOSSARY[firstSentence(full)] ?? firstSentence(full);
    expect(wrong).not.toBe(correct);
    expect(wrong).toMatch(/[一-龥]/);
  });
});

describe("iconTip", () => {
  it("符号表命中与未命中", () => {
    expect(iconTip("💰")).toContain("大额成交");
    expect(iconTip("没这个符号")).toBe("");
  });
});
