import { it, expect, vi } from "vitest";
import { getLargeTrades, getTradesWindow } from "./polymarket";

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
it("warns and falls back to raw when a row fails validation", async () => {
  const bad = [
    {
      proxyWallet: "0x1",
      side: "BUY",
      asset: "9",
      conditionId: "0xc",
      // size missing
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
    .mockResolvedValue({ ok: true, json: async () => bad });
  vi.stubGlobal("fetch", fetchMock);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const trades = await getLargeTrades(10000);
  expect(warnSpy).toHaveBeenCalled();
  expect(trades).toEqual(bad);
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
