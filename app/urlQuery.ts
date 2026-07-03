// Bidirectional filter-state ↔ URL search-params sync helpers, shared by the
// three scanner pages (24h 扫描 / 拆单累计 / 聪明钱共识).
//
// Contract:
// - READ happens once on mount (client-only effect, so SSR markup never
//   diverges from the server-rendered defaults → no hydration mismatch).
//   Every param is validated; anything absent/invalid falls back to the
//   page's default — a hand-mangled URL can never produce NaN filters.
// - WRITE uses history.replaceState so tweaking filters does NOT pollute the
//   back/forward history; params equal to the default are omitted to keep
//   shared URLs clean.

/** Parse a numeric param with validation; null = absent/invalid → keep default. */
export function parseNumParam(
  raw: string | null,
  opts: { min?: number; max?: number; int?: boolean } = {},
): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (opts.int && !Number.isInteger(n)) return null;
  if (opts.min != null && n < opts.min) return null;
  if (opts.max != null && n > opts.max) return null;
  return n;
}

/** Parse an enum-like param against its allowed set; null = absent/invalid. */
export function parseChoiceParam<T extends string | number>(
  raw: string | null,
  allowed: readonly T[],
): T | null {
  if (raw == null) return null;
  for (const a of allowed) if (String(a) === raw) return a;
  return null;
}

/**
 * Build a canonical query string. Entries with a null/empty value are omitted
 * (callers pass null for values sitting at the page default), so the default
 * view serializes to "" — a bare pathname.
 */
export function buildQueryString(
  entries: Array<[key: string, value: string | null]>,
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of entries) {
    if (v != null && v !== "") qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/**
 * Write the query string back to the address bar WITHOUT creating a history
 * entry (filter tweaks must not bury the back button). `search` is either ""
 * or a "?…" string from buildQueryString. No-op outside the browser.
 */
export function replaceUrlQuery(search: string): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const { pathname, hash } = window.location;
  window.history.replaceState(null, "", `${pathname}${search}${hash}`);
}
