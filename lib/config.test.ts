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

  it("PUBLIC_URL 默认生产域名,自定义值去尾斜杠", () => {
    expect(parseConfig({}).publicUrl).toBe("https://whalewatch.wired.fund");
    expect(parseConfig({ PUBLIC_URL: "http://my.host:61001/" }).publicUrl).toBe(
      "http://my.host:61001",
    );
  });

  it("xAppConfigured 只看 App 级两件套(account token 由 xAccounts 每轮解析)", () => {
    expect(parseConfig({}).xAppConfigured).toBe(false);
    expect(parseConfig({ X_API_KEY: "k" }).xAppConfigured).toBe(false);
    expect(parseConfig({ X_API_SECRET: "s" }).xAppConfigured).toBe(false);
    // 多账号授权后 .env 里可以完全没有 access token —— 循环照常启动。
    expect(
      parseConfig({ X_API_KEY: "k", X_API_SECRET: "s" }).xAppConfigured,
    ).toBe(true);
    // env 单账号回退配置仍原样透出,供 resolveXCreds 兜底。
    const c = parseConfig({
      X_API_KEY: "k",
      X_API_SECRET: "s",
      X_ACCESS_TOKEN: "t",
      X_ACCESS_SECRET: "ts",
    });
    expect(c).toMatchObject({ xAccessToken: "t", xAccessSecret: "ts" });
  });

  it("X 预算/大单阈值默认 15/50000,非法值 warn 后回退默认(7×24 不因坏 env 崩)", () => {
    expect(parseConfig({}).xMonthlyBudgetUsd).toBe(15);
    expect(parseConfig({}).xMinTradeUsd).toBe(50000);
    expect(parseConfig({ X_MONTHLY_BUDGET_USD: "30" }).xMonthlyBudgetUsd).toBe(
      30,
    );
    expect(parseConfig({ X_MIN_TRADE_USD: "25000" }).xMinTradeUsd).toBe(25000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // NaN 会毒化预算比较 → 熔断失效;负数预算等价关停但更可能是笔误。
    expect(parseConfig({ X_MONTHLY_BUDGET_USD: "abc" }).xMonthlyBudgetUsd).toBe(
      15,
    );
    expect(parseConfig({ X_MIN_TRADE_USD: "-5" }).xMinTradeUsd).toBe(50000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("X_MONTHLY_BUDGET_USD"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("X_MIN_TRADE_USD"),
    );
    warnSpy.mockRestore();
  });

  it("X_OG_ORIGIN 默认本机 3000,自定义值去尾斜杠(worker 自取周报图卡的内网地址)", () => {
    expect(parseConfig({}).xOgOrigin).toBe("http://127.0.0.1:3000");
    expect(parseConfig({ X_OG_ORIGIN: "http://web:3000/" }).xOgOrigin).toBe(
      "http://web:3000",
    );
  });
});
