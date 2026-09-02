import { describe, it, expect, vi } from "vitest";
import {
  computeMinTimestamp,
  followCycleSummary,
  maybeStartupPing,
  STARTUP_PING_HTML,
} from "./embeddedEngine";

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

describe("maybeStartupPing (opt-in connectivity check)", () => {
  it("pushes the online message when enabled and a send exists", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    maybeStartupPing(send, true);
    expect(send).toHaveBeenCalledExactlyOnceWith(STARTUP_PING_HTML);
  });

  it("does nothing when disabled (default) or when Telegram is off", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    maybeStartupPing(send, false);
    expect(send).not.toHaveBeenCalled();
    // telegramEnabled=false → no send function at all; must not crash.
    maybeStartupPing(undefined, true);
  });

  it("a failed ping logs and never rejects unhandled (7×24 startup path)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn().mockRejectedValue(new Error("401 Unauthorized"));
    maybeStartupPing(send, true);
    // Drain the fire-and-forget promise chain.
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("startup ping FAILED"),
      expect.any(Error),
    );
    errSpy.mockRestore();
  });
});

describe("followCycleSummary (engine-level follow cycle log line)", () => {
  // The engine used to print `[engine] follow cycle` only when opened>0 ||
  // settled>0, so a round that merely reconciled stray settlements was silent
  // at engine level — and a persistently non-zero sigReconciled is the ONLY
  // sign that the settlement backfill path is failing (SQLITE_BUSY / disk).
  it("an all-zero cycle stays silent (null) — nothing happened, nothing to log", () => {
    expect(
      followCycleSummary({ opened: 0, settled: 0, sigReconciled: 0 }),
    ).toBeNull();
  });

  it("opened/settled > 0 → one line carrying all three counters", () => {
    const line = followCycleSummary({ opened: 2, settled: 1, sigReconciled: 0 });
    expect(line).toContain("[engine] follow cycle");
    expect(line).toContain("opened 2");
    expect(line).toContain("settled 1");
    expect(line).toContain("sigReconciled 0");
  });

  it("a pure reconcile round (only sigReconciled > 0) is no longer silent and names the counter", () => {
    const line = followCycleSummary({ opened: 0, settled: 0, sigReconciled: 3 });
    expect(line).not.toBeNull();
    expect(line).toContain("sigReconciled 3");
  });
});
