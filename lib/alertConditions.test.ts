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

  it("defaults exclude >=0.95 settlement-sweep fills and enable a 30-min cooldown", () => {
    // Production-measured noise floor: 28.6% of alerts at >=0.90 price and one
    // wallet alone at 14.2% of pushes — both defaults exist to cut that.
    expect(DEFAULT_CONDITIONS.maxPrice).toBe(0.95);
    expect(DEFAULT_CONDITIONS.cooldownMinutes).toBe(30);
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
      cooldownMinutes: 5,
    };
    setAlertConditions(db, c);
    expect(getAlertConditions(db)).toEqual(c);
  });

  it("a saved maxPrice:null is NOT overridden by the 0.95 default (no migration)", () => {
    // Every UI save stores an explicit maxPrice (null when blank); the stored
    // value must win over the new default so existing setups keep their band.
    const db = openDb(":memory:");
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('alert_conditions', ?)",
    ).run(JSON.stringify({ ...DEFAULT_CONDITIONS, maxPrice: null }));
    expect(getAlertConditions(db).maxPrice).toBeNull();
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
