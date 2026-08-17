// Pure, client-safe age formatting. NO node imports — usable in client components.
import type { Lang } from "../lib/i18n/core";

export type AgeTone = "new" | "young" | "normal" | "old" | "unknown";

// Render an address age (in days) as a short badge + tone.
// Within 30 days: ALWAYS show the exact day count "🆕 N天" (the key freshness signal),
// red for <7d, amber for 7–30d. Beyond 30 days: coarse months/years, unmarked.
// 双语:单位随 lang 切换(en 用 m/h/d/mo/y 短记法);组合发生在函数内部,
// 走参数而非 t() 字典 —— 保持本模块零 React/字典依赖(worker 也能用)。
export function formatAge(
  ageDays: number | null | undefined,
  lang: Lang = "zh",
): {
  text: string;
  tone: AgeTone;
} {
  const en = lang === "en";
  if (ageDays == null) return { text: "…", tone: "unknown" };
  if (ageDays < 1) {
    // Under a day: drop to hours (or minutes for very fresh) — brand-new wallets matter most.
    const mins = Math.round(ageDays * 1440);
    if (mins < 60) {
      return {
        text: `🆕 ${Math.max(1, mins)}${en ? "m" : "分钟"}`,
        tone: "new",
      };
    }
    return {
      text: `🆕 ${Math.round(ageDays * 24)}${en ? "h" : "小时"}`,
      tone: "new",
    };
  }
  const d = Math.floor(ageDays);
  if (d <= 30) {
    return { text: `🆕 ${d}${en ? "d" : "天"}`, tone: d < 7 ? "new" : "young" };
  }
  if (d < 365) {
    return {
      text: `${Math.max(1, Math.round(d / 30))}${en ? "mo" : "月"}`,
      tone: "normal",
    };
  }
  return { text: `${(d / 365).toFixed(1)}${en ? "y" : "年"}`, tone: "old" };
}

// Tone → color now lives in app/globals.css (.age-* classes), applied by the
// shared <AgeBadge> in app/ui.tsx. Keeps node-free purity for the worker too.
