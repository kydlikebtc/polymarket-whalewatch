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

// Sectioned layout, same principles as the bot's 🎯 card (blank lines are
// Telegram's only grouping primitive; one fact per line; bold anchors):
//   block 1  decision head + title (lock-screen preview reads line 1 alone)
//   block 2  smart credentials + the wallet's 📐 track record (when either)
//   block 3  market context + operational notes (burst folding)
//   block 4  🔗 links — signal card + dossier deep links when a public
//            deployment URL is configured, polymarket profile as fallback
export function formatLargeTradeAlert(
  t: Trade,
  smart?: SmartTagLabel | null,
  ctx?: TradeMarketContext | null,
  opts: { publicUrl?: string; recordLine?: string; burstNote?: string } = {},
): string {
  const n = notionalUsd(t);
  const tag = formatSmartTag(smart);
  const whale = n >= WHALE_TIER_USD ? "🐳" : "💰";
  const side = t.side === "SELL" ? "🔴卖出" : "🟢买入";
  const blocks: string[] = [];

  blocks.push(
    `${whale} ${tag ? "🏆 " : ""}${side} <b>${usd(n)}</b> · ${esc(t.outcome)} @ ${cents(t.price)}\n` +
      `<b>${esc(t.title)}</b>`,
  );

  const cred: string[] = [];
  if (tag) cred.push(tag);
  if (opts.recordLine) cred.push(opts.recordLine);
  if (cred.length > 0) blocks.push(cred.join("\n"));

  const context: string[] = [];
  const ctxLine = formatMarketCtxLine(ctx);
  if (ctxLine) context.push(ctxLine);
  if (opts.burstNote) context.push(opts.burstNote);
  if (context.length > 0) blocks.push(context.join("\n"));

  const walletHref = opts.publicUrl
    ? `${opts.publicUrl}/wallet/${urlSeg(t.proxyWallet.toLowerCase())}`
    : `https://polymarket.com/profile/${urlSeg(t.proxyWallet)}`;
  const links: string[] = [];
  if (opts.publicUrl) {
    links.push(
      `<a href="${opts.publicUrl}/market/${urlSeg(t.conditionId)}">🎯 信号卡</a>`,
    );
  }
  links.push(`<a href="${walletHref}">${short(t.proxyWallet)}</a>`);
  links.push(
    `<a href="https://polymarket.com/event/${urlSeg(t.eventSlug)}">市场</a>`,
  );
  links.push(
    `<a href="https://polygonscan.com/tx/${urlSeg(t.transactionHash)}">tx</a>`,
  );
  blocks.push(`🔗 ${links.join(" · ")}`);

  return blocks.join("\n\n");
}
