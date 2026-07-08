const CLOB_API = "https://clob.polymarket.com";

// Half-window searched around the target timestamp. fidelity=10 gives ~10min
// candles, so ±30min reliably brackets a point on any active market.
const WINDOW_SEC = 1800;

/**
 * Market price of a token at (or nearest to) `targetTs`, from the CLOB
 * prices-history endpoint ({history:[{t,p}]} — verified live). Returns null
 * when the market has no points in the window (inactive/expired token) —
 * settlement backfill covers those separately via gamma.
 *
 * opts.atOrBefore=true 时只在 t <= targetTs 的点里取最近的(无 ≤targetTs 的点
 * 返回 null)。用途:回查共识「形成时刻」的价格 —— 形成后价格通常朝进场方向移动,
 * 取"之后的最近点"会系统性低估延迟成本(前视偏差)。默认行为完全不变,现有
 * 调用(alertOutcomes 的 1h/24h 回看、follow 现价)零影响。
 */
export async function fetchPriceAt(
  tokenId: string,
  targetTs: number,
  opts?: { atOrBefore?: boolean },
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
    // atOrBefore:targetTs 之后的点一律不参赛(防前视,见函数注释)。
    if (opts?.atOrBefore && pt.t > targetTs) continue;
    if (!best || Math.abs(pt.t - targetTs) < Math.abs(best.t - targetTs)) {
      best = pt;
    }
  }
  return best ? best.p : null;
}
