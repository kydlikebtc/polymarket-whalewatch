"use client";

import { useEffect, useRef, useState } from "react";
import type { SmartInfoLite, WalletStatsLite } from "./ui";

// Pure split of a /api/wallet-stats response for one batch (extracted for unit
// tests, same pattern as useWalletAges.mergeAgeBatch). Distinguishes the two
// null-ish outcomes the server can return per wallet:
//  - a WalletStats object (incl. settledCount:0 = genuinely no settled history)
//    → resolved, merge into state, keep it `requested`.
//  - null / missing = the settled-record fetch FAILED (transient, e.g. data-api
//    429 under a cold burst; the server did NOT cache it) → `retry`, so the
//    caller releases it and a later refresh re-requests it instead of pinning a
//    sticky "—". smart flags come from the local table and always resolve.
export function mergeStatsBatch(
  batch: string[],
  json: {
    stats?: Record<string, WalletStatsLite | null>;
    smart?: Record<string, SmartInfoLite>;
  },
): {
  stats: Record<string, WalletStatsLite>;
  smart: Record<string, SmartInfoLite | null>;
  retry: string[];
} {
  const stats: Record<string, WalletStatsLite> = {};
  const smart: Record<string, SmartInfoLite | null> = {};
  const retry: string[] = [];
  for (const w of batch) {
    smart[w] = json.smart?.[w] ?? null;
    const st = json.stats?.[w];
    if (st == null) retry.push(w);
    else stats[w] = st;
  }
  return { stats, smart, retry };
}

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
          const {
            stats: nextStats,
            smart: nextSmart,
            retry,
          } = mergeStatsBatch(batch, json);
          // Release failed wallets so a later refresh re-requests them (badge
          // shows the loading "…" until the retry lands) instead of a sticky "—".
          for (const w of retry) requested.current.delete(w);
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
