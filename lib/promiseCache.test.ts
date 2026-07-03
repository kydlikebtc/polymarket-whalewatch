import { describe, it, expect, vi, afterEach } from "vitest";
import { createPromiseCache } from "./promiseCache";

afterEach(() => {
  vi.useRealTimers();
});

describe("createPromiseCache", () => {
  it("concurrent misses share ONE in-flight load (no cold-cache stampede)", async () => {
    let release!: (v: string) => void;
    const gate = new Promise<string>((r) => (release = r));
    const load = vi.fn(() => gate);
    const shared = createPromiseCache<string>(1000);
    const p1 = shared("k", load);
    const p2 = shared("k", load);
    expect(load).toHaveBeenCalledTimes(1);
    release("v");
    expect(await p1).toBe("v");
    expect(await p2).toBe("v");
  });

  it("distinct keys load independently", async () => {
    const load = vi.fn(async () => "v");
    const shared = createPromiseCache<string>(1000);
    await shared("a", load);
    await shared("b", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("serves the cached promise within the TTL and reloads after expiry", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => "v");
    const shared = createPromiseCache<string>(1000);
    await shared("k", load);
    vi.advanceTimersByTime(999);
    await shared("k", load);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    await shared("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a failed load evicts itself so the next call retries within the TTL", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("v");
    const shared = createPromiseCache<string>(60_000);
    await expect(shared("k", load)).rejects.toThrow("boom");
    await expect(shared("k", load)).resolves.toBe("v");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a stale entry's late failure does not evict a fresh replacement", async () => {
    vi.useFakeTimers();
    let rejectFirst!: (e: Error) => void;
    const first = new Promise<string>((_, rej) => (rejectFirst = rej));
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first)
      .mockResolvedValue("fresh");
    const shared = createPromiseCache<string>(1000);
    shared("k", load).catch(() => {}); // stale in-flight entry
    vi.advanceTimersByTime(1001); // TTL expires while still in flight
    const p2 = shared("k", load); // fresh entry replaces the stale one
    rejectFirst(new Error("late"));
    await Promise.resolve(); // let the stale entry's eviction handler run
    const p3 = shared("k", load); // must still hit the FRESH cached entry
    expect(p3).toBe(p2);
    await expect(p2).resolves.toBe("fresh");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
