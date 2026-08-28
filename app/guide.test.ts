import { describe, it, expect } from "vitest";
import { NAV } from "./nav";
import { STATIC_PAGES } from "./sitemap";
import { GUIDE_SECTIONS } from "./guide";

// 功能说明书防漏闸(设计文档 2026-08-28-feature-guide-design.md):
// 说明书的最大风险不是写错而是**漏写** —— 新页面进了导航/站点地图,
// 说明书却还停在旧版图。两条 ⊆ 断言让漏写直接红。

const navHrefs = NAV.flatMap((e) =>
  "items" in e ? e.items.map((i) => i.href) : [e.href],
);
const guideHrefs = GUIDE_SECTIONS.map((s) => s.href).filter(
  (h): h is string => h != null,
);

describe("guide 覆盖闸", () => {
  it("NAV 每个页面都有说明书条目(新页面进导航必须同步说明书)", () => {
    const missing = navHrefs.filter((h) => !guideHrefs.includes(h));
    expect(missing).toEqual([]);
  });

  it("sitemap 静态页每个都有说明书条目(公开页必须有说明)", () => {
    const missing = STATIC_PAGES.map((p) => p.path).filter(
      (p) => !guideHrefs.includes(p),
    );
    expect(missing).toEqual([]);
  });
});

describe("guide 结构卫生", () => {
  it("id 全站唯一且是合法锚点(kebab-case)", () => {
    const ids = GUIDE_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("href 非 null 时唯一(一个板块一节,不许拆双)", () => {
    expect(new Set(guideHrefs).size).toBe(guideHrefs.length);
  });

  it("每节三块齐全:功能/怎么用/怎么读各至少一条,且无空串", () => {
    for (const s of GUIDE_SECTIONS) {
      expect(s.title.trim(), s.id).not.toBe("");
      expect(s.tagline.trim(), s.id).not.toBe("");
      for (const block of [s.what, s.how, s.read]) {
        expect(block.length, s.id).toBeGreaterThan(0);
        for (const line of block) expect(line.trim(), s.id).not.toBe("");
      }
    }
  });

  it("「怎么读」是灵魂:每节 read 至少一条含口径/红线措辞", () => {
    // 诚实纪律的机器化底线:解读块必须出现口径类词汇之一,防止 read 退化
    // 成第二个功能列表。词表刻意宽松 —— 挡住的是零口径,不是审文风。
    const MARKERS = [
      "口径",
      "样本",
      "偏差",
      "区间",
      "≠",
      "不是",
      "红线",
      "纪律",
      "误读",
      "别把",
      "非投资建议",
      "运气",
    ];
    for (const s of GUIDE_SECTIONS) {
      const hit = s.read.some((line) => MARKERS.some((m) => line.includes(m)));
      expect(hit, `${s.id} 的 read 块缺少口径/红线声明`).toBe(true);
    }
  });
});
