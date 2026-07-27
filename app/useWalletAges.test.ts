import { describe, it, expect } from "vitest";
import {
  walletSetKey,
  mergeAgeBatch,
  isSettledAgeResponse,
} from "./useWalletAges";

describe("isSettledAgeResponse", () => {
  it("only 2xx settles a batch", () => {
    expect(isSettledAgeResponse(200)).toBe(true);
    expect(isSettledAgeResponse(204)).toBe(true);
  });

  it("429 is transient — the rate-limited envelope must not settle wallets", () => {
    // Regression: the 429 body is a parseable {ages:{}}, so merging it marked
    // every wallet 'age unknown' permanently (badges gone until a hard reload).
    expect(isSettledAgeResponse(429)).toBe(false);
  });

  it("server and gateway errors are transient too", () => {
    for (const s of [500, 502, 503, 504]) {
      expect(isSettledAgeResponse(s)).toBe(false);
    }
  });
});

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
