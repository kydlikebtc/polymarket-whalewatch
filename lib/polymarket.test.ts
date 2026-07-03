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
