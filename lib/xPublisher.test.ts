import { describe, it, expect } from "vitest";
import { createXClient, isPermanentXError } from "./xPublisher";

describe("isPermanentXError", () => {
  it("4xx (except 429) is permanent — retrying a rejected post can never succeed", () => {
    expect(isPermanentXError({ code: 400 })).toBe(true);
    expect(isPermanentXError({ code: 403 })).toBe(true);
  });
  it("429 / 5xx / network errors are transient (retry next cycle)", () => {
    expect(isPermanentXError({ code: 429 })).toBe(false);
    expect(isPermanentXError({ code: 500 })).toBe(false);
    expect(isPermanentXError(new TypeError("fetch failed"))).toBe(false);
    expect(isPermanentXError(null)).toBe(false);
    expect(isPermanentXError("boom")).toBe(false);
  });
});

describe("createXClient", () => {
  it("builds a client with both post methods without touching the network", () => {
    const c = createXClient({
      apiKey: "k",
      apiSecret: "s",
      accessToken: "t",
      accessSecret: "ts",
    });
    expect(typeof c.postText).toBe("function");
    expect(typeof c.postWithPng).toBe("function");
  });
});
