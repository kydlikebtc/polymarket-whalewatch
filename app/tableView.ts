// Pure view helpers for the scanner tables (24h 扫描 / 拆单累计), extracted so
// the first-screen branching and the render cap are unit-testable without
// rendering React.

export type TableViewState = "loading" | "empty" | "rows" | "idle";

/**
 * Decide what the table area shows. "loading" only covers the FIRST fetch
 * (no data yet) — a deep 24h pull can take 5–15s and a blank screen reads as
 * "the tool is broken". Later refetches keep the stale table visible instead
 * of flashing a spinner (matches the pre-existing behavior).
 */
export function tableViewState(
  hasData: boolean,
  rowCount: number,
  loading: boolean,
): TableViewState {
  if (!hasData) return loading ? "loading" : "idle";
  if (rowCount === 0) return loading ? "idle" : "empty";
  return "rows";
}

/** Default DOM row cap: ~6000-row low-floor scans render 300 rows initially. */
export const RENDER_CAP = 300;

/**
 * Cap how many rows actually render. Sorting/filtering/stat cards keep
 * operating on the FULL data set — only the DOM row count is truncated, and
 * the caller shows a "显示其余 N 行" button when hiddenCount > 0.
 */
export function capRows<T>(
  rows: T[],
  showAll: boolean,
  cap: number = RENDER_CAP,
): { visible: T[]; hiddenCount: number } {
  if (showAll || rows.length <= cap) return { visible: rows, hiddenCount: 0 };
  return { visible: rows.slice(0, cap), hiddenCount: rows.length - cap };
}
