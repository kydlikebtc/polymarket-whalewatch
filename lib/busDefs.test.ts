import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import {
  createBusDef,
  deleteBusDef,
  listBusDefs,
  matchedDefs,
  projectionFloor,
  seedBusDefs,
  updateBusDef,
} from "./busDefs";
import { setBusSettings, DEFAULT_BUS_SETTINGS } from "./signalBus";

describe("busDefs · CRUD 与匹配", () => {
  it("同一类型可建多档,各自阈值独立", () => {
    const db = openDb(":memory:");
    createBusDef(db, { sourceType: "large", label: "大额", threshold: 50_000 });
    createBusDef(db, {
      sourceType: "large",
      label: "巨额",
      threshold: 500_000,
    });
    const defs = listBusDefs(db).filter((d) => d.sourceType === "large");
    expect(defs.map((d) => [d.label, d.threshold])).toEqual([
      ["大额", 50_000],
      ["巨额", 500_000],
    ]);
  });

  it("matchedDefs:事件按值命中各档(≥ 下限);未启用的档不参与", () => {
    const db = openDb(":memory:");
    const a = createBusDef(db, {
      sourceType: "large",
      label: "大额",
      threshold: 50_000,
    });
    const b = createBusDef(db, {
      sourceType: "large",
      label: "巨额",
      threshold: 500_000,
    });
    const defs = listBusDefs(db);
    expect(
      matchedDefs(defs, "large", { usd: 120_000 }).map((d) => d.id),
    ).toEqual([a]);
    expect(
      matchedDefs(defs, "large", { usd: 900_000 }).map((d) => d.id),
    ).toEqual([a, b]);
    updateBusDef(db, a, { enabled: false });
    expect(
      matchedDefs(listBusDefs(db), "large", { usd: 900_000 }).map((d) => d.id),
    ).toEqual([b]);
  });

  it("projectionFloor = 启用档的最小阈值;无启用档 = null(类型关)", () => {
    const db = openDb(":memory:");
    expect(projectionFloor(listBusDefs(db), "large")).toBeNull();
    const a = createBusDef(db, {
      sourceType: "large",
      label: "大额",
      threshold: 50_000,
    });
    createBusDef(db, {
      sourceType: "large",
      label: "巨额",
      threshold: 500_000,
    });
    expect(projectionFloor(listBusDefs(db), "large")).toBe(50_000);
    updateBusDef(db, a, { enabled: false });
    expect(projectionFloor(listBusDefs(db), "large")).toBe(500_000);
  });

  it("delete 后不再匹配;update 可改名/改阈值", () => {
    const db = openDb(":memory:");
    const id = createBusDef(db, {
      sourceType: "consensus",
      label: "共识",
      threshold: 2,
    });
    expect(updateBusDef(db, id, { label: "强共识", threshold: 4 })).toBe(true);
    const [d] = listBusDefs(db);
    expect([d.label, d.threshold]).toEqual(["强共识", 4]);
    expect(deleteBusDef(db, id)).toBe(true);
    expect(listBusDefs(db)).toHaveLength(0);
  });

  it("payload 取不出比较值 → 不匹配任何档(不猜)", () => {
    const db = openDb(":memory:");
    createBusDef(db, { sourceType: "large", label: "默认", threshold: 0 });
    expect(matchedDefs(listBusDefs(db), "large", { side: "BUY" })).toEqual([]);
  });
});

describe("busDefs · legacy 迁移", () => {
  it("旧设置里 enabled 的类型迁成「默认」档,阈值保留;关的不建", () => {
    const db = openDb(":memory:");
    setBusSettings(db, {
      ...DEFAULT_BUS_SETTINGS,
      large: { enabled: true, minUsd: 77_000 },
      consensus: { enabled: false, minWallets: 2 },
    });
    seedBusDefs(db, 1000);
    const defs = listBusDefs(db);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({
      sourceType: "large",
      label: "默认",
      threshold: 77_000,
      enabled: true,
    });
  });

  it("迁移只跑一次:删光定义后再 list 不会复活旧设置", () => {
    const db = openDb(":memory:");
    setBusSettings(db, {
      ...DEFAULT_BUS_SETTINGS,
      large: { enabled: true, minUsd: 77_000 },
    });
    const [d] = listBusDefs(db);
    deleteBusDef(db, d.id);
    expect(listBusDefs(db)).toHaveLength(0);
  });

  it("全关的旧设置(生产现状)→ 空表,零行为变化", () => {
    const db = openDb(":memory:");
    expect(listBusDefs(db)).toHaveLength(0);
  });
});
