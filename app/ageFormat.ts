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
  const d = Math.floor(ageDays);
  if (d <= 30) return { text: `🆕 ${d}天`, tone: d < 7 ? "new" : "young" };
  if (d < 365)
    return { text: `${Math.max(1, Math.round(d / 30))}月`, tone: "normal" };
  return { text: `${(d / 365).toFixed(1)}年`, tone: "old" };
}

export const ageColor: Record<AgeTone, string> = {
  new: "#ef4444",
  young: "#f59e0b",
  normal: "#8aa0c0",
  old: "#6f819c",
  unknown: "#6f819c",
};
