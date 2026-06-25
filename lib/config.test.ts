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
  it("derives telegramEnabled=true when both creds present", () => {
    const c = parseConfig({
      TELEGRAM_BOT_TOKEN: "x",
      TELEGRAM_CHANNEL_ID: "@c",
    });
    expect(c.telegramEnabled).toBe(true);
  });
  it("parses with NO telegram env: telegramEnabled=false, thresholds/interval still parse", () => {
    const c = parseConfig({
      LARGE_THRESHOLDS: "50000,10000",
      POLL_INTERVAL_MS: "5000",
    });
    expect(c.telegramEnabled).toBe(false);
    expect(c.telegramBotToken).toBe("");
    expect(c.telegramChannelId).toBe("");
    expect(c.largeThresholds).toEqual([10000, 50000]);
    expect(c.pollIntervalMs).toBe(5000);
  });
});
