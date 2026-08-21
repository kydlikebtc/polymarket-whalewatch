// TTL'd, size-bounded in-memory value cache — the value-holding sibling of
// lib/promiseCache (which caches the in-flight PROMISE to collapse stampedes).
//
// Use this one when the cached thing is cheap to re-fetch but the KEY SPACE is
// attacker-enumerable: /api/wallet is keyed by address, and every address on
// the public leaderboard is a valid key, so an unbounded Map is a slow memory
// leak with a public trigger. `max` caps it; eviction is oldest-first via Map
// insertion order.
//
// Give each payload its OWN instance rather than bundling several under one
// entry: a shared TTL is always set by the slowest-moving member, which makes
// the fast-moving ones stale for no benefit. That bundling is exactly what put
// a 10-minute-old holdings book next to Polymarket's live one on the wallet
// dossier — see the TTL rationale in app/api/wallet/[address]/route.ts.
export interface BoundedCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
}

export function createBoundedCache<T>(
  ttlMs: number,
  max = 500,
): BoundedCache<T> {
  const map = new Map<string, { at: number; value: T }>();
  return {
    get(key) {
      const hit = map.get(key);
      return hit && Date.now() - hit.at < ttlMs ? hit.value : undefined;
    },
    set(key, value) {
      // Delete-then-set so a refreshed key moves to the END of the insertion
      // order. Plain `Map.set` on an existing key KEEPS its original slot, so
      // without this the hottest (most-refreshed) key is the first one evicted
      // — precisely backwards.
      map.delete(key);
      while (map.size >= max) {
        const oldest = map.keys().next().value;
        if (oldest == null) break;
        map.delete(oldest);
      }
      map.set(key, { at: Date.now(), value });
    },
  };
}
