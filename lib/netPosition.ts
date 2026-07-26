// Net-position primitives shared by every directional detector (P0.6).
//
// The old measure everywhere was `buyUsd − sellUsd` — a CASHFLOW, not a
// position. Buy 20k shares at 75¢ ($15k) and sell all 20k at 25¢ ($5k): the
// USD "net buy" reads +$10k while the wallet holds NOTHING. Detection floors
// applied to that number admit flat (round-tripped) positions as conviction.
//
// The honest measure is share-based:
//   netShares   = buyShares − sellShares      (0 when round-tripped, always)
//   exposureUsd = netShares × avgBuyPrice     (cost basis of what is STILL held)
// exposureUsd is 0 whenever netShares ≤ 0, so any positive USD floor
// automatically rejects flat and net-short-in-window wallets. For a pure buyer
// (no sells) exposureUsd === buyUsd, so thresholds keep their historical
// meaning on the common path.

export interface PositionAcc {
  buyUsd: number;
  sellUsd: number;
  buyShares: number;
  sellShares: number;
}

export function netShares(acc: PositionAcc): number {
  return acc.buyShares - acc.sellShares;
}

export function avgBuyPrice(acc: PositionAcc): number {
  return acc.buyShares > 0 ? acc.buyUsd / acc.buyShares : 0;
}

/** Cost basis of the retained position; 0 when nothing (or negative) is held. */
export function exposureUsd(acc: PositionAcc): number {
  const shares = netShares(acc);
  if (shares <= 0) return 0;
  return shares * avgBuyPrice(acc);
}
