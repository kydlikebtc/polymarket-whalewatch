// Shared Telegram-HTML formatting helpers for the alert format functions
// (lib/alert.ts / lib/consensus.ts). Previously each file kept its own copies —
// a patch to one was easy to miss in the other; this module is the single home.

// Text-node escaping (Telegram HTML parse_mode understands only a tag subset;
// &<> are the load-bearing entities for text content).
export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Attribute-value escaping: like esc but ALSO escapes double quotes — a bare
// `"` inside href="..." truncates the attribute and yields Telegram's
// 400 "can't parse entities", the classic poison-message source.
export const escAttr = (s: string): string => esc(s).replace(/"/g, "&quot;");

// A dynamic URL PATH SEGMENT destined for an href attribute:
// encodeURIComponent kills quotes/spaces/separators at the source (so the URL
// itself is valid), escAttr on top is the belt-and-braces layer for the HTML
// attribute context. Every slug/wallet/txhash interpolation must go through
// this instead of raw string templating.
export const urlSeg = (s: string): string => escAttr(encodeURIComponent(s));

export const usd = (n: number): string =>
  "$" + Math.round(n).toLocaleString("en-US");

// Polymarket-style price notation: 0.532 → "53.2¢", 0.5 → "50¢". One decimal,
// trailing ".0" trimmed — matches how the Polymarket UI prints prices, so a
// pushed price can be eyeballed against the order book without conversion.
export const cents = (p: number): string => {
  const s = (p * 100).toFixed(1);
  return (s.endsWith(".0") ? s.slice(0, -2) : s) + "¢";
};

// Compact dollar magnitude for tight label contexts ("盈$1.2M"): $1.2M / $850K
// / $900. Trailing ".0" trimmed; the K bucket rounding up to 1000 promotes to
// $1M instead of the nonsensical "$1000K".
export const usdCompact = (n: number): string => {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    const s = (abs / 1_000_000).toFixed(1);
    return `${sign}$${s.endsWith(".0") ? s.slice(0, -2) : s}M`;
  }
  if (abs >= 1_000) {
    const k = Math.round(abs / 1_000);
    return k >= 1_000 ? `${sign}$1M` : `${sign}$${k}K`;
  }
  return `${sign}$${Math.round(abs)}`;
};

// Duration for message copy: <60min → whole minutes (sub-minute clamps to
// "1 分钟"), otherwise hours with one decimal ("3.5 小时", ".0" trimmed).
export const durText = (sec: number): string => {
  const s = Math.max(0, sec);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} 分钟`;
  const h = (s / 3600).toFixed(1);
  return `${h.endsWith(".0") ? h.slice(0, -2) : h} 小时`;
};

export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
