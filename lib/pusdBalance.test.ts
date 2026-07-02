import { describe, it, expect, vi } from "vitest";
import { fetchPusdBalance } from "./pusdBalance";

const WALLET = "0x6a72f61820b26b1fe4d956e17b6dc2a1ea3033ee";

const rpcOk = (hex: string) => ({
  ok: true,
  json: async () => ({ jsonrpc: "2.0", id: 1, result: hex }),
});

describe("fetchPusdBalance", () => {
  it("decodes the balanceOf result at 6 decimals", async () => {
    // 181038379452 raw = $181,038.379452 (live-verified figure).
    const fetchMock = vi.fn().mockResolvedValue(rpcOk("0x2a26ba71bc"));
    vi.stubGlobal("fetch", fetchMock);
    const bal = await fetchPusdBalance(WALLET);
    expect(bal).toBeCloseTo(181038.379452, 3);
    // eth_call with the balanceOf selector + left-padded address.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.method).toBe("eth_call");
    expect(body.params[0].data).toBe(
      "0x70a08231000000000000000000000000" + WALLET.slice(2),
    );
  });

  it("falls back to the next RPC when the first fails", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(rpcOk("0xf4240")); // 1_000_000 raw = $1
    vi.stubGlobal("fetch", fetchMock);
    const bal = await fetchPusdBalance(WALLET, {
      rpcs: ["https://rpc-a", "https://rpc-b"],
    });
    expect(bal).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips an RPC-level error object (no result field)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: { message: "denied" } }),
      })
      .mockResolvedValueOnce(rpcOk("0x0"));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await fetchPusdBalance(WALLET, { rpcs: ["https://a", "https://b"] }),
    ).toBe(0);
  });

  it("returns null for a malformed address without any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchPusdBalance("not-an-address")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when every RPC fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await fetchPusdBalance(WALLET)).toBeNull();
    warnSpy.mockRestore();
  });
});
