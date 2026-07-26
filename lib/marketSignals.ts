import type { ConsensusGroup } from "./consensus";
import type { DisagreementMarket } from "./disagreement";

/**
 * Make the consensus and disagreement lists MUTUALLY EXCLUSIVE at the market
 * level. detectConsensus keys groups by (conditionId, outcome), so a market
 * with smart money on BOTH opposing outcomes surfaces as TWO one-sided groups —
 * reading as two separate "consensuses" when it is really a DISAGREEMENT. Given
 * the disagreement markets (same window, same smart pool), drop every consensus
 * group whose conditionId is contested, so each market lands in exactly one
 * bucket: one-sided → consensus, split → disagreement.
 *
 * Shared by every consensus surface — the page API, the follow engine's
 * candidate filter, the Telegram push path (runConsensusCycle) and the echo
 * discovery channel. The two ACTION paths (push, follow) and discovery pin
 * the disagreement thresholds to DEFAULT_DISAGREEMENT, so they always agree;
 * the page API deliberately scales its threshold with the user's
 * minPerWalletUsd ("both views tune together"), so an exploratory non-default
 * view can classify a market differently from the push — a view-only
 * divergence, by design.
 */
export function excludeContestedFromConsensus(
  consensus: ConsensusGroup[],
  disagreement: DisagreementMarket[],
): ConsensusGroup[] {
  const contested = new Set(disagreement.map((d) => d.conditionId));
  return consensus.filter((g) => !contested.has(g.conditionId));
}
