import { it, expect, vi } from "vitest";
import {
  getLargeTrades,
  getTradesWindow,
  getTradesWindowDeep,
} from "./polymarket";

// A factory for valid trade rows; override fields per test.
function trade(over: Record<string, unknown> = {}) {
  return {
    proxyWallet: "0x1",
    side: "BUY",
    asset: "9",
    conditionId: "0xc",
    size: 100,
    price: 0.5,
    timestamp: 1700000000,
    title: "M",
    slug: "s",
    eventSlug: "e",
    outcome: "Yes",
    outcomeIndex: 0,
    transactionHash: "0xh",
    ...over,
  };
}
it("requests the global trades feed with the CASH filter", async () => {
  const sample = [
    {
      proxyWallet: "0x1",
      side: "BUY",
      asset: "9",
      conditionId: "0xc",
      size: 5168.75,
      price: 0.999,
      timestamp: 1700000000,
      title: "M",
      slug: "s",
      eventSlug: "e",
      outcome: "Yes",
      outcomeIndex: 0,
      transactionHash: "0xh",
    },
  ];
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => sample });
  vi.stubGlobal("fetch", fetchMock);
  const trades = await getLargeTrades(10000);
  const url = fetchMock.mock.calls[0][0] as string;
  expect(url).toContain("filterType=CASH");
  expect(url).toContain("filterAmount=10000");
  expect(url).toContain("takerOnly=true");
  expect(trades[0].size).toBe(5168.75);
});
it("salvages valid rows and drops malformed ones instead of falling back to raw", async () => {
  // One bad row (size missing → notionalUsd would be NaN and slip past every
  // filter) mixed with a good one: the good row survives, the bad one is
  // dropped, and the warn names the first issue path for diagnosability.
  const good = trade({ transactionHash: "0xgood" });
  const bad = trade({ transactionHash: "0xbad" }) as Record<string, unknown>;
  delete bad.size;
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => [good, bad] });
  vi.stubGlobal("fetch", fetchMock);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const trades = await getLargeTrades(10000);
  expect(trades).toEqual([good]);
  expect(warnSpy).toHaveBeenCalledWith(
    expect.stringContaining("dropped 1/2 malformed row(s)"),
  );
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("size"));
  warnSpy.mockRestore();
});
it("warns on a full page (possible overflow)", async () => {
  const row = {
    proxyWallet: "0x1",
    side: "BUY",
    asset: "9",
    conditionId: "0xc",
    size: 5168.75,
    price: 0.999,
    timestamp: 1700000000,
    title: "M",
    slug: "s",
    eventSlug: "e",
    outcome: "Yes",
    outcomeIndex: 0,
    transactionHash: "0xh",
  };
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => [row] });
  vi.stubGlobal("fetch", fetchMock);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  await getLargeTrades(10000, 1); // limit=1, one row => full page
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("full page"));
  warnSpy.mockRestore();
});

it("getLargeTrades tops up with offset pages when a full page is entirely unseen and in-window", async () => {
  const sinceSec = 1000;
  const page0 = [
    trade({ timestamp: 2000, transactionHash: "0xa" }),
    trade({ timestamp: 1999, transactionHash: "0xb" }),
  ];
  // Second page reaches the window edge mid-page: 0xc kept, the old row stops.
  const page1 = [
    trade({ timestamp: 1998, transactionHash: "0xc" }),
    trade({ timestamp: 500, transactionHash: "0xold" }),
  ];
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => page0 })
    .mockResolvedValueOnce({ ok: true, json: async () => page1 });
  vi.stubGlobal("fetch", fetchMock);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const trades = await getLargeTrades(10000, 2, {
    sinceSec,
    maxPages: 3,
    hasSeenAny: () => false,
  });
  expect(trades.map((t) => t.transactionHash)).toEqual(["0xa", "0xb", "0xc"]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const urls = fetchMock.mock.calls.map((c) => c[0] as string);
  expect(urls[0]).not.toContain("offset=");
  expect(urls[1]).toContain("offset=2");
  warnSpy.mockRestore();
});

it("getLargeTrades does NOT top up when the full page already touches seen trades", async () => {
  const page0 = [
    trade({ timestamp: 2000, transactionHash: "0xa" }),
    trade({ timestamp: 1999, transactionHash: "0xseen" }),
  ];
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => page0 });
  vi.stubGlobal("fetch", fetchMock);
  const trades = await getLargeTrades(10000, 2, {
    sinceSec: 1000,
    maxPages: 3,
    hasSeenAny: (rows) => rows.some((t) => t.transactionHash === "0xseen"),
  });
  expect(trades).toHaveLength(2); // fetched rows are still returned
  expect(fetchMock).toHaveBeenCalledTimes(1); // ...but no deeper page is requested
});

it("getLargeTrades warns 'may be missed' only when the top-up budget is exhausted", async () => {
  const sinceSec = 1000;
  const fullPage = (tag: string) => [
    trade({ timestamp: 2000, transactionHash: `${tag}a` }),
    trade({ timestamp: 1999, transactionHash: `${tag}b` }),
  ];
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => fullPage("0x0") })
    .mockResolvedValueOnce({ ok: true, json: async () => fullPage("0x1") });
  vi.stubGlobal("fetch", fetchMock);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const trades = await getLargeTrades(10000, 2, {
    sinceSec,
    maxPages: 2,
    hasSeenAny: () => false,
  });
  expect(trades).toHaveLength(4);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(warnSpy).toHaveBeenCalledWith(
    expect.stringContaining("may be missed"),
  );
  warnSpy.mockRestore();
});

it("getLargeTrades degrades a failed top-up page to the fetched prefix (first-page failure still throws)", async () => {
  const page0 = [
    trade({ timestamp: 2000, transactionHash: "0xa" }),
    trade({ timestamp: 1999, transactionHash: "0xb" }),
  ];
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => page0 })
    .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
  vi.stubGlobal("fetch", fetchMock);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const trades = await getLargeTrades(10000, 2, {
    sinceSec: 1000,
    maxPages: 3,
    hasSeenAny: () => false,
  });
  expect(trades).toHaveLength(2);
  expect(warnSpy).toHaveBeenCalledWith(
    expect.stringContaining("keeping 2 fetched rows"),
  );
  warnSpy.mockRestore();

  // First-page failure remains a hard error.
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }),
  );
  await expect(getLargeTrades(10000, 2)).rejects.toThrow("400");
});

it("getTradesWindow stops at the first row older than sinceSec (in-window only, truncated:false)", async () => {
  // Single page mixing in-window and out-of-window rows; the second row is older.
  const sinceSec = 1700000000;
  const page = [
    trade({ timestamp: sinceSec + 100, transactionHash: "0xa" }), // in window
    trade({ timestamp: sinceSec - 1, transactionHash: "0xb" }), // older -> stop here
    trade({ timestamp: sinceSec + 50, transactionHash: "0xc" }), // never reached
  ];
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => page });
  vi.stubGlobal("fetch", fetchMock);
  const { trades, truncated } = await getTradesWindow({
    minUsd: 10000,
    sinceSec,
  });
  expect(truncated).toBe(false);
  expect(trades).toHaveLength(1);
  expect(trades[0].transactionHash).toBe("0xa");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("getTradesWindow puts side=BUY in the request URL", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => [] });
  vi.stubGlobal("fetch", fetchMock);
  await getTradesWindow({
    minUsd: 10000,
    side: "BUY",
    sinceSec: 1700000000,
  });
  const url = fetchMock.mock.calls[0][0] as string;
  expect(url).toContain("side=BUY");
});

it("getTradesWindow returns truncated:true when it hits the page cap with all rows in-window", async () => {
  const sinceSec = 1700000000;
  // Every page is a full 500 rows, all newer than sinceSec -> never reaches the edge.
  const fullPage = Array.from({ length: 500 }, (_, i) =>
    trade({ timestamp: sinceSec + 1000, transactionHash: `0x${i}` }),
  );
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => fullPage });
  vi.stubGlobal("fetch", fetchMock);
  const { trades, truncated } = await getTradesWindow({
    minUsd: 10000,
    sinceSec,
    maxPages: 2,
  });
  expect(truncated).toBe(true);
  expect(trades).toHaveLength(1000); // 2 full pages
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("getTradesWindow stops BEFORE the verified 3000 offset cap and reports truncated", async () => {
  const sinceSec = 1700000000;
  const fullPage = Array.from({ length: 500 }, (_, i) =>
    trade({ timestamp: sinceSec + 1000, transactionHash: `0x${i}` }),
  );
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => fullPage });
  vi.stubGlobal("fetch", fetchMock);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { trades, truncated } = await getTradesWindow({
    minUsd: 2000,
    sinceSec,
    maxPages: 20,
  });
  expect(truncated).toBe(true);
  // offsets 0..3000 are legal (7 pages); offset 3500 must never be requested.
  expect(fetchMock).toHaveBeenCalledTimes(7);
  expect(trades).toHaveLength(3500);
  const urls = fetchMock.mock.calls.map((c) => c[0] as string);
  expect(urls.some((u) => u.includes("offset=3500"))).toBe(false);
  warnSpy.mockRestore();
});

it("getTradesWindow degrades a mid-pagination 400 (moved offset cap) to a truncated window", async () => {
  const sinceSec = 1700000000;
  const fullPage = Array.from({ length: 500 }, (_, i) =>
    trade({ timestamp: sinceSec + 1000, transactionHash: `0x${i}` }),
  );
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => fullPage })
    .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
  vi.stubGlobal("fetch", fetchMock);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { trades, truncated } = await getTradesWindow({
    minUsd: 2000,
    sinceSec,
  });
  expect(truncated).toBe(true);
  expect(trades).toHaveLength(500); // the fetched prefix survives
  warnSpy.mockRestore();
});

it("getTradesWindow still throws on a FIRST-page 400 (genuinely bad request)", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }),
  );
  await expect(
    getTradesWindow({ minUsd: 2000, sinceSec: 1700000000 }),
  ).rejects.toThrow("400");
});

it("getTradesWindowDeep gives each side its own depth budget and trims to the newest truncation edge", async () => {
  const sinceSec = 1000;
  // BUY side: one full page (maxPages=1) of in-window rows → truncated, oldest 1501.
  const buyPage = Array.from({ length: 500 }, (_, i) =>
    trade({ side: "BUY", timestamp: 2000 - i, transactionHash: `0xb${i}` }),
  );
  // SELL side: complete (short page) — one row newer than the BUY edge, one older.
  const sellPage = [
    trade({ side: "SELL", timestamp: 1900, transactionHash: "0xs1" }),
    trade({ side: "SELL", timestamp: 1200, transactionHash: "0xs2" }), // older than BUY edge → dropped
    trade({ side: "SELL", timestamp: 900, transactionHash: "0xs3" }), // out of window → stops SELL sweep
  ];
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (url.includes("side=BUY") ? buyPage : sellPage),
  }));
  vi.stubGlobal("fetch", fetchMock);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { trades, truncated, effectiveSinceSec } = await getTradesWindowDeep({
    minUsd: 2000,
    sinceSec,
    maxPages: 1,
  });
  expect(truncated).toBe(true);
  expect(effectiveSinceSec).toBe(1501); // BUY's oldest fetched row
  // 500 BUY rows + the one SELL row inside the complete window.
  expect(trades).toHaveLength(501);
  expect(trades.some((t) => t.transactionHash === "0xs2")).toBe(false);
  // Merged output is newest-first.
  expect(trades[0].timestamp).toBe(2000);
  warnSpy.mockRestore();
});

it("getTradesWindowDeep merges complete sides untruncated and dedups re-served rows", async () => {
  const sinceSec = 1000;
  const dupe = trade({ side: "BUY", timestamp: 1500, transactionHash: "0xa" });
  const buyPage = [
    dupe,
    { ...dupe }, // pagination re-serve of the same fill
    trade({ side: "BUY", timestamp: 900, transactionHash: "0xold" }), // edge
  ];
  const sellPage = [
    trade({ side: "SELL", timestamp: 1400, transactionHash: "0xs" }),
    trade({ side: "SELL", timestamp: 800, transactionHash: "0xsold" }),
  ];
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (url.includes("side=BUY") ? buyPage : sellPage),
  }));
  vi.stubGlobal("fetch", fetchMock);
  const { trades, truncated, effectiveSinceSec } = await getTradesWindowDeep({
    minUsd: 2000,
    sinceSec,
  });
  expect(truncated).toBe(false);
  expect(effectiveSinceSec).toBe(sinceSec);
  expect(trades).toHaveLength(2); // dupe collapsed, out-of-window rows gone
  expect(trades.map((t) => t.transactionHash)).toEqual(["0xa", "0xs"]);
});

it("getTradesWindow salvages bad rows and still paginates on the RAW page length", async () => {
  const sinceSec = 1700000000;
  // Page 0: 500 raw rows, one malformed — salvaged length is 499, but the RAW
  // page was full, so pagination must continue to page 1 (a salvaged short
  // page must not be mistaken for the last available page).
  const page0 = Array.from({ length: 500 }, (_, i) =>
    trade({ timestamp: sinceSec + 1000, transactionHash: `0x${i}` }),
  ) as Record<string, unknown>[];
  delete page0[7].size;
  const page1 = [trade({ timestamp: sinceSec - 1, transactionHash: "0xold" })];
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => page0 })
    .mockResolvedValueOnce({ ok: true, json: async () => page1 });
  vi.stubGlobal("fetch", fetchMock);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { trades, truncated } = await getTradesWindow({
    minUsd: 10000,
    sinceSec,
  });
  expect(truncated).toBe(false);
  expect(trades).toHaveLength(499); // bad row dropped, good rows kept
  expect(fetchMock).toHaveBeenCalledTimes(2); // raw-length pagination continued
  expect(warnSpy).toHaveBeenCalledWith(
    expect.stringContaining("dropped 1/500 malformed row(s)"),
  );
  warnSpy.mockRestore();
});

it("getTradesWindow retries a transient 408 then succeeds", async () => {
  const sinceSec = 1700000000;
  const page = [
    trade({ timestamp: sinceSec + 100, transactionHash: "0xa" }),
    trade({ timestamp: sinceSec - 1, transactionHash: "0xb" }),
  ];
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 408, json: async () => ({}) })
    .mockResolvedValueOnce({ ok: true, json: async () => page });
  vi.stubGlobal("fetch", fetchMock);
  const { trades } = await getTradesWindow({ minUsd: 100000, sinceSec });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(trades).toHaveLength(1);
  expect(trades[0].transactionHash).toBe("0xa");
});

/* ---------------------------------------------------- transient degradation
 * The upstream origin times out (~5.75s → 408) filling expensive cold-cache
 * pages. Recovery ladder: fetchWithRetry backoff → same-offset shrink retry
 * (250→125→60) → keep-the-prefix degradation (mid-window) / throw (page 0).
 * These tests exhaust fetchWithRetry's backoff, so they run on fake timers.
 */

// Response helpers for URL-driven mocks: fetchWithRetry re-hits the SAME url
// on its internal attempts, so keying the mock off the url keeps the scripted
// sequence deterministic regardless of retry count.
const okPage = (rows: unknown[]) => ({ ok: true, json: async () => rows });
const status408 = { ok: false, status: 408, json: async () => ({}) };
const limitOf = (url: string) => Number(new URL(url).searchParams.get("limit"));
const offsetOf = (url: string) =>
  Number(new URL(url).searchParams.get("offset"));
// Collapse fetchWithRetry's identical retry attempts so assertions see the
// logical page sequence.
const distinctUrls = (fetchMock: { mock: { calls: unknown[][] } }) =>
  fetchMock.mock.calls
    .map((c) => c[0] as string)
    .filter((u, i, a) => i === 0 || u !== a[i - 1]);

it("getTradesWindow shrinks the page at the SAME offset when a 408 survives the backoff", async () => {
  vi.useFakeTimers();
  try {
    const sinceSec = 1000;
    const mkRows = (start: number, n: number) =>
      Array.from({ length: n }, (_, i) =>
        trade({ timestamp: 2000, transactionHash: `0x${start + i}` }),
      );
    const fetchMock = vi.fn(async (url: string) => {
      const limit = limitOf(url);
      const offset = offsetOf(url);
      // The full-size page-0 query 408s every attempt; the halved one works.
      if (offset === 0 && limit === 250) return status408;
      if (offset === 0 && limit === 125) return okPage(mkRows(0, 125)); // full page
      if (offset === 125 && limit === 250) return okPage(mkRows(125, 10)); // short → done
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const promise = getTradesWindow({ minUsd: 10000, sinceSec });
    await vi.runAllTimersAsync();
    const { trades, truncated } = await promise;
    expect(truncated).toBe(false);
    expect(trades).toHaveLength(135);
    // No dupes, no gaps across the mixed page sizes.
    expect(new Set(trades.map((t) => t.transactionHash)).size).toBe(135);
    const urls = distinctUrls(fetchMock);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain("limit=250");
    expect(urls[0]).toContain("offset=0");
    expect(urls[1]).toContain("limit=125");
    expect(urls[1]).toContain("offset=0"); // shrink retries the SAME offset
    expect(urls[2]).toContain("limit=250"); // next page back at full size
    expect(urls[2]).toContain("offset=125"); // offset advanced by RAW rows
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("retrying same offset with limit=125"),
    );
    warnSpy.mockRestore();
  } finally {
    vi.useRealTimers();
  }
});

it("getTradesWindow accumulates offsets by RAW rows across mixed page sizes (no overlap, no gap)", async () => {
  vi.useFakeTimers();
  try {
    const sinceSec = 1000;
    const mkRows = (start: number, n: number) =>
      Array.from({ length: n }, (_, i) =>
        trade({ timestamp: 2000, transactionHash: `0x${start + i}` }),
      );
    const fetchMock = vi.fn(async (url: string) => {
      const limit = limitOf(url);
      const offset = offsetOf(url);
      if (offset === 0 && limit === 250) return okPage(mkRows(0, 250)); // full
      if (offset === 250 && limit === 250) return status408; // cold mid-page
      if (offset === 250 && limit === 125) return okPage(mkRows(250, 125)); // shrunk full
      if (offset === 375 && limit === 250) return okPage(mkRows(375, 10)); // short → done
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const promise = getTradesWindow({ minUsd: 10000, sinceSec });
    await vi.runAllTimersAsync();
    const { trades, truncated } = await promise;
    expect(truncated).toBe(false);
    expect(trades).toHaveLength(385); // 250 + 125 + 10, complete
    expect(new Set(trades.map((t) => t.transactionHash)).size).toBe(385);
    const urls = distinctUrls(fetchMock);
    expect(urls.map((u) => `${limitOf(u)}@${offsetOf(u)}`)).toEqual([
      "250@0",
      "250@250",
      "125@250",
      "250@375",
    ]);
    warnSpy.mockRestore();
  } finally {
    vi.useRealTimers();
  }
});

it("getTradesWindow degrades a mid-window 408 to the fetched prefix after retries AND shrinks fail", async () => {
  vi.useFakeTimers();
  try {
    const sinceSec = 1000;
    const page0 = Array.from({ length: 250 }, (_, i) =>
      trade({ timestamp: 2000, transactionHash: `0x${i}` }),
    );
    const fetchMock = vi.fn(async (url: string) =>
      offsetOf(url) === 0 ? okPage(page0) : status408,
    );
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const promise = getTradesWindow({ minUsd: 10000, sinceSec });
    await vi.runAllTimersAsync();
    const { trades, truncated } = await promise;
    expect(truncated).toBe(true);
    expect(trades).toHaveLength(250); // the fetched prefix survives
    // Full shrink ladder was attempted at offset 250 before degrading.
    const urls = distinctUrls(fetchMock);
    expect(urls.map((u) => `${limitOf(u)}@${offsetOf(u)}`)).toEqual([
      "250@0",
      "250@250",
      "125@250",
      "60@250",
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("transient 408 persisted at offset=250"),
    );
    warnSpy.mockRestore();
  } finally {
    vi.useRealTimers();
  }
});

it("getTradesWindow still throws when the FIRST page 408s through retries and shrinks (no prefix to salvage)", async () => {
  vi.useFakeTimers();
  try {
    const fetchMock = vi.fn().mockResolvedValue(status408);
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const promise = getTradesWindow({ minUsd: 10000, sinceSec: 1000 });
    const assertion = expect(promise).rejects.toThrow("getTradesWindow 408");
    await vi.runAllTimersAsync();
    await assertion;
    // 3 limit sizes × 4 fetchWithRetry attempts each.
    expect(fetchMock).toHaveBeenCalledTimes(12);
    warnSpy.mockRestore();
  } finally {
    vi.useRealTimers();
  }
});

it("getTradesWindowDeep degrades to the surviving side when one side fails outright", async () => {
  vi.useFakeTimers();
  try {
    const sinceSec = 1000;
    const buyPage = [
      trade({ side: "BUY", timestamp: 1900, transactionHash: "0xb1" }),
      trade({ side: "BUY", timestamp: 1500, transactionHash: "0xb2" }),
      trade({ side: "BUY", timestamp: 900, transactionHash: "0xbold" }), // window edge
    ];
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("side=BUY") ? okPage(buyPage) : status408,
    );
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const promise = getTradesWindowDeep({ minUsd: 10000, sinceSec });
    await vi.runAllTimersAsync();
    const { trades, truncated, effectiveSinceSec } = await promise;
    expect(truncated).toBe(true);
    // Honest coverage only reaches back to the survivor's own oldest row.
    expect(effectiveSinceSec).toBe(1500);
    expect(trades.map((t) => t.transactionHash)).toEqual(["0xb1", "0xb2"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("SELL side failed"),
    );
    warnSpy.mockRestore();
  } finally {
    vi.useRealTimers();
  }
});

it("getTradesWindowDeep reports zero coverage (empty window, effectiveSinceSec=now) when the survivor is empty", async () => {
  vi.useFakeTimers();
  try {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("side=BUY")
        ? okPage([])
        : { ok: false, status: 503, json: async () => ({}) },
    );
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const promise = getTradesWindowDeep({ minUsd: 10000, sinceSec: 1000 });
    await vi.runAllTimersAsync();
    const { trades, truncated, effectiveSinceSec } = await promise;
    expect(trades).toEqual([]);
    expect(truncated).toBe(true);
    // Fake timers freeze Date after runAllTimersAsync, so "now" is exact.
    expect(effectiveSinceSec).toBe(Math.floor(Date.now() / 1000));
    warnSpy.mockRestore();
  } finally {
    vi.useRealTimers();
  }
});

it("getTradesWindowDeep throws only when BOTH sides fail (keeps the getTradesWindow error shape)", async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status408));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const promise = getTradesWindowDeep({ minUsd: 10000, sinceSec: 1000 });
    const assertion = expect(promise).rejects.toThrow("getTradesWindow 408");
    await vi.runAllTimersAsync();
    await assertion;
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("BOTH sides failed"),
    );
    warnSpy.mockRestore();
  } finally {
    vi.useRealTimers();
  }
});
