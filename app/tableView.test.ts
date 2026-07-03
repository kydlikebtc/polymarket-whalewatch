import { describe, it, expect } from "vitest";
import { tableViewState, capRows, RENDER_CAP } from "./tableView";

describe("tableViewState", () => {
  it("first fetch with no data yet shows the loading state", () => {
    expect(tableViewState(false, 0, true)).toBe("loading");
  });

  it("no data and not loading renders nothing (pre-first-response)", () => {
    expect(tableViewState(false, 0, false)).toBe("idle");
  });

  it("data present with zero rows shows the empty state only when settled", () => {
    expect(tableViewState(true, 0, false)).toBe("empty");
    // Mid-refetch with a stale empty result: keep rendering nothing, exactly
    // like the pre-existing `!loading` guard.
    expect(tableViewState(true, 0, true)).toBe("idle");
  });

  it("rows win regardless of loading (stale table stays visible on refetch)", () => {
    expect(tableViewState(true, 5, true)).toBe("rows");
    expect(tableViewState(true, 5, false)).toBe("rows");
  });
});

describe("capRows", () => {
  const rows = Array.from({ length: 700 }, (_, i) => i);

  it("passes small result sets through untouched", () => {
    const r = capRows([1, 2, 3], false);
    expect(r.visible).toEqual([1, 2, 3]);
    expect(r.hiddenCount).toBe(0);
  });

  it("truncates to the cap and reports the hidden remainder", () => {
    const r = capRows(rows, false);
    expect(r.visible.length).toBe(RENDER_CAP);
    expect(r.visible[0]).toBe(0);
    expect(r.hiddenCount).toBe(700 - RENDER_CAP);
  });

  it("showAll disables the cap", () => {
    const r = capRows(rows, true);
    expect(r.visible.length).toBe(700);
    expect(r.hiddenCount).toBe(0);
  });

  it("exactly at the cap nothing is hidden", () => {
    const r = capRows(rows.slice(0, RENDER_CAP), false);
    expect(r.visible.length).toBe(RENDER_CAP);
    expect(r.hiddenCount).toBe(0);
  });

  it("honors a custom cap", () => {
    const r = capRows(rows, false, 10);
    expect(r.visible.length).toBe(10);
    expect(r.hiddenCount).toBe(690);
  });
});
