import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isPermanentSendError,
  sendMessage,
  stripHtml,
  TelegramPermanentError,
} from "./telegram";

beforeEach(() => vi.restoreAllMocks());

const okRes = { ok: true, status: 200, json: async () => ({ ok: true }) };
const errRes = (status: number, body: object = {}) => ({
  ok: false,
  status,
  json: async () => ({ ok: false, ...body }),
});
// Instant sleep that records the requested waits.
const sleepSpy = () => vi.fn(async (_ms: number) => {});

describe("sendMessage", () => {
  it("POSTs to the bot sendMessage endpoint with HTML parse_mode and a timeout signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okRes);
    vi.stubGlobal("fetch", fetchMock);
    await sendMessage({ botToken: "T", chatId: "@c" }, "hello");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/botT/sendMessage");
    expect(JSON.parse(init.body).parse_mode).toBe("HTML");
    expect(JSON.parse(init.body).chat_id).toBe("@c");
    // One hung connection must not freeze the serial engine loop for minutes.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries after retry_after then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errRes(429, { parameters: { retry_after: 0 } }))
      .mockResolvedValueOnce(okRes);
    vi.stubGlobal("fetch", fetchMock);
    await sendMessage({ botToken: "T", chatId: "@c" }, "hi");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting 429 retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(errRes(429, { parameters: { retry_after: 0 } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      sendMessage({ botToken: "T", chatId: "@c" }, "hi"),
    ).rejects.toThrow(/rate limited/);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("caps the 429 wait: a retry_after above 60s throws immediately (transient) without sleeping", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValue(errRes(429, { parameters: { retry_after: 300 } }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = sleepSpy();
    let caught: unknown;
    await sendMessage({ botToken: "T", chatId: "@c" }, "hi", {
      sleep,
    }).catch((e) => (caught = e));
    expect(String(caught)).toContain("retry_after=300");
    expect(isPermanentSendError(caught)).toBe(false); // at-least-once re-sends next cycle
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("retry_after=300s"),
    );
    warnSpy.mockRestore();
  });

  it("retries 5xx with 1s/2s/4s backoff then succeeds", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errRes(502))
      .mockResolvedValueOnce(errRes(503))
      .mockResolvedValueOnce(okRes);
    vi.stubGlobal("fetch", fetchMock);
    const sleep = sleepSpy();
    await sendMessage({ botToken: "T", chatId: "@c" }, "hi", { sleep });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it("throws a TRANSIENT error after exhausting 5xx retries (4 attempts total)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(errRes(500));
    vi.stubGlobal("fetch", fetchMock);
    let caught: unknown;
    await sendMessage({ botToken: "T", chatId: "@c" }, "hi", {
      sleep: sleepSpy(),
    }).catch((e) => (caught = e));
    expect(String(caught)).toContain("status 500");
    expect(isPermanentSendError(caught)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 + 3 backoff retries
  });

  it("retries network-level failures (fetch rejects) with the same backoff", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(okRes);
    vi.stubGlobal("fetch", fetchMock);
    await sendMessage({ botToken: "T", chatId: "@c" }, "hi", {
      sleep: sleepSpy(),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("downgrades a permanent 4xx to a plain-text resend (no parse_mode, HTML stripped)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        errRes(400, { description: "can't parse entities" }),
      )
      .mockResolvedValueOnce(okRes);
    vi.stubGlobal("fetch", fetchMock);
    await sendMessage(
      { botToken: "T", chatId: "@c" },
      '<b>A &amp; B</b> <a href="https://x">市场</a>',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryBody.parse_mode).toBeUndefined();
    expect(retryBody.text).toBe("A & B 市场");
  });

  it("throws a permanent-marked error when the plain-text downgrade also fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValue(errRes(403, { description: "bot was kicked" }));
    vi.stubGlobal("fetch", fetchMock);
    let caught: unknown;
    await sendMessage({ botToken: "T", chatId: "@c" }, "hi").catch(
      (e) => (caught = e),
    );
    expect(caught).toBeInstanceOf(TelegramPermanentError);
    expect(isPermanentSendError(caught)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2); // original + one downgrade, never more
  });

  it("a MIXED 429 + 5xx sequence terminates: independent bounded counters, no infinite wait", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Alternate 429 (capped wait) and 5xx (backoff). rateAttempt (max 5) and
    // transientAttempt (max 3) are separate counters — the interleaving must
    // not reset either one. Sequence: 429,500,429,502,429,503,500 → three 1s
    // rate waits + three backoffs consumed, the 4th 5xx throws transiently.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errRes(429, { parameters: { retry_after: 1 } }))
      .mockResolvedValueOnce(errRes(500))
      .mockResolvedValueOnce(errRes(429, { parameters: { retry_after: 1 } }))
      .mockResolvedValueOnce(errRes(502))
      .mockResolvedValueOnce(errRes(429, { parameters: { retry_after: 1 } }))
      .mockResolvedValueOnce(errRes(503))
      .mockResolvedValue(errRes(500));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = sleepSpy();
    let caught: unknown;
    await sendMessage({ botToken: "T", chatId: "@c" }, "hi", { sleep }).catch(
      (e) => (caught = e),
    );
    expect(String(caught)).toContain("status 500");
    expect(isPermanentSendError(caught)).toBe(false); // transient → claim rollback + next-cycle retry
    expect(fetchMock).toHaveBeenCalledTimes(7); // bounded: never loops forever
    // 3 capped rate waits (1s each) interleaved with the 1s/2s/4s backoff.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([
      1000, 1000, 1000, 2000, 1000, 4000,
    ]);
  });

  it("does NOT classify 429 as permanent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(errRes(429, { parameters: { retry_after: 0 } }));
    vi.stubGlobal("fetch", fetchMock);
    let caught: unknown;
    await sendMessage({ botToken: "T", chatId: "@c" }, "hi").catch(
      (e) => (caught = e),
    );
    expect(isPermanentSendError(caught)).toBe(false);
  });
});

describe("stripHtml", () => {
  it("strips tags and unescapes entities (&amp; last)", () => {
    expect(stripHtml('<b>A &amp; B</b> &lt;raw&gt; <a href="u">l</a>')).toBe(
      "A & B <raw> l",
    );
    expect(stripHtml("&amp;lt;")).toBe("&lt;"); // no double-unescape
  });
});

describe("isPermanentSendError", () => {
  it("duck-types on the permanent marker", () => {
    expect(isPermanentSendError(new TelegramPermanentError("x"))).toBe(true);
    expect(
      isPermanentSendError(Object.assign(new Error("x"), { permanent: true })),
    ).toBe(true);
    expect(isPermanentSendError(new Error("x"))).toBe(false);
    expect(isPermanentSendError(null)).toBe(false);
    expect(isPermanentSendError("permanent")).toBe(false);
  });
});
