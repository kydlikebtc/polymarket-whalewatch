import { describe, it, expect } from "vitest";
import { walletSetKey, mergeAgeBatch } from "./useWalletAges";

describe("walletSetKey", () => {
  it("dedupes, lowercases and sorts so the key is order-insensitive", () => {
    expect(walletSetKey(["0xB", "0xa", "0xB"])).toBe("0xa,0xb");
    expect(walletSetKey(["0xa", "0xb"])).toBe(walletSetKey(["0xB", "0xA"]));
  });

  it("drops undefined/empty wallets", () => {
    expect(walletSetKey([undefined, "", "0xA"])).toBe("0xa");
    expect(walletSetKey([])).toBe("");
  });
});

describe("mergeAgeBatch", () => {
  it("maps ageDays per requested wallet", () => {
    const merged = mergeAgeBatch(["0xa", "0xb"], {
      ages: { "0xa": { ageDays: 3 }, "0xb": { ageDays: null } },
    });
    expect(merged).toEqual({ "0xa": 3, "0xb": null });
  });

  it("wallets missing from the response resolve to null (no perpetual '…')", () => {
    const merged = mergeAgeBatch(["0xa", "0xb"], {
      ages: { "0xa": { ageDays: 12 } },
    });
    expect(merged).toEqual({ "0xa": 12, "0xb": null });
  });

  it("a malformed response without `ages` still settles every wallet", () => {
    expect(mergeAgeBatch(["0xa"], {})).toEqual({ "0xa": null });
  });
});
