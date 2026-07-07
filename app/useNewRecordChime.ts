"use client";

import { useEffect, useRef } from "react";
import { playBubble } from "./sound";

// New-record chime, shared by the 24h scanner / 拆单累计 / 共识·分歧 pages.
// Each page owns "what is a record" (its stable row keys) and "what makes a
// query" (a filter signature). A refresh that keeps the SAME filter and brings
// keys not seen before rings; changing the filter reseeds the baseline SILENTLY
// (that is a new query, not a record arriving), so switching filters never rings.

export type ChimeState = { sig: string | null; seen: Set<string> };

// Pure fold of one (sig, keys) observation into the seen-set, returning the next
// state and whether to ring. Extracted from the hook so the ring/reseed rules
// are unit-testable without React (same pattern as mergeStatsBatch/mergeAgeBatch).
export function chimeStep(
  prev: ChimeState,
  sig: string,
  keys: string[],
): { state: ChimeState; ring: boolean } {
  // Filter changed (or first observation): adopt these keys as the baseline and
  // stay silent — none of them is "newly arrived", they are just the new query.
  if (sig !== prev.sig) {
    return { state: { sig, seen: new Set(keys) }, ring: false };
  }
  const seen = new Set(prev.seen);
  let ring = false;
  for (const k of keys) {
    if (!seen.has(k)) {
      seen.add(k);
      ring = true;
    }
  }
  return { state: { sig, seen }, ring };
}

// `sig` null = data not loaded yet (no-op). `enabled` gates the actual sound
// (the useSoundToggle preference) while the seen-set keeps tracking regardless,
// so toggling sound on mid-session doesn't retro-ring the whole current list.
export function useNewRecordChime(
  sig: string | null,
  keys: string[],
  enabled: boolean,
): void {
  const state = useRef<ChimeState>({ sig: null, seen: new Set() });
  // Depend on the joined key content (not the array identity, which churns every
  // render on expand toggles etc.) so the effect runs only when data changes.
  const keysSig = keys.join(",");
  useEffect(() => {
    if (sig == null) return;
    const { state: next, ring } = chimeStep(state.current, sig, keys);
    state.current = next;
    if (ring && enabled) playBubble();
    // keys is intentionally read via keysSig; sig/enabled complete the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, keysSig, enabled]);
}
