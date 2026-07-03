import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithRetry } from "./fetchWithRetry";

const ok = { ok: true, status: 200 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchWithRetry", () => {
  it("returns an ok response immediately (single request)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok);
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://x/api");
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 502 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fetchWithRetry("https://x/api", {
      baseDelayMs: 1,
      label: "t",
    });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[t] transient 502"),
    );
  });

  it("returns a non-transient status immediately without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://x/api", { baseDelayMs: 1 });
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the LAST transient response after exhausting attempts (caller keeps its !res.ok handling)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fetchWithRetry("https://x/api", {
      attempts: 3,
      baseDelayMs: 1,
    });
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    warnSpy.mockRestore();
  });

  it("retries thrown network errors and rethrows after exhaustion", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("boom"));
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      fetchWithRetry("https://x/api", { attempts: 2, baseDelayMs: 1 }),
    ).rejects.toThrow("boom");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("passes headers and label through to the request/logs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok);
    vi.stubGlobal("fetch", fetchMock);
    await fetchWithRetry("https://x/api", {
      headers: { "User-Agent": "polymarket-monitor" },
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ "User-Agent": "polymarket-monitor" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
