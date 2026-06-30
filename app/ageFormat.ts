// Pure, client-safe age formatting. NO node imports — usable in client components.
export type AgeTone = "new" | "young" | "normal" | "old" | "unknown";

// Render an address age (in days) as a short badge + tone.
// Within 30 days: ALWAYS show the exact day count "🆕 N天" (the key freshness signal),
// red for <7d, amber for 7–30d. Beyond 30 days: coarse months/years, unmarked.
export function formatAge(ageDays: number | null | undefined): {
  text: string;
  tone: AgeTone;
} {
  if (ageDays == null) return { text: "…", tone: "unknown" };
  if (ageDays < 1) {
    // Under a day: drop to hours (or minutes for very fresh) — brand-new wallets matter most.
    const mins = Math.round(ageDays * 1440);
    if (mins < 60) return { text: `🆕 ${Math.max(1, mins)}分钟`, tone: "new" };
    return { text: `🆕 ${Math.round(ageDays * 24)}小时`, tone: "new" };
  }
  const d = Math.floor(ageDays);
  if (d <= 30) return { text: `🆕 ${d}天`, tone: d < 7 ? "new" : "young" };
  if (d < 365)
    return { text: `${Math.max(1, Math.round(d / 30))}月`, tone: "normal" };
  return { text: `${(d / 365).toFixed(1)}年`, tone: "old" };
}

// Tone → color now lives in app/globals.css (.age-* classes), applied by the
// shared <AgeBadge> in app/ui.tsx. Keeps node-free purity for the worker too.
