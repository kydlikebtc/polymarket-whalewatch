import type { Trade } from "./types";
import type { TradeMarketContext } from "./gamma";
import { notionalUsd } from "./trades";
import { cents, esc, short, urlSeg, usd, usdCompact } from "./tgFormat";

// FIXED notional tier for the leading emoji: the first character of the
// message must encode trade SIZE, not configuration. (The old `tier` param
// leaked conditions.minUsd here — minUsd=$10k showed 💰 for a $500k fill,
// minUsd≥$50k made everything 🐳.) Matches the dashboard's 🐳 cutoff
// (app/page.tsx / app/alerts/page.tsx) and the glossary entry.
export const WHALE_TIER_USD = 50_000;

// The slice of a smart-wallet tag the alert label renders. Structurally
// satisfied by smartWallets.SmartTag; winRate/realizedPnl optional so legacy
// score-only callers/tests still typecheck. Values may be null — each null
// segment is simply omitted from the label.
export interface SmartTagLabel {
  score: number | null;
  winRate?: number | null;
  realizedPnl?: number | null;
}

// "🏆 聪明钱 72分·胜率68%·盈$1.2M " (trailing space; null segments omitted —
// an all-null tag degrades to the bare "🏆 聪明钱 ").
export function formatSmartTag(
  smart: SmartTagLabel | null | undefined,
): string {
  if (!smart) return "";
  const parts: string[] = [];
  if (smart.score != null) parts.push(`${Math.round(smart.score)}分`);
  if (smart.winRate != null)
    parts.push(`胜率${Math.round(smart.winRate * 100)}%`);
  if (smart.realizedPnl != null) {
    parts.push(
      smart.realizedPnl < 0
        ? `亏${usdCompact(-smart.realizedPnl)}`
        : `盈${usdCompact(smart.realizedPnl)}`,
    );
  }
  return parts.length > 0 ? `🏆 聪明钱 ${parts.join("·")} ` : "🏆 聪明钱 ";
}

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
  smart?: SmartTagLabel | null,
  ctx?: TradeMarketContext | null,
): string {
  const n = notionalUsd(t);
  const tag = formatSmartTag(smart);
  const whale = n >= WHALE_TIER_USD ? "🐳 " : "💰 ";
  // Decision essentials first: direction (color-coded), bolded amount, then
  // outcome @ price in Polymarket's ¢ notation.
  const side = t.side === "SELL" ? "🔴卖出" : "🟢买入";
  const lines = [
    `${whale}${tag}<b>${esc(t.title)}</b>`,
    `${side} <b>${usd(n)}</b> · ${esc(t.outcome)} @ ${cents(t.price)}`,
  ];
  const ctxLine = formatMarketCtxLine(ctx);
  if (ctxLine) lines.push(ctxLine);
  lines.push(
    `<a href="https://polymarket.com/event/${urlSeg(t.eventSlug)}">市场</a> · ` +
      `<a href="https://polymarket.com/profile/${urlSeg(t.proxyWallet)}">${short(t.proxyWallet)}</a> · ` +
      `<a href="https://polygonscan.com/tx/${urlSeg(t.transactionHash)}">tx</a>`,
  );
  return lines.join("\n");
}
