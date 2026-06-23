import { describe, it, expect } from "vitest";
import { openDb } from "./db";
describe("openDb", () => {
  it("creates the seen_trades table", () => {
    const db = openDb(":memory:");
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='seen_trades'",
      )
      .get();
    expect(row).toBeTruthy();
  });
});
