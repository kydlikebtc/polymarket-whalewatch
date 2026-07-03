import { describe, it, expect } from "vitest";
import {
  OUTCOMES_MIN_INTERVAL_MS,
  alertsSnapshot,
  shouldFetchOutcomes,
} from "./alertsPolling";

describe("alertsSnapshot", () => {
  it("fingerprints count + max id, insensitive to order", () => {
    expect(alertsSnapshot([{ id: 3 }, { id: 7 }, { id: 5 }])).toBe("3:7");
    expect(alertsSnapshot([{ id: 7 }, { id: 5 }, { id: 3 }])).toBe("3:7");
  });

  it("changes when a new alert arrives or an old one drops off the window", () => {
    const before = alertsSnapshot([{ id: 1 }, { id: 2 }]);
    // New row appended (id grows).
    expect(alertsSnapshot([{ id: 1 }, { id: 2 }, { id: 3 }])).not.toBe(before);
    // Same max id but fewer rows (oldest aged past the LIMIT window).
    expect(alertsSnapshot([{ id: 2 }])).not.toBe(before);
  });

  it("empty list is a stable fingerprint", () => {
    expect(alertsSnapshot([])).toBe("0:0");
  });
});

describe("shouldFetchOutcomes", () => {
  const known = new Set([1, 2]);

  it("never fires with nothing to fetch", () => {
    expect(
      shouldFetchOutcomes({
        wantIds: [],
        knownIds: new Set(),
        lastFetchAt: 0,
        nowMs: 10_000_000,
      }),
    ).toBe(false);
  });

  it("a never-queried id bypasses the throttle (fresh alert wants marks ASAP)", () => {
    expect(
      shouldFetchOutcomes({
        wantIds: [1, 3],
        knownIds: known,
        lastFetchAt: 1_000,
        nowMs: 2_000, // only 1s after the last POST
      }),
    ).toBe(true);
  });

  it("known-only ids wait out the throttle interval", () => {
    const base = { wantIds: [1, 2], knownIds: known, lastFetchAt: 1_000 };
    expect(
      shouldFetchOutcomes({
        ...base,
        nowMs: 1_000 + OUTCOMES_MIN_INTERVAL_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldFetchOutcomes({ ...base, nowMs: 1_000 + OUTCOMES_MIN_INTERVAL_MS }),
    ).toBe(true);
  });

  it("honors a custom interval", () => {
    expect(
      shouldFetchOutcomes({
        wantIds: [1],
        knownIds: known,
        lastFetchAt: 0,
        nowMs: 5_000,
        minIntervalMs: 4_000,
      }),
    ).toBe(true);
  });
});
