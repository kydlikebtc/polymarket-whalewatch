// PUSD (Polymarket USD) cash balance via Polygon RPC. PUSD is the collateral
// token deposits get minted into (CollateralOnramp) — a wallet's PUSD balance
// is its idle, not-yet-wagered cash on Polymarket.
// Verified live: decimals() = 6; balanceOf via public RPC matches reality.
const PUSD_CONTRACT = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
const DECIMALS = 1e6;

// balanceOf(address) selector.
const BALANCE_OF = "0x70a08231";

// Public Polygon RPCs, tried in order (current-state eth_call needs no archive
// node). Both verified reachable; polygon-rpc.com is dead and Blockscout's
// tokenbalance module returns empty results, so neither is listed.
const DEFAULT_RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://1rpc.io/matic",
];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Current PUSD balance of a wallet in USD, or null when the address is
 * malformed or every RPC fails. Balances move constantly — no caching here;
 * callers decide their own freshness policy.
 */
export async function fetchPusdBalance(
  wallet: string,
  opts: { rpcs?: string[] } = {},
): Promise<number | null> {
  const { rpcs = DEFAULT_RPCS } = opts;
  if (!ADDRESS_RE.test(wallet)) return null;
  const data = BALANCE_OF + wallet.toLowerCase().slice(2).padStart(64, "0");
  for (const rpc of rpcs) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: PUSD_CONTRACT, data }, "latest"],
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { result?: unknown };
      if (typeof json.result !== "string" || !json.result.startsWith("0x")) {
        continue; // RPC-level error object → try the next endpoint
      }
      return Number(BigInt(json.result)) / DECIMALS;
    } catch {
      // Timeout / network / parse — fall through to the next RPC.
    }
  }
  console.warn(`[pusdBalance] all RPCs failed for ${wallet}`);
  return null;
}
