import { it, expect, vi } from "vitest";
import { getLargeTrades } from "./polymarket";
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
