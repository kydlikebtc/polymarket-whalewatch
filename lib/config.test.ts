import { describe, it, expect } from "vitest";
import { parseConfig } from "./config";
describe("parseConfig", () => {
  it("parses thresholds into a sorted number array", () => {
    const c = parseConfig({
      TELEGRAM_BOT_TOKEN: "x",
      TELEGRAM_CHANNEL_ID: "@c",
      LARGE_THRESHOLDS: "50000,10000",
      POLL_INTERVAL_MS: "4000",
    });
    expect(c.largeThresholds).toEqual([10000, 50000]);
    expect(c.pollIntervalMs).toBe(4000);
  });
  it("defaults pollIntervalMs to 4000", () => {
    const c = parseConfig({
      TELEGRAM_BOT_TOKEN: "x",
      TELEGRAM_CHANNEL_ID: "@c",
      LARGE_THRESHOLDS: "10000",
    });
    expect(c.pollIntervalMs).toBe(4000);
  });
});
