import type { WalletStats } from "./walletStats";

// The pool-membership quality gate, shared by EVERY pipeline that writes
// smart_wallets except the global leaderboards (whose top-100 bar is its own
// gate): the discovered-candidate admission (lib/admission) and the
// category-board seeding (lib/smartWallets). Lives in its own module because
// smartWallets → admission would be a require cycle.
//
// Deliberately NOT the 0-100 score: the score's profit axis saturates at $1M
// and would re-import exactly the size bias the discovery channels exist to
// escape. Either a trustworthy settled win rate…
export const ADMIT_MIN_WIN_RATE = 0.55;
export const ADMIT_MIN_SETTLED = 10;
// …or genuine capital efficiency on a profitable book. The ROI path carries
// its own (lower) settled-sample floor: roi is non-null from a SINGLE settled
// position, and one $200 win must not read as "5% capital efficiency".
export const ADMIT_MIN_ROI = 0.05;
export const ADMIT_MIN_SETTLED_ROI = 5;

export type AdmissionVerdict = "admit" | "reject_bot" | "hold";

export function evaluateAdmission(stats: WalletStats | null): AdmissionVerdict {
  if (!stats) return "hold"; // enrichment failed — re-evaluated tomorrow
  if (stats.isMarketMaker) return "reject_bot";
  if (
    stats.winRate != null &&
    stats.settledCount >= ADMIT_MIN_SETTLED &&
    stats.winRate >= ADMIT_MIN_WIN_RATE
  ) {
    return "admit";
  }
  if (
    stats.netPnl != null &&
    stats.netPnl > 0 &&
    stats.roi != null &&
    stats.roi >= ADMIT_MIN_ROI &&
    stats.settledCount >= ADMIT_MIN_SETTLED_ROI
  ) {
    return "admit";
  }
  return "hold";
}
