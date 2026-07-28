import { describe, expect, it } from "vitest";
import { quantizeFloor } from "./scanFloor";

// The scan cache key is (fetch floor : hours). An unquantized floor let a
// caller mint a fresh key — and therefore a fresh two-sided multi-page deep
// fetch, plus a cache entry — with every distinct minUsd value.
describe("quantizeFloor", () => {
  it("snaps to the largest rung at or below the request", () => {
    expect(quantizeFloor(10_000)).toBe(10_000);
    expect(quantizeFloor(9_999)).toBe(5_000);
    expect(quantizeFloor(5_000)).toBe(5_000);
    expect(quantizeFloor(2_500)).toBe(2_000);
    expect(quantizeFloor(1_000)).toBe(1_000);
  });

  it("never returns a floor ABOVE the request (which would hide trades)", () => {
    for (const v of [500, 777, 1234, 4999, 8888, 10_000]) {
      expect(quantizeFloor(v)).toBeLessThanOrEqual(v);
    }
  });

  it("below the ladder, uses the lowest rung", () => {
    expect(quantizeFloor(1)).toBe(500);
    expect(quantizeFloor(499)).toBe(500);
  });

  it("bounds the key space: every possible minUsd maps into the ladder", () => {
    const seen = new Set<number>();
    for (let v = 1; v <= 10_000; v++) seen.add(quantizeFloor(v));
    expect([...seen].sort((a, b) => a - b)).toEqual([
      500, 1000, 2000, 5000, 10_000,
    ]);
  });
});
