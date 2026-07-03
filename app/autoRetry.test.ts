import { describe, it, expect } from "vitest";
import { shouldScheduleAutoRetry } from "./autoRetry";

// Pure decision predicate for the scanner pages' one-shot auto retry (the
// hook wiring is thin; the retry/no-retry decision lives here).
describe("shouldScheduleAutoRetry", () => {
  it("retries a failed pull with nothing displayable and a fresh budget", () => {
    expect(
      shouldScheduleAutoRetry({
        hasError: true,
        rowCount: 0,
        hadSuccessSinceArm: false,
        budgetUsed: false,
      }),
    ).toBe(true);
  });

  it("does NOT retry twice for the same user-triggered pull (loop guard)", () => {
    expect(
      shouldScheduleAutoRetry({
        hasError: true,
        rowCount: 0,
        hadSuccessSinceArm: false,
        budgetUsed: true,
      }),
    ).toBe(false);
  });

  it("does NOT retry a background-refresh failure after a success (data already shown)", () => {
    expect(
      shouldScheduleAutoRetry({
        hasError: true,
        rowCount: 0,
        hadSuccessSinceArm: true,
        budgetUsed: false,
      }),
    ).toBe(false);
  });

  it("does NOT retry when the error response somehow carries displayable rows", () => {
    expect(
      shouldScheduleAutoRetry({
        hasError: true,
        rowCount: 12,
        hadSuccessSinceArm: false,
        budgetUsed: false,
      }),
    ).toBe(false);
  });

  it("does NOT retry a successful response", () => {
    expect(
      shouldScheduleAutoRetry({
        hasError: false,
        rowCount: 0,
        hadSuccessSinceArm: false,
        budgetUsed: false,
      }),
    ).toBe(false);
  });
});
