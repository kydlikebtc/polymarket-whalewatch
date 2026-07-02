import type { Trade } from "./types";
import type { TradeMarketContext } from "./gamma";
import { notionalUsd } from "./trades";
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// "占24h量 18% · 流动性 $229,073 · 距结算 5h" — whichever parts are known.
// Returns null when the context carries nothing displayable.
export function formatMarketCtxLine(
  ctx: TradeMarketContext | null | undefined,
): string | null {
  if (!ctx) return null;
  const parts: string[] = [];
  if (ctx.impact24h != null) {
    const pct = ctx.impact24h * 100;
    parts.push(`占24h量 ${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`);
  }
  if (ctx.liquidity != null) parts.push(`流动性 ${usd(ctx.liquidity)}`);
  if (ctx.hoursToEnd != null) {
    parts.push(
      ctx.hoursToEnd < 48
        ? `距结算 ${Math.round(ctx.hoursToEnd)}h`
        : `距结算 ${Math.round(ctx.hoursToEnd / 24)}天`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function formatLargeTradeAlert(
  t: Trade,
  tier: number,
  smart?: { score: number | null },
  ctx?: TradeMarketContext | null,
): string {
  const n = notionalUsd(t);
  const tag = smart
    ? smart.score != null
      ? `🏆 聪明钱(${smart.score.toFixed(0)}) `
      : "🏆 聪明钱 "
    : "";
  // tier is already the highest threshold n cleared (see runOnce), so 🐳 = top tier (>= $50k)
  const whale = tier >= 50000 ? "🐳 " : "💰 ";
  const lines = [
    `${whale}${tag}<b>${esc(t.title)}</b>`,
    `${esc(t.outcome)} · <b>${t.side}</b> · ${usd(n)} @ ${t.price.toFixed(3)}`,
  ];
  const ctxLine = formatMarketCtxLine(ctx);
  if (ctxLine) lines.push(ctxLine);
  lines.push(
    `<a href="https://polymarket.com/event/${t.eventSlug}">市场</a> · ` +
      `<a href="https://polymarket.com/profile/${t.proxyWallet}">${short(t.proxyWallet)}</a> · ` +
      `<a href="https://polygonscan.com/tx/${t.transactionHash}">tx</a>`,
  );
  return lines.join("\n");
}
