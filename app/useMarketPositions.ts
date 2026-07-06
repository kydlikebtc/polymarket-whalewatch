"use client";

import { useEffect, useState } from "react";

export type MarketPos = {
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
};

// wallet(lowercased) -> outcome(lowercased) -> current position
export type PositionsMap = Record<string, Record<string, MarketPos>>;

/**
 * Lazily fetch the CURRENT market positions ("stock") for a set of wallets once
 * `enabled` flips true (a consensus group / disagreement market row is
 * expanded). Fetches a single time per mount; the API caches upstream so a
 * re-expand is cheap. Complements the window net-buy ("flow") already shown.
 */
export function useMarketPositions(
  conditionId: string,
  wallets: string[],
  enabled: boolean,
): { positions: PositionsMap | null; loading: boolean } {
  const [positions, setPositions] = useState<PositionsMap | null>(null);
  const [loading, setLoading] = useState(false);
  const walletsKey = wallets.join(",");

  useEffect(() => {
    if (!enabled || !conditionId || wallets.length === 0 || positions) return;
    let active = true;
    setLoading(true);
    const qs = new URLSearchParams({ conditionId, wallets: walletsKey });
    fetch(`/api/positions?${qs.toString()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (active) setPositions((j.positions as PositionsMap) ?? {});
      })
      .catch(() => {
        if (active) setPositions({});
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // walletsKey (not `wallets`) keeps the effect stable across re-renders.
  }, [enabled, conditionId, walletsKey, positions]);

  return { positions, loading };
}
