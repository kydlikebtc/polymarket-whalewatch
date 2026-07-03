import { describe, it, expect, vi } from "vitest";
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

  it("falls back to the default interval on a non-numeric POLL_INTERVAL_MS (NaN would busy-loop the poll)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // "4_000" is a classic typo: Number("4_000") is NaN and setTimeout(NaN)
    // fires every ~1ms.
    const c = parseConfig({ POLL_INTERVAL_MS: "4_000" });
    expect(c.pollIntervalMs).toBe(4000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('POLL_INTERVAL_MS="4_000"'),
    );
    warnSpy.mockRestore();
  });

  it("clamps a below-floor POLL_INTERVAL_MS instead of crashing (7×24 principle)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = parseConfig({ POLL_INTERVAL_MS: "200" });
    expect(c.pollIntervalMs).toBe(1000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("floor"));
    warnSpy.mockRestore();
  });

  it("treats an empty POLL_INTERVAL_MS as invalid (Number('') is 0, not a config)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = parseConfig({ POLL_INTERVAL_MS: "" });
    expect(c.pollIntervalMs).toBe(4000);
    warnSpy.mockRestore();
  });

  it("drops non-finite threshold entries and keeps the valid ones", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = parseConfig({ LARGE_THRESHOLDS: "5000,10_000,abc" });
    expect(c.largeThresholds).toEqual([5000]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("dropped 2 non-numeric"),
    );
    warnSpy.mockRestore();
  });

  it("TELEGRAM_STARTUP_PING defaults to OFF and accepts explicit truthy spellings", () => {
    expect(parseConfig({}).telegramStartupPing).toBe(false);
    for (const v of ["1", "true", "TRUE", "yes", "on", " On "]) {
      expect(
        parseConfig({ TELEGRAM_STARTUP_PING: v }).telegramStartupPing,
      ).toBe(true);
    }
    for (const v of ["", "0", "false", "off", "nope"]) {
      expect(
        parseConfig({ TELEGRAM_STARTUP_PING: v }).telegramStartupPing,
      ).toBe(false);
    }
  });

  it("falls back to default thresholds when nothing parses (empty array would disable grouping)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = parseConfig({ LARGE_THRESHOLDS: "10_000;50k" });
    expect(c.largeThresholds).toEqual([10000, 50000]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no parseable numbers"),
    );
    warnSpy.mockRestore();
  });
});
