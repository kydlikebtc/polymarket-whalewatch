import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { openDb, type DB } from "./db";
import {
  getTelegramHealth,
  TG_FAILURE_DIAG_THRESHOLD,
  wrapSendWithHealth,
} from "./telegramHealth";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const T0 = 1_700_000_000; // hour bucket boundary-agnostic base time

function db(): DB {
  return openDb(":memory:");
}

describe("wrapSendWithHealth", () => {
  it("records the streak on failures and rethrows the ORIGINAL error", async () => {
    const d = db();
    const send = vi.fn().mockRejectedValue(new Error("boom 500"));
    const wrapped = wrapSendWithHealth(d, send, { nowSec: () => T0 });

    await expect(wrapped("<b>a</b>")).rejects.toThrow("boom 500");
    await expect(wrapped("<b>b</b>")).rejects.toThrow("boom 500");

    const h = getTelegramHealth(d)!;
    expect(h.consecutiveSendFailures).toBe(2);
    expect(h.lastErrorMessage).toBe("boom 500");
    expect(h.lastErrorAt).toBe(T0);
    expect(h.failing).toBe(false); // below TG_FAILURE_DIAG_THRESHOLD
    // No diagnostic below the threshold: exactly the 2 real sends.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a successful send resets the streak and stamps lastOkAt", async () => {
    const d = db();
    let now = T0;
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue(undefined);
    const wrapped = wrapSendWithHealth(d, send, { nowSec: () => now });

    await expect(wrapped("x")).rejects.toThrow("blip");
    now = T0 + 5;
    await wrapped("y");

    const h = getTelegramHealth(d)!;
    expect(h.consecutiveSendFailures).toBe(0);
    expect(h.failing).toBe(false);
    expect(h.lastOkAt).toBe(T0 + 5);
    // Last-error info is kept for forensics; only the streak resets.
    expect(h.lastErrorMessage).toBe("blip");
  });

  it("pushes ONE diagnostic at the threshold, deduped per hour, next hour re-arms", async () => {
    const d = db();
    let now = T0;
    const send = vi.fn().mockImplementation(async (html: string) => {
      if (html.includes("自诊断")) return; // diagnostic itself succeeds
      throw new Error("chat <not> found");
    });
    const wrapped = wrapSendWithHealth(d, send, { nowSec: () => now });

    for (let i = 0; i < TG_FAILURE_DIAG_THRESHOLD; i++) {
      await expect(wrapped("msg")).rejects.toThrow("chat <not> found");
    }
    // threshold real sends + exactly 1 diagnostic
    expect(send).toHaveBeenCalledTimes(TG_FAILURE_DIAG_THRESHOLD + 1);
    const diagHtml = send.mock.calls.at(-1)![0] as string;
    expect(diagHtml).toContain("推送通道自诊断");
    expect(diagHtml).toContain(`连续 ${TG_FAILURE_DIAG_THRESHOLD} 次`);
    // Stored error is HTML-escaped into the diagnostic body.
    expect(diagHtml).toContain("chat &lt;not&gt; found");
    expect(diagHtml).not.toContain("chat <not> found");

    // Same hour: more failures, NO second diagnostic.
    now = T0 + 600;
    await expect(wrapped("msg")).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(TG_FAILURE_DIAG_THRESHOLD + 2);

    // Next hour: still failing → one more diagnostic.
    now = T0 + 3700;
    await expect(wrapped("msg")).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(TG_FAILURE_DIAG_THRESHOLD + 4);
    expect(getTelegramHealth(d)!.failing).toBe(true);
  });

  it("a failed diagnostic is swallowed AND still consumes the hour (no pile-on)", async () => {
    const d = db();
    const send = vi.fn().mockRejectedValue(new Error("hard down"));
    const wrapped = wrapSendWithHealth(d, send, { nowSec: () => T0 });

    for (let i = 0; i < TG_FAILURE_DIAG_THRESHOLD; i++) {
      // Caller always sees the ORIGINAL error, never the diagnostic's.
      await expect(wrapped("msg")).rejects.toThrow("hard down");
    }
    // threshold real sends + 1 failed diagnostic attempt
    expect(send).toHaveBeenCalledTimes(TG_FAILURE_DIAG_THRESHOLD + 1);

    // Same hour: the failed diagnostic must NOT retry.
    await expect(wrapped("msg")).rejects.toThrow("hard down");
    expect(send).toHaveBeenCalledTimes(TG_FAILURE_DIAG_THRESHOLD + 2);
    // The diagnostic's own failure did not inflate the streak.
    expect(getTelegramHealth(d)!.consecutiveSendFailures).toBe(
      TG_FAILURE_DIAG_THRESHOLD + 1,
    );
  });

  it("truncates a huge error message to 200 chars in the stored health", async () => {
    const d = db();
    const send = vi.fn().mockRejectedValue(new Error("x".repeat(500)));
    const wrapped = wrapSendWithHealth(d, send, { nowSec: () => T0 });
    await expect(wrapped("msg")).rejects.toThrow();
    expect(getTelegramHealth(d)!.lastErrorMessage).toHaveLength(200);
  });

  it("non-Error throwables are stringified, not crashed on", async () => {
    const d = db();
    const send = vi.fn().mockRejectedValue("plain string failure");
    const wrapped = wrapSendWithHealth(d, send, { nowSec: () => T0 });
    await expect(wrapped("msg")).rejects.toBe("plain string failure");
    expect(getTelegramHealth(d)!.lastErrorMessage).toBe("plain string failure");
  });

  it("streak persists across wrapper instances (config table is the ledger)", async () => {
    const d = db();
    const send = vi.fn().mockRejectedValue(new Error("e"));
    await expect(
      wrapSendWithHealth(d, send, { nowSec: () => T0 })("a"),
    ).rejects.toThrow();
    await expect(
      wrapSendWithHealth(d, send, { nowSec: () => T0 })("b"),
    ).rejects.toThrow();
    expect(getTelegramHealth(d)!.consecutiveSendFailures).toBe(2);
  });
});

describe("getTelegramHealth", () => {
  it("cold db (tables exist, no counters yet) reads as healthy-zero", () => {
    const h = getTelegramHealth(db())!;
    expect(h).toEqual({
      consecutiveSendFailures: 0,
      lastErrorMessage: null,
      lastErrorAt: null,
      lastOkAt: null,
      failing: false,
    });
  });

  it("returns null (unknown) when the config table is missing", () => {
    const bare = new Database(":memory:") as DB; // no schema at all
    expect(getTelegramHealth(bare)).toBeNull();
  });
});
