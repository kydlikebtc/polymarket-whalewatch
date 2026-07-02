const CLOB_API = "https://clob.polymarket.com";

// Half-window searched around the target timestamp. fidelity=10 gives ~10min
// candles, so ±30min reliably brackets a point on any active market.
const WINDOW_SEC = 1800;

/**
 * Market price of a token at (or nearest to) `targetTs`, from the CLOB
 * prices-history endpoint ({history:[{t,p}]} — verified live). Returns null
 * when the market has no points in the window (inactive/expired token) —
 * settlement backfill covers those separately via gamma.
 */
export async function fetchPriceAt(
  tokenId: string,
  targetTs: number,
): Promise<number | null> {
  const url =
    `${CLOB_API}/prices-history?market=${tokenId}` +
    `&startTs=${targetTs - WINDOW_SEC}&endTs=${targetTs + WINDOW_SEC}&fidelity=10`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { "User-Agent": "polymarket-monitor" },
  });
  if (!res.ok) throw new Error(`fetchPriceAt ${res.status}`);
  const raw = (await res.json()) as {
    history?: { t: number; p: number }[];
  };
  const points = Array.isArray(raw.history) ? raw.history : [];
  let best: { t: number; p: number } | null = null;
  for (const pt of points) {
    if (
      typeof pt.t !== "number" ||
      typeof pt.p !== "number" ||
      !Number.isFinite(pt.p)
    ) {
      continue;
    }
    if (!best || Math.abs(pt.t - targetTs) < Math.abs(best.t - targetTs)) {
      best = pt;
    }
  }
  return best ? best.p : null;
}
