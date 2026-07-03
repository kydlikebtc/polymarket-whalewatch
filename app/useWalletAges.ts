"use client";

import { useEffect, useRef, useState } from "react";

// Lazily enrich wallet addresses with their on-chain age via /api/wallet-age.
// Extracted from the (formerly duplicated ~40-line) effects in app/page.tsx and
// app/accumulation/page.tsx, on the same skeleton as useWalletIntel:
//
// Callers pass a freshly-mapped array every render, so the effect keys on a
// STABLE signature of the distinct wallet set (not the array identity), and a
// ref of already-requested wallets makes re-runs no-ops — a parent re-render
// must never cancel in-flight work or re-POST the same batch. Responses merge
// idempotently by wallet key, so late arrivals are always safe to apply;
// failed batches are released from the requested set for a later retry.

// wallet(lowercased) -> ageDays|null. null = lookup done but age unknown.
export type WalletAgeMap = Record<string, number | null>;

/** Stable signature of the distinct lowercased wallet set (order-insensitive). */
export function walletSetKey(wallets: (string | undefined)[]): string {
  return [
    ...new Set(
      wallets
        .map((w) => w?.toLowerCase())
        .filter((w): w is string => Boolean(w)),
    ),
  ]
    .sort()
    .join(",");
}

/** Merge one /api/wallet-age response batch: missing wallets resolve to null. */
export function mergeAgeBatch(
  batch: string[],
  json: { ages?: Record<string, { ageDays: number | null }> },
): WalletAgeMap {
  const next: WalletAgeMap = {};
  for (const w of batch) next[w] = json.ages?.[w]?.ageDays ?? null;
  return next;
}

export function useWalletAges(wallets: (string | undefined)[]): WalletAgeMap {
  const [ages, setAges] = useState<WalletAgeMap>({});
  const requested = useRef<Set<string>>(new Set());

  const key = walletSetKey(wallets);

  useEffect(() => {
    const want = (key ? key.split(",") : []).filter(
      (w) => !requested.current.has(w),
    );
    if (want.length === 0) return;
    for (const w of want) requested.current.add(w);
    let disposed = false;
    (async () => {
      // Chunk so every requested wallet stays under the route's cap and resolves
      // (progressive fill for large result sets instead of dropping the overflow).
      const CHUNK = 100;
      for (let i = 0; i < want.length; i += CHUNK) {
        const batch = want.slice(i, i + CHUNK);
        if (disposed) {
          // Unmounted mid-chain: release the not-yet-fetched remainder so a
          // future mount can request it.
          for (const w of batch) requested.current.delete(w);
          continue;
        }
        try {
          const res = await fetch("/api/wallet-age", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ wallets: batch }),
          });
          const json = (await res.json()) as {
            ages?: Record<string, { ageDays: number | null }>;
          };
          // Never discard a completed response — merging is idempotent.
          setAges((prev) => ({ ...prev, ...mergeAgeBatch(batch, json) }));
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

  return ages;
}
