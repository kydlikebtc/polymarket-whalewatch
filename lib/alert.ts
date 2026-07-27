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
// satisfied by smartWallets.SmartTag; winRate/netPnl optional so legacy
// score-only callers/tests still typecheck. Values may be null — each null
// segment is simply omitted from the label.
export interface SmartTagLabel {
  score: number | null;
  winRate?: number | null;
  netPnl?: number | null; // net P/L (realized + unrealized)
}

// Standalone credentials line: "🏆 聪明钱 72分 · 胜率68% · 盈$1.2M" (null
// segments omitted — an all-null tag degrades to the bare "🏆 聪明钱"). Used
// as its own message line; the headline carries only a compact 🏆 marker so
// the decision head stays scannable.
export function formatSmartTag(
  smart: SmartTagLabel | null | undefined,
): string {
  if (!smart) return "";
  const parts: string[] = [];
  if (smart.score != null) parts.push(`${Math.round(smart.score)}分`);
  if (smart.winRate != null)
    parts.push(`胜率${Math.round(smart.winRate * 100)}%`);
  if (smart.netPnl != null) {
    parts.push(
      smart.netPnl < 0
        ? `亏${usdCompact(-smart.netPnl)}`
        : `盈${usdCompact(smart.netPnl)}`,
    );
  }
  return parts.length > 0 ? `🏆 聪明钱 ${parts.join(" · ")}` : "🏆 聪明钱";
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
  if (ctx.liquidity != null) parts.push(`流动性 ${usdCompact(ctx.liquidity)}`);
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
  opts: { publicUrl?: string } = {},
): string {
  const n = notionalUsd(t);
  const tag = formatSmartTag(smart);
  const whale = n >= WHALE_TIER_USD ? "🐳" : "💰";
  const side = t.side === "SELL" ? "🔴卖出" : "🟢买入";
  // Line 1 is the DECISION HEAD — Telegram's lock-screen notification shows
  // only the first line, so it must carry direction, bolded amount, outcome
  // and ¢ price by itself (a 🏆 marker flags smart money; the full
  // credentials get their own line below). The title reads second.
  const lines = [
    `${whale} ${tag ? "🏆 " : ""}${side} <b>${usd(n)}</b> · ${esc(t.outcome)} @ ${cents(t.price)}`,
    `<b>${esc(t.title)}</b>`,
  ];
  if (tag) lines.push(tag);
  const ctxLine = formatMarketCtxLine(ctx);
  if (ctxLine) lines.push(ctxLine);
  lines.push(
    `<a href="https://polymarket.com/event/${urlSeg(t.eventSlug)}">市场</a> · ` +
      `<a href="https://polymarket.com/profile/${urlSeg(t.proxyWallet)}">${short(t.proxyWallet)}</a> · ` +
      `<a href="https://polygonscan.com/tx/${urlSeg(t.transactionHash)}">tx</a>` +
      // Deep link to this tool's own signal card — the push → dashboard
      // funnel (only when a public deployment URL is configured).
      (opts.publicUrl
        ? ` · <a href="${opts.publicUrl}/market/${urlSeg(t.conditionId)}">🎯 信号卡</a>`
        : ""),
  );
  return lines.join("\n");
}
