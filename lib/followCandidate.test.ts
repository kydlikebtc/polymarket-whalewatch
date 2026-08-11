import { describe, it, expect } from "vitest";
import {
  FOLLOW_SOURCE_KINDS,
  isFollowSourceKind,
  type FollowCandidate,
} from "./followCandidate";

describe("FollowCandidate 契约", () => {
  it("六个 source kind 全部登记", () => {
    expect([...FOLLOW_SOURCE_KINDS].sort()).toEqual([
      "consensus",
      "early_winner",
      "heavy",
      "lone_wolf",
      "lopsided",
      "resolved",
    ]);
  });

  it("isFollowSourceKind 只认登记过的字符串", () => {
    expect(isFollowSourceKind("consensus")).toBe(true);
    expect(isFollowSourceKind("heavy")).toBe(true);
    expect(isFollowSourceKind("accumulate")).toBe(false);
    expect(isFollowSourceKind("")).toBe(false);
    expect(isFollowSourceKind(null)).toBe(false);
    expect(isFollowSourceKind(42)).toBe(false);
  });

  it("候选结构可构造且字段齐全", () => {
    const c: FollowCandidate = {
      conditionId: "0xc",
      outcome: "Yes",
      outcomeIndex: 0,
      asset: "a1",
      title: "t",
      slug: "s",
      eventSlug: "e",
      formationTs: 1000,
      referencePrice: 0.42,
      sourceKind: "heavy",
      walletCount: 1,
      totalNetUsd: 50_000,
    };
    expect(c.sourceKind).toBe("heavy");
  });
});
