import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import {
  DEFAULT_CARD_SETTINGS,
  getCardSettings,
  setCardSettings,
} from "./cardSettings";

describe("cardSettings", () => {
  it("没配过就是默认值", () => {
    const db = openDb(":memory:");
    expect(getCardSettings(db)).toEqual(DEFAULT_CARD_SETTINGS);
    db.close();
  });

  it("往返读写", () => {
    const db = openDb(":memory:");
    setCardSettings(db, {
      budgetPerMin: 50,
      windowTtlSec: 60,
      staleGateSec: 180,
      lruMax: 100,
    });
    expect(getCardSettings(db).budgetPerMin).toBe(50);
    expect(getCardSettings(db).windowTtlSec).toBe(60);
    db.close();
  });

  it("坏 JSON 回落默认,不炸", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "market_card_settings",
      "{not json",
    );
    expect(getCardSettings(db)).toEqual(DEFAULT_CARD_SETTINGS);
    db.close();
  });

  it("越界的值被夹住 —— 运营手抖不该让端点变成上游炸弹", () => {
    const db = openDb(":memory:");
    setCardSettings(db, {
      budgetPerMin: 999_999,
      windowTtlSec: 0,
      staleGateSec: 10,
      lruMax: -5,
    });
    const s = getCardSettings(db);
    expect(s.budgetPerMin).toBeLessThanOrEqual(2000);
    expect(s.windowTtlSec).toBeGreaterThanOrEqual(5);
    expect(s.lruMax).toBeGreaterThanOrEqual(10);
    db.close();
  });

  it("陈旧闸必须大于新鲜期 —— 否则降级永远够不着,是一段死代码", () => {
    const db = openDb(":memory:");
    // 窗口在 ttl 秒时才触发续抓,届时 staleSec 已 >= ttl;若闸门比 ttl 还小,
    // 每一次降级都会立刻撞闸变 429,「降级」这条路就从来没被走过。
    setCardSettings(db, {
      budgetPerMin: 100,
      windowTtlSec: 60,
      staleGateSec: 30,
      lruMax: 200,
    });
    expect(getCardSettings(db).staleGateSec).toBeGreaterThan(60);
    db.close();
  });

  it("预算可以设成 0 —— 那是「暂时关掉这个端点」的合法运营动作", () => {
    const db = openDb(":memory:");
    setCardSettings(db, { ...DEFAULT_CARD_SETTINGS, budgetPerMin: 0 });
    expect(getCardSettings(db).budgetPerMin).toBe(0);
    db.close();
  });
});
