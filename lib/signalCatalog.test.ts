import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { buildSignalCatalog } from "./signalCatalog";
import { createBusDef, updateBusDef } from "./busDefs";
import { KEY_SCOPES } from "./keyScopes";

function freshDb() {
  return openDb(":memory:");
}

/** 放开一档并返回它的 code(种子 19 档都有码)。 */
function publish(db: ReturnType<typeof freshDb>, name: string) {
  db.prepare(
    "UPDATE follow_strategies SET push_enabled = 1 WHERE name = ?",
  ).run(name);
}

describe("buildSignalCatalog", () => {
  it("全新库:什么都没开 → 两段都是空数组(形状仍完整)", () => {
    const db = freshDb();
    try {
      const c = buildSignalCatalog(db, { scopes: null });
      // 种子建了 19 档但 push_enabled 默认 0;bus_defs 空表。名录该说
      // 「你什么都收不到」,而不是把系统能力全集端出去。
      expect(c).toEqual({ bus: [], strategy: [] });
    } finally {
      db.close();
    }
  });

  it("① 只列启用的定义,给 type + threshold(不给中文 label,也不给 id)", () => {
    const db = freshDb();
    try {
      createBusDef(db, {
        sourceType: "large",
        label: "大额 ≥$50k",
        threshold: 50_000,
      });
      const off = createBusDef(db, {
        sourceType: "large",
        label: "巨额 ≥$500k",
        threshold: 500_000,
      });
      updateBusDef(db, off, { enabled: false });

      const c = buildSignalCatalog(db, { scopes: null });
      expect(c.bus).toEqual([{ type: "large", threshold: 50_000 }]);

      // 名录是拿来写代码的:中文 label 会诱导硬编码会变的文案,
      // 自增 id 换个部署就指向另一档(§8.3 否掉 strategy.id 的同一个坑)。
      const json = JSON.stringify(c);
      expect(json).not.toContain("大额");
      expect(json).not.toContain("label");
      expect(json).not.toContain("id");
    } finally {
      db.close();
    }
  });

  it("① 同一 type 的多档各占一行 —— threshold 是去掉中文名后唯一的判别键", () => {
    const db = freshDb();
    try {
      createBusDef(db, { sourceType: "large", label: "A", threshold: 50_000 });
      createBusDef(db, { sourceType: "large", label: "B", threshold: 500_000 });
      const c = buildSignalCatalog(db, { scopes: null });
      expect(c.bus).toEqual([
        { type: "large", threshold: 50_000 },
        { type: "large", threshold: 500_000 },
      ]);
    } finally {
      db.close();
    }
  });

  it("② 只列已发布的档,给 code + source", () => {
    const db = freshDb();
    try {
      publish(db, "超级巨鲸");
      publish(db, "首发共识");
      const c = buildSignalCatalog(db, { scopes: null });
      expect(c.strategy).toEqual([
        { code: "first_mover_consensus", source: "consensus" },
        { code: "mega_whale", source: "heavy" },
      ]);
      // 中文档名不出现 —— 与 ① 同一条纪律。
      expect(JSON.stringify(c)).not.toContain("巨鲸");
    } finally {
      db.close();
    }
  });

  it("② 按 code 排序,不按部署本地的 id —— 名录的顺序必须跨部署稳定", () => {
    const db = freshDb();
    try {
      publish(db, "超级巨鲸");
      publish(db, "激进");
      publish(db, "保守");
      const codes = buildSignalCatalog(db, { scopes: null }).strategy.map(
        (s) => s.code,
      );
      expect(codes).toEqual([...codes].sort());
    } finally {
      db.close();
    }
  });

  // --- 订阅范围(越权面) ---------------------------------------------------

  it("scopes=null(未限定)拿全部", () => {
    const db = freshDb();
    try {
      createBusDef(db, { sourceType: "large", label: "A", threshold: 1 });
      createBusDef(db, { sourceType: "consensus", label: "B", threshold: 2 });
      publish(db, "超级巨鲸");
      const c = buildSignalCatalog(db, { scopes: null });
      expect(c.bus.map((b) => b.type)).toEqual(["consensus", "large"]);
      expect(c.strategy).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("只订 large 的 key:consensus 与 strategy 都不出现在名录里", () => {
    const db = freshDb();
    try {
      createBusDef(db, { sourceType: "large", label: "A", threshold: 1 });
      createBusDef(db, { sourceType: "consensus", label: "B", threshold: 2 });
      createBusDef(db, { sourceType: "discovery", label: "C", threshold: 3 });
      publish(db, "超级巨鲸");

      const c = buildSignalCatalog(db, { scopes: ["large"] });
      expect(c.bus).toEqual([{ type: "large", threshold: 1 }]);
      // 名录必须与 /api/signals 的实际投递一致:那边 keyAllows 过滤掉的东西,
      // 这边列出来就是在承诺一份收不到的信号。
      expect(c.strategy).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("只订 strategy 的 key:① 整段为空", () => {
    const db = freshDb();
    try {
      createBusDef(db, { sourceType: "large", label: "A", threshold: 1 });
      publish(db, "超级巨鲸");
      const c = buildSignalCatalog(db, { scopes: ["strategy"] });
      expect(c.bus).toEqual([]);
      expect(c.strategy).toEqual([{ code: "mega_whale", source: "heavy" }]);
    } finally {
      db.close();
    }
  });

  it("订了但运营没开:仍然不出现 —— 名录承诺的是「真收得到」", () => {
    const db = freshDb();
    try {
      // 范围给足,但一个定义都没建、一档都没放开。
      const c = buildSignalCatalog(db, {
        scopes: ["large", "consensus", "discovery", "strategy"],
      });
      expect(c).toEqual({ bus: [], strategy: [] });
    } finally {
      db.close();
    }
  });

  // --- 守卫 ---------------------------------------------------------------

  it("名录里的 bus.type 必须都在 key 权限域内(漏同步守卫)", () => {
    const db = freshDb();
    try {
      for (const t of ["large", "consensus", "discovery"] as const) {
        createBusDef(db, { sourceType: t, label: t, threshold: 1 });
      }
      const c = buildSignalCatalog(db, { scopes: null });
      // 列出一个 keyAllows 判不了的类型 = 列了一个没人能订阅、也过滤不掉的
      // 信号。lib/keyScopes 加了范围却忘了这里(或反之),这条立刻红。
      for (const b of c.bus) expect(KEY_SCOPES).toContain(b.type);
    } finally {
      db.close();
    }
  });
});
