import { describe, it, expect } from "vitest";
import { parseNumParam, parseChoiceParam, buildQueryString } from "./urlQuery";

describe("parseNumParam", () => {
  it("parses plain integers and floats", () => {
    expect(parseNumParam("10000")).toBe(10000);
    expect(parseNumParam("0.5")).toBe(0.5);
  });

  it("absent / blank / garbage input falls back to null (page default)", () => {
    expect(parseNumParam(null)).toBeNull();
    expect(parseNumParam("")).toBeNull();
    expect(parseNumParam("  ")).toBeNull();
    expect(parseNumParam("abc")).toBeNull();
    expect(parseNumParam("NaN")).toBeNull();
    expect(parseNumParam("Infinity")).toBeNull();
  });

  it("enforces min/max bounds instead of clamping (invalid → default)", () => {
    expect(parseNumParam("0", { min: 1 })).toBeNull();
    expect(parseNumParam("1", { min: 1 })).toBe(1);
    expect(parseNumParam("1.5", { min: 0, max: 1 })).toBeNull();
    expect(parseNumParam("-3", { min: 0 })).toBeNull();
  });

  it("int mode rejects fractional values", () => {
    expect(parseNumParam("7.5", { int: true })).toBeNull();
    expect(parseNumParam("7", { int: true })).toBe(7);
  });
});

describe("parseChoiceParam", () => {
  it("matches string choices exactly", () => {
    expect(parseChoiceParam("BUY", ["ALL", "BUY", "SELL"] as const)).toBe(
      "BUY",
    );
    expect(parseChoiceParam("buy", ["ALL", "BUY", "SELL"] as const)).toBeNull();
  });

  it("matches numeric choices via string form (URL params are strings)", () => {
    expect(parseChoiceParam("6", [1, 6, 24] as const)).toBe(6);
    expect(parseChoiceParam("12", [1, 6, 24] as const)).toBeNull();
  });

  it("absent param falls back to null", () => {
    expect(parseChoiceParam(null, ["a", "b"] as const)).toBeNull();
  });
});

describe("buildQueryString", () => {
  it("omits null/empty values so the default view serializes to a bare path", () => {
    expect(
      buildQueryString([
        ["minUsd", null],
        ["side", null],
        ["minPrice", ""],
      ]),
    ).toBe("");
  });

  it("keeps only non-default entries, in order", () => {
    expect(
      buildQueryString([
        ["minUsd", "50000"],
        ["side", null],
        ["hours", "6"],
      ]),
    ).toBe("?minUsd=50000&hours=6");
  });

  it("round-trips through URLSearchParams + parse helpers (shareable 猎杀视图)", () => {
    const qs = buildQueryString([
      ["minPrice", "0.5"],
      ["maxPrice", "0.9"],
      ["maxAgeDays", "7"],
    ]);
    const p = new URLSearchParams(qs);
    expect(parseNumParam(p.get("minPrice"), { min: 0, max: 1 })).toBe(0.5);
    expect(parseNumParam(p.get("maxPrice"), { min: 0, max: 1 })).toBe(0.9);
    expect(parseNumParam(p.get("maxAgeDays"), { min: 0, int: true })).toBe(7);
  });
});
