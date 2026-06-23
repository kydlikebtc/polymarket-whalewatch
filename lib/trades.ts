import type { Trade } from "./types";
export const notionalUsd = (t: Pick<Trade, "size" | "price">) =>
  t.size * t.price;
export const dedupKey = (
  t: Pick<Trade, "transactionHash" | "asset" | "proxyWallet" | "side" | "size">,
) => `${t.transactionHash}:${t.asset}:${t.proxyWallet}:${t.side}:${t.size}`;
