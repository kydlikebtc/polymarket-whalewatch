import type { Trade } from "./types";
export const notionalUsd = (t: Pick<Trade, "size" | "price">) =>
  t.size * t.price;
export const dedupKey = (
  t: Pick<Trade, "transactionHash" | "asset" | "proxyWallet" | "side" | "size">,
) => `${t.transactionHash}:${t.asset}:${t.proxyWallet}:${t.side}:${t.size}`;

// Last visible trade price per asset (max-timestamp wins; ties keep the first
// seen). Shared by the follow engine's mark pricing and the consensus push's
// chase-cost line — both read it off a window that was already fetched.
export function latestPriceByAsset(
  trades: Pick<Trade, "asset" | "timestamp" | "price">[],
): Map<string, number> {
  const latestTs = new Map<string, number>();
  const price = new Map<string, number>();
  for (const t of trades) {
    const prev = latestTs.get(t.asset);
    if (prev == null || t.timestamp > prev) {
      latestTs.set(t.asset, t.timestamp);
      price.set(t.asset, t.price);
    }
  }
  return price;
}
