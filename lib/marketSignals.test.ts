import { describe, it, expect } from "vitest";
import { excludeContestedFromConsensus } from "./marketSignals";
import type { ConsensusGroup } from "./consensus";
import type { DisagreementMarket } from "./disagreement";

const cg = (conditionId: string, outcome: string): ConsensusGroup =>
  ({
    conditionId,
    outcome,
    title: "M",
    eventSlug: "e",
    asset: "a",
    outcomeIndex: 0,
    wallets: [],
    walletCount: 2,
    totalNetUsd: 20000,
    avgBuyPrice: 0.5,
    firstTs: 1,
    lastTs: 2,
  }) as ConsensusGroup;

const dm = (conditionId: string): DisagreementMarket =>
  ({
    conditionId,
    title: "M",
    eventSlug: "e",
    sides: [],
    totalNetUsd: 0,
    totalWeightedUsd: 0,
    tiltPct: 0.5,
    tilt: "balanced",
    excludedWallets: 0,
    firstTs: 1,
    lastTs: 2,
  }) as DisagreementMarket;

describe("excludeContestedFromConsensus", () => {
  it("drops BOTH one-sided groups of a market that's actually a disagreement", () => {
    // 0xA has smart money on Yes AND No → two false 'consensuses' for one market.
    const consensus = [cg("0xA", "Yes"), cg("0xA", "No"), cg("0xB", "Yes")];
    const out = excludeContestedFromConsensus(consensus, [dm("0xA")]);
    expect(out.map((g) => g.conditionId)).toEqual(["0xB"]);
  });

  it("keeps everything when there is no disagreement", () => {
    const consensus = [cg("0xA", "Yes"), cg("0xB", "No")];
    expect(excludeContestedFromConsensus(consensus, [])).toHaveLength(2);
  });

  it("does not mutate the input array", () => {
    const consensus = [cg("0xA", "Yes")];
    const out = excludeContestedFromConsensus(consensus, [dm("0xA")]);
    expect(out).toHaveLength(0);
    expect(consensus).toHaveLength(1);
  });
});
