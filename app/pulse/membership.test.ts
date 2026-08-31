import { describe, it, expect } from "vitest";
import { buildMembership, otherTags } from "./membership";
import type { MembershipSource } from "./membership";

// /pulse 跨榜标记的归并规则。这层逻辑决定「异常日榜里的某一行要不要挂一个
// 『洗量』chip」—— 分段标签页一次只渲染一个榜,挂错或漏挂都不会有任何报错,
// 只会安静地给出错误的跨榜印象,所以规则得被钉住。

// 只取 conditionId 有意义,其余字段给足类型即可。
const mk = (id: string) => ({ conditionId: id }) as never;

function src(p: {
  top?: string[];
  divergences?: string[];
  ghosts?: string[];
  washTop?: string[];
}): MembershipSource {
  return {
    top: (p.top ?? []).map(mk),
    divergences: (p.divergences ?? []).map(mk),
    ghosts: (p.ghosts ?? []).map(mk),
    washTop: (p.washTop ?? []).map(mk),
  };
}

describe("buildMembership", () => {
  it("单个榜的市场只带自己那一个标记", () => {
    const m = buildMembership(src({ top: ["a"] }));
    expect(m.get("a")).toEqual(["anomaly"]);
  });

  it("同时上多个榜的市场把标记合并到一行", () => {
    const m = buildMembership(src({ ghosts: ["a"], washTop: ["a"] }));
    expect(m.get("a")).toEqual(["ghost", "wash"]);
  });

  it("标记顺序固定为漏斗顺序,与市场在各榜里的位置无关", () => {
    // 同一个市场在四个榜里的下标各不相同 —— 顺序若跟着插入位置走,同一个
    // 市场在不同榜上就会看到不同排列的 chip。
    const m = buildMembership(
      src({
        top: ["x", "a"],
        divergences: ["a"],
        ghosts: ["y", "z", "a"],
        washTop: ["a"],
      }),
    );
    expect(m.get("a")).toEqual(["anomaly", "divergence", "ghost", "wash"]);
  });

  it("没上任何榜的市场查不到,不是空数组", () => {
    const m = buildMembership(src({ top: ["a"] }));
    expect(m.get("b")).toBeUndefined();
  });

  it("ghosts/washTop 缺席时不炸 —— 缓存里的旧 payload 没有这两个 additive 键", () => {
    const m = buildMembership({
      top: [mk("a")],
      divergences: [],
    });
    expect(m.get("a")).toEqual(["anomaly"]);
  });

  it("同一个榜里重复出现的 id 不会产生重复标记", () => {
    const m = buildMembership(src({ washTop: ["a", "a"] }));
    expect(m.get("a")).toEqual(["wash"]);
  });
});

describe("otherTags", () => {
  it("剔除当前所在的榜 —— 你已经在看它了,标题就写着", () => {
    const m = buildMembership(src({ top: ["a"], washTop: ["a"] }));
    expect(otherTags(m, "a", "anomaly")).toEqual(["wash"]);
    expect(otherTags(m, "a", "wash")).toEqual(["anomaly"]);
  });

  it("只上了当前这一个榜就没有任何跨榜标记", () => {
    const m = buildMembership(src({ top: ["a"] }));
    expect(otherTags(m, "a", "anomaly")).toEqual([]);
  });

  it("查不到的 id 返回空数组而不是 undefined —— 调用方直接 .map 渲染", () => {
    const m = buildMembership(src({ top: ["a"] }));
    expect(otherTags(m, "nope", "anomaly")).toEqual([]);
  });
});
