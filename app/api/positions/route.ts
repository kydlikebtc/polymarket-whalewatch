import {
  fetchWalletMarketPositions,
  type MarketPosition,
} from "../../../lib/holdings";
import { mapLimit } from "../../../lib/mapLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CID_RE = /^0x[0-9a-fA-F]{64}$/;
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_WALLETS = 150; // a busy disagreement market can have 25+ wallets PER side
const CACHE_TTL_MS = 60_000; // current positions move; a minute is fresh enough
const CACHE_MAX = 2000;

// (wallet:conditionId) -> current positions, briefly cached so re-expanding a
// group / flipping the tab doesn't refetch. Bounded with oldest-first eviction.
const cache = new Map<
  string,
  { at: number; positions: Record<string, MarketPosition> }
>();

async function getCached(
  wallet: string,
  conditionId: string,
): Promise<Record<string, MarketPosition>> {
  const key = `${wallet}:${conditionId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.positions;
  const positions = await fetchWalletMarketPositions(wallet, conditionId);
  while (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), positions });
  return positions;
}

// GET ?conditionId=<0x…64>&wallets=<0x…,0x…>
// → { conditionId, positions: { [wallet]: { [outcome]: MarketPosition } } }
// The current-holding ("stock") reference for the consensus/disagreement wallets
// whose window net-buy ("flow") is already shown. Called lazily on row expand.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const conditionId = String(url.searchParams.get("conditionId") ?? "");
  if (!CID_RE.test(conditionId)) {
    return Response.json({
      conditionId,
      positions: {},
      error: "invalid conditionId",
    });
  }
  const wallets = [
    ...new Set(
      String(url.searchParams.get("wallets") ?? "")
        .split(",")
        .map((w) => w.trim().toLowerCase())
        .filter((w) => WALLET_RE.test(w)),
    ),
  ].slice(0, MAX_WALLETS);

  try {
    const results = await mapLimit(wallets, 6, async (w) => {
      try {
        return { w, positions: await getCached(w, conditionId) };
      } catch (e) {
        console.warn(`[/api/positions] ${w} failed:`, e);
        return { w, positions: {} as Record<string, MarketPosition> };
      }
    });
    const positions: Record<string, Record<string, MarketPosition>> = {};
    for (const r of results) positions[r.w] = r.positions;
    return Response.json({ conditionId, positions });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/positions] failed:", message);
    return Response.json({ conditionId, positions: {}, error: message });
  }
}
