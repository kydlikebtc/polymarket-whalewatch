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

export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
