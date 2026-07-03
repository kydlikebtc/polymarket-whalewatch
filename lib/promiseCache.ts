// TTL'd promise cache, extracted from the consensus route's getWindowShared:
// the cache holds the PROMISE, not the resolved value, so concurrent misses
// join ONE in-flight load instead of each firing their own upstream pull (a
// deep window fetch is up to ~14 requests with retries — a cold-cache
// stampede multiplies that). Used by the scan/accumulation/consensus routes.
export function createPromiseCache<T>(ttlMs: number) {
  const cache = new Map<string, { at: number; promise: Promise<T> }>();
  return function shared(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
    const entry = { at: Date.now(), promise: load() };
    // A failed load must not stay cached, or every request within the TTL
    // would re-reject without retrying. Only evict OUR entry: a stale
    // rejection must not drop a newer (possibly successful) replacement.
    entry.promise.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    cache.set(key, entry);
    return entry.promise;
  };
}
