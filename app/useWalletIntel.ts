"use client";

import { useEffect, useRef, useState } from "react";
import type { SmartInfoLite, WalletStatsLite } from "./ui";

// Lazily enrich wallet addresses with settled-market stats + smart-wallet flags
// via /api/wallet-stats.
//
// Callers pass a freshly-mapped array every render, so the effect keys on a
// STABLE signature of the distinct wallet set (not the array identity), and a
// ref of already-requested wallets makes re-runs no-ops — a parent re-render
// must never cancel in-flight work or re-POST the same batch. Responses merge
// idempotently by wallet key, so late arrivals are always safe to apply;
// failed batches are released from the requested set for a later retry.
export function useWalletIntel(wallets: (string | undefined)[]) {
  const [stats, setStats] = useState<Record<string, WalletStatsLite | null>>(
    {},
  );
  const [smart, setSmart] = useState<Record<string, SmartInfoLite | null>>({});
  const requested = useRef<Set<string>>(new Set());

  const key = [
    ...new Set(
      wallets
        .map((w) => w?.toLowerCase())
        .filter((w): w is string => Boolean(w)),
    ),
  ]
    .sort()
    .join(",");

  useEffect(() => {
    const want = (key ? key.split(",") : []).filter(
      (w) => !requested.current.has(w),
    );
    if (want.length === 0) return;
    for (const w of want) requested.current.add(w);
    let disposed = false;
    (async () => {
      // Chunk under the route's cap; sequential batches keep upstream fan-out sane.
      const CHUNK = 50;
      for (let i = 0; i < want.length; i += CHUNK) {
        const batch = want.slice(i, i + CHUNK);
        if (disposed) {
          // Unmounted mid-chain: release the not-yet-fetched remainder so a
          // future mount can request it.
          for (const w of batch) requested.current.delete(w);
          continue;
        }
        try {
          const res = await fetch("/api/wallet-stats", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ wallets: batch }),
          });
          const json = (await res.json()) as {
            stats?: Record<string, WalletStatsLite | null>;
            smart?: Record<string, SmartInfoLite>;
          };
          const nextStats: Record<string, WalletStatsLite | null> = {};
          const nextSmart: Record<string, SmartInfoLite | null> = {};
          for (const w of batch) {
            nextStats[w] = json.stats?.[w] ?? null;
            nextSmart[w] = json.smart?.[w] ?? null;
          }
          // Never discard a completed response — merging is idempotent.
          setStats((prev) => ({ ...prev, ...nextStats }));
          setSmart((prev) => ({ ...prev, ...nextSmart }));
        } catch {
          // Release the failed batch so it can be retried later.
          for (const w of batch) requested.current.delete(w);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [key]);

  return { stats, smart };
}
