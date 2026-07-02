import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import {
  DEFAULT_CONDITIONS,
  getAlertConditions,
  setAlertConditions,
  type AlertConditions,
} from "./alertConditions";

describe("alertConditions", () => {
  it("get on an empty config table returns DEFAULT_CONDITIONS", () => {
    const db = openDb(":memory:");
    expect(getAlertConditions(db)).toEqual(DEFAULT_CONDITIONS);
  });

  it("set then get round-trips the full object", () => {
    const db = openDb(":memory:");
    const c: AlertConditions = {
      enabled: false,
      minUsd: 25000,
      side: "BUY",
      minPrice: 0.2,
      maxPrice: 0.9,
      maxAgeDays: 7,
      smartOnly: true,
      maxHoursToEnd: 12,
    };
    setAlertConditions(db, c);
    expect(getAlertConditions(db)).toEqual(c);
  });

  it("corrupt JSON in config falls back to defaults", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('alert_conditions', ?)",
    ).run("{not valid json");
    expect(getAlertConditions(db)).toEqual(DEFAULT_CONDITIONS);
  });

  it("a partial stored object merges over defaults", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('alert_conditions', ?)",
    ).run(JSON.stringify({ minUsd: 99999, side: "SELL" }));
    expect(getAlertConditions(db)).toEqual({
      ...DEFAULT_CONDITIONS,
      minUsd: 99999,
      side: "SELL",
    });
  });
});
