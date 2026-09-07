import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TG_KINDS, TG_KINDS } from "../../lib/tgTargets";

// 投递种类 ↔ 运营页勾选清单 的同步守卫。
//
// 存在理由是一次真实的漏改:`cohort`(同批新钱包)2026-08-28 随数据层一起
// 上线,但 app/manage/TgTargetsSection 里那份**手抄的** KINDS 清单没跟上 ——
// 于是运营页上根本勾不到它,一个已经写好、测过、部署了的能力在产品上不可达
// 整整十天。数据层加一行、运营页忘一行,没有任何东西会红。
//
// 判定材料取组件源码里的 KINDS 字面量:那份清单决定了页面上渲染出几个复选框,
// 是「运营者能不能打开这个能力」的唯一真相。

const SRC = readFileSync(
  join(process.cwd(), "app", "manage", "TgTargetsSection.tsx"),
  "utf8",
);

function uiKinds(): string[] {
  // `{ kind: "large", label: … }` 里的 kind 字面量。
  const re = /\{\s*kind:\s*"([a-z_]+)"/g;
  return [...SRC.matchAll(re)].map((m) => m[1]);
}

describe("TG 投递种类 ↔ /manage 勾选清单", () => {
  it("扫得到组件里的 KINDS 清单(正则没被重构改废)", () => {
    expect(uiKinds().length).toBeGreaterThanOrEqual(4);
  });

  it("每一种投递类型在运营页上都勾得到 —— 否则那个能力不可达", () => {
    const ui = new Set(uiKinds());
    for (const kind of Object.keys(DEFAULT_TG_KINDS)) {
      expect(
        ui.has(kind),
        `投递类型「${kind}」没有出现在 /manage 的勾选清单里 —— 运营者打不开它,这个能力实际不存在(cohort 就这样藏了十天)`,
      ).toBe(true);
    }
  });

  it("运营页不该出现数据层没有的类型(反向:抄错名字等于永远勾不上)", () => {
    const known = new Set(Object.keys(DEFAULT_TG_KINDS));
    for (const kind of uiKinds()) {
      expect(known.has(kind), `运营页列了未知类型「${kind}」`).toBe(true);
    }
  });

  it("数据层的 TG_KINDS 说明表本身也覆盖全部类型", () => {
    // 这张表喂的是 API 响应里的类型说明;漏一项 = 运营者看不到它是干什么的。
    const documented = new Set(TG_KINDS.map((k) => k.kind));
    for (const kind of Object.keys(DEFAULT_TG_KINDS)) {
      expect(documented.has(kind as never), `TG_KINDS 缺少「${kind}」`).toBe(
        true,
      );
    }
  });

  it("新能力默认关 —— 内容引擎三类与 cohort 都不该出厂就推", () => {
    // 「新增种类一律默认关,运营者显式勾选才推」是 2026-08-28 立的规矩,
    // 这里把它钉死,免得下一个新类型顺手默认开。
    for (const kind of ["cohort", "pulse", "scorecard", "weekly"] as const) {
      expect(DEFAULT_TG_KINDS[kind], `「${kind}」出厂应为关`).toBe(false);
    }
  });
});
