import { describe, it, expect } from "vitest";
import { computeMinTimestamp } from "./embeddedEngine";

describe("computeMinTimestamp (startup backfill window)", () => {
  const NOW = 1_700_000_000;
  const CAP = 30 * 60;

  it("cold db (no seen rows) starts at now — no historical replay", () => {
    expect(computeMinTimestamp(null, NOW, CAP)).toBe(NOW);
  });

  it("resumes from the last seen trade after a short restart gap", () => {
    expect(computeMinTimestamp(NOW - 120, NOW, CAP)).toBe(NOW - 120);
  });

  it("caps the backfill window after a long outage", () => {
    expect(computeMinTimestamp(NOW - 86_400, NOW, CAP)).toBe(NOW - CAP);
  });

  it("never resumes from the future (clock skew / bad ts)", () => {
    expect(computeMinTimestamp(NOW + 999, NOW, CAP)).toBe(NOW);
  });
});
