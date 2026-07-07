import { describe, it, expect } from "vitest";
import { chimeStep, type ChimeState } from "./useNewRecordChime";

const st = (sig: string | null, keys: string[] = []): ChimeState => ({
  sig,
  seen: new Set(keys),
});

describe("chimeStep", () => {
  it("first observation seeds the baseline silently (no ring)", () => {
    const r = chimeStep(st(null), "f1", ["a", "b"]);
    expect(r.ring).toBe(false);
    expect([...r.state.seen].sort()).toEqual(["a", "b"]);
    expect(r.state.sig).toBe("f1");
  });

  it("a filter change reseeds silently even when keys differ", () => {
    const r = chimeStep(st("f1", ["a", "b"]), "f2", ["c", "d"]);
    expect(r.ring).toBe(false); // switching filters must never ring
    expect([...r.state.seen].sort()).toEqual(["c", "d"]);
    expect(r.state.sig).toBe("f2");
  });

  it("same filter + a genuinely new key rings and records it", () => {
    const r = chimeStep(st("f1", ["a", "b"]), "f1", ["a", "b", "c"]);
    expect(r.ring).toBe(true);
    expect([...r.state.seen].sort()).toEqual(["a", "b", "c"]);
  });

  it("same filter with no new keys does not ring", () => {
    const r = chimeStep(st("f1", ["a", "b"]), "f1", ["a", "b"]);
    expect(r.ring).toBe(false);
  });

  it("a shrinking list (rows aged out) does not ring", () => {
    const r = chimeStep(st("f1", ["a", "b", "c"]), "f1", ["a"]);
    expect(r.ring).toBe(false);
    // seen is retained so a re-appearing key won't double-ring.
    expect(r.state.seen.has("b")).toBe(true);
  });

  it("does not mutate the previous state (returns a fresh set)", () => {
    const prev = st("f1", ["a"]);
    const r = chimeStep(prev, "f1", ["a", "b"]);
    expect([...prev.seen]).toEqual(["a"]); // untouched
    expect(r.state.seen.has("b")).toBe(true);
  });
});
