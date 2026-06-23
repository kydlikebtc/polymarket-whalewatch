import type { Trade } from "./types";
import { notionalUsd } from "./trades";
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export function formatLargeTradeAlert(
  t: Trade,
  tier: number,
  smart?: { score: number },
): string {
  const n = notionalUsd(t);
  const tag = smart ? `🏆 聪明钱(${smart.score.toFixed(0)}) ` : "";
  // 🐳 only for the top tier (>= $50k); 💰 otherwise
  const whale = n >= tier && tier >= 50000 ? "🐳 " : "💰 ";
  return [
    `${whale}${tag}<b>${esc(t.title)}</b>`,
    `${esc(t.outcome)} · <b>${t.side}</b> · ${usd(n)} @ ${t.price.toFixed(3)}`,
    `<a href="https://polymarket.com/event/${t.eventSlug}">市场</a> · ` +
      `<a href="https://polymarket.com/profile/${t.proxyWallet}">${short(t.proxyWallet)}</a> · ` +
      `<a href="https://polygonscan.com/tx/${t.transactionHash}">tx</a>`,
  ].join("\n");
}
