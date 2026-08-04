// Polymarket protocol fees. "Polymarket 零手续费" was true when this project
// started and is NOT true any more — verified live 2026-08-04 against gamma
// /markets, top 100 open markets by 24h volume:
//
//   72 / 100 markets carry feesEnabled=true — 57.8% of all 24h volume
//   feeType spans SEVEN categories, not just sports: sports_fees_v2,
//     politics_fees, crypto_fees_v2, weather_fees, culture_fees,
//     economics_fees, finance_prices_fees
//   feeSchedule: {exponent:1, rate:0.04~0.07, takerOnly:true,
//                 rebateRate:0.15~0.25}
//   closed markets keep returning their schedule (checked on 20 settled rows)
//
// This matters more than anything else in the execution stack: on a live $500
// fill the order-book slippage measured $0.00 while the taker fee was ~2.5% of
// notional. Any "paper" return that omits it is optimistic by the LARGEST
// single cost term.

export interface FeeSchedule {
  /** Observed as 1 on every live sample; anything else is unmodelled. */
  exponent: number;
  /** Fraction, e.g. 0.05. Multiplies shares × p(1−p). */
  rate: number;
  /** Whether only takers pay. Irrelevant to us — see takerFeeUsd. */
  takerOnly: boolean;
  /** Maker rebate. Never enters a taker's cost; carried for completeness. */
  rebateRate: number | null;
}

const posNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/**
 * Normalize a gamma `feeSchedule` object. Returns null for anything we cannot
 * price with confidence — a null propagates as "unknown fee", which the UI
 * renders as an honest blank rather than a zero.
 */
export function parseFeeSchedule(raw: unknown): FeeSchedule | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const exponent = posNum(o.exponent);
  const rate = posNum(o.rate);
  if (exponent == null || rate == null) return null;
  return {
    exponent,
    rate,
    takerOnly: o.takerOnly === true,
    rebateRate: posNum(o.rebateRate),
  };
}

/**
 * Taker fee in USD for a fixed-notional BUY, or null when it cannot be known.
 *
 *   fee = shares × rate × p × (1 − p),  shares = sizeUsd / p
 *       = sizeUsd × rate × (1 − p)
 *
 * The collapsed form is the counter-intuitive one and the one to reason with.
 * `p(1−p)` peaks at 0.5, but that is the shape PER SHARE. For a fixed DOLLAR
 * size the share count (sizeUsd / p) grows as p falls, and the two effects
 * cancel into a plain linear decline in p: $500 at 0.2 costs $20 (4% of
 * notional) while the same $500 at 0.5 costs $12.50 (2.5%). Longshots are the
 * expensive fills, not the 50/50s.
 *
 * `takerOnly` is not a gate here. Whatever it says, this system's follow
 * engine crosses the spread, so it is always the taker.
 *
 * Null (not zero) whenever the answer is unknown: fees are on but the schedule
 * is missing, or the schedule has an exponent shape never observed live.
 * Guessing zero is how the old "no fees" assumption survived for six weeks.
 */
export function takerFeeUsd(opts: {
  sizeUsd: number;
  price: number;
  feesEnabled: boolean;
  schedule: FeeSchedule | null;
}): number | null {
  const { sizeUsd, price, feesEnabled, schedule } = opts;
  // A market with fees genuinely off costs nothing — that is a known 0.
  if (!feesEnabled) return 0;
  if (!schedule) return null;
  // Only exponent 1 has ever been observed; the general form is unknown.
  if (schedule.exponent !== 1) return null;
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return null;
  const shares = sizeUsd / price;
  return shares * schedule.rate * price * (1 - price);
}
