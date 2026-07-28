// Fetch-floor quantization for the 24h scanner, kept out of the route file:
// a Next route module may only export its handlers and route config, so a
// helper exported from there fails the generated route-type check (it only
// surfaces once `.next/dev/types` has been regenerated, which is why it can
// pass a fresh `tsc` and break later).
//
// The user's minUsd is applied CLIENT-side, so the only thing the fetch floor
// controls is how deep the upstream sweep goes. Snapping it to a fixed ladder
// keeps the promise-cache key space finite: an unquantized floor let a caller
// mint a brand-new key (and thus a brand-new ~40-page deep fetch, plus a cache
// entry that never expires) with every distinct minUsd from 1..9999. Same
// ALLOWED_* discipline /api/accumulation and /api/consensus already use.
const FLOOR_LADDER: readonly number[] = [500, 1000, 2000, 5000, 10_000];

export function quantizeFloor(minUsd: number): number {
  // Largest ladder rung at or below the request (never ABOVE it — a higher
  // floor would hide trades the caller asked to see); below the ladder, use
  // its lowest rung.
  let floor = FLOOR_LADDER[0];
  for (const rung of FLOOR_LADDER) if (rung <= minUsd) floor = rung;
  return floor;
}
