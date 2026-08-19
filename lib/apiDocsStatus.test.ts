import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { buildApiDocsStatus } from "./apiDocsStatus";
import { setBusSettings, getBusSettings } from "./signalBus";
import { DIGEST_DAY_KEY } from "./signalDigest";

function freshDb() {
  return openDb(":memory:");
}

describe("buildApiDocsStatus", () => {
  it("只列出 push_enabled 的档位(默认种子全部未放开 → 空数组)", () => {
    const db = freshDb();
    try {
      const s = buildApiDocsStatus(db);
      // 种子建了 19 档,但 push_enabled 默认 0 —— 文档该说「当前没有对外发布」,
      // 而不是把 19 档都端给订阅方。
      expect(s.strategies).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("放开一档后立刻出现在状态里(这就是它取代手写快照的意义)", () => {
    const db = freshDb();
    try {
      db.prepare(
        "UPDATE follow_strategies SET push_enabled = 1 WHERE name = '激进'",
      ).run();
      const s = buildApiDocsStatus(db);
      expect(s.strategies.map((x) => x.name)).toEqual(["激进"]);
      expect(s.strategies[0].id).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("多档按 id 升序", () => {
    const db = freshDb();
    try {
      db.prepare(
        "UPDATE follow_strategies SET push_enabled = 1 WHERE name IN ('保守','巨鲸')",
      ).run();
      const s = buildApiDocsStatus(db);
      const ids = s.strategies.map((x) => x.id);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(s.strategies.map((x) => x.name)).toEqual(["保守", "巨鲸"]);
    } finally {
      db.close();
    }
  });

  it("总线三类默认全关", () => {
    const db = freshDb();
    try {
      const s = buildApiDocsStatus(db);
      expect(s.busTypes.map((b) => b.type)).toEqual([
        "large",
        "consensus",
        "discovery",
      ]);
      expect(s.busTypes.every((b) => !b.enabled)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("开启某一类后只有它变 true", () => {
    const db = freshDb();
    try {
      const next = getBusSettings(db);
      next.large.enabled = true;
      setBusSettings(db, next);
      const s = buildApiDocsStatus(db);
      expect(s.busTypes.find((b) => b.type === "large")!.enabled).toBe(true);
      expect(s.busTypes.find((b) => b.type === "consensus")!.enabled).toBe(
        false,
      );
    } finally {
      db.close();
    }
  });

  it("不输出阈值 —— /api-docs 是公开页,规则集不外泄", () => {
    const db = freshDb();
    try {
      const next = getBusSettings(db);
      next.large.enabled = true;
      next.large.minUsd = 123456;
      setBusSettings(db, next);
      const json = JSON.stringify(buildApiDocsStatus(db));
      expect(json).not.toContain("123456");
      expect(json).not.toContain("minUsd");
    } finally {
      db.close();
    }
  });

  it("存证日:未生成为 null,生成后回显", () => {
    const db = freshDb();
    try {
      expect(buildApiDocsStatus(db).digestDay).toBeNull();
      db.prepare(
        "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
      ).run(DIGEST_DAY_KEY, "2026-08-19");
      expect(buildApiDocsStatus(db).digestDay).toBe("2026-08-19");
    } finally {
      db.close();
    }
  });
});
