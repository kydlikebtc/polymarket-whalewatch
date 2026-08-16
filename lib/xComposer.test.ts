import { describe, it, expect } from "vitest";
import {
  composeWhalePost,
  composeConsensusPost,
  composePregamePost,
  composeWeeklyPost,
  usdCompact,
  strategyEn,
  STRATEGY_EN,
} from "./xComposer";

describe("usdCompact", () => {
  it("formats sub-K / K / M with minimal decimals", () => {
    expect(usdCompact(900)).toBe("$900");
    expect(usdCompact(1234)).toBe("$1.2K");
    expect(usdCompact(52_500)).toBe("$52.5K");
    expect(usdCompact(184_000)).toBe("$184K");
    expect(usdCompact(1_250_000)).toBe("$1.25M");
    expect(usdCompact(3_000_000)).toBe("$3M");
  });
});

describe("composeWhalePost", () => {
  const base = {
    usd: 184_000,
    side: "BUY" as const,
    outcome: "Yes",
    title: "Chiefs win Super Bowl LX?",
    priceCents: 67,
    pct24h: 12,
    liquidityUsd: 229_000,
    hoursToEnd: 5,
  };
  it("renders the full two-line template", () => {
    expect(composeWhalePost(base)).toBe(
      '🐳 $184K YES on "Chiefs win Super Bowl LX?" @ 67¢\n' +
        "12% of 24h vol · liquidity $229K · settles in 5h",
    );
  });
  it("SELL side reads SOLD; ≥$250k upgrades to 🚨", () => {
    expect(composeWhalePost({ ...base, side: "SELL" })).toContain(
      "$184K SOLD YES on",
    );
    expect(composeWhalePost({ ...base, usd: 250_000 })).toMatch(/^🚨/);
  });
  it("long outcomes keep their casing (only Yes/No get shouted)", () => {
    expect(
      composeWhalePost({ ...base, outcome: "Kansas City Chiefs" }),
    ).toContain('Kansas City Chiefs on "');
  });
  it("omits missing context segments entirely (un-enriched alert)", () => {
    const t = composeWhalePost({
      ...base,
      pct24h: null,
      liquidityUsd: null,
      hoursToEnd: null,
    });
    expect(t).toBe('🐳 $184K YES on "Chiefs win Super Bowl LX?" @ 67¢');
    expect(t).not.toContain("·");
  });
  it("stays ≤280 chars by truncating the title with … (URL-free invariant)", () => {
    const t = composeWhalePost({ ...base, title: "A".repeat(300) });
    expect([...t].length).toBeLessThanOrEqual(280);
    expect(t).toContain("…");
    // 帖内 URL 计费 $0.20/条(13×),模板层就不允许出现。
    expect(t).not.toContain("http");
  });
  it("strips URLs smuggled inside a market title (link post costs 13×)", () => {
    const t = composeWhalePost({
      ...base,
      title: "Weird market https://evil.example/x ok?",
    });
    expect(t).not.toContain("http");
    expect(t).toContain("Weird market");
  });
});

describe("composeConsensusPost", () => {
  it("renders wallet count / side / combined usd", () => {
    expect(
      composeConsensusPost({
        walletCount: 3,
        outcome: "Yes",
        title: "Fed cut in Sept?",
        totalUsd: 92_000,
      }),
    ).toBe(
      '🔥 CONSENSUS: 3 top-PnL wallets bought the SAME side of "Fed cut in Sept?" · combined $92K on YES',
    );
  });
});

describe("composePregamePost", () => {
  it("renders settle window + 24h smart-money aggregate + leaning side", () => {
    expect(
      composePregamePost({
        title: "Lakers vs Celtics",
        hoursToEnd: 3,
        alertCount: 7,
        totalUsd: 310_000,
        topSide: "Yes",
        topSidePriceCents: 61,
      }),
    ).toBe(
      '⏰ Settles in 3h: "Lakers vs Celtics"\n' +
        "Smart money fired 7 alerts totaling $310K in the last 24h · leaning YES @ 61¢",
    );
  });
  it("omits the leaning clause when no dominant side", () => {
    const t = composePregamePost({
      title: "Lakers vs Celtics",
      hoursToEnd: 2,
      alertCount: 3,
      totalUsd: 55_000,
      topSide: null,
      topSidePriceCents: null,
    });
    expect(t).not.toContain("leaning");
    expect(t).not.toContain("http");
  });
});

describe("composeWeeklyPost", () => {
  it("renders the fund summary and is the ONLY template allowed a URL", () => {
    const t = composeWeeklyPost({
      weekLabel: "Aug 10–16",
      settled: 42,
      winRatePct: 55,
      pnlUsd: 1240,
      bestName: "超级巨鲸",
      bestRoiPct: 12.3,
      url: "https://whalewatch.wired.fund/follow?utm_source=x",
    });
    expect(t).toBe(
      "📊 Weekly report (Aug 10–16) — 19 paper strategies tracking Polymarket smart money\n" +
        "Settled 42 positions · win rate 55% · PnL +$1.2K\n" +
        "Best: Mega Whale +12.3% ROI\n" +
        "Full verified track record: https://whalewatch.wired.fund/follow?utm_source=x",
    );
  });
  it("negative PnL and null win rate degrade gracefully", () => {
    const t = composeWeeklyPost({
      weekLabel: "Aug 10–16",
      settled: 0,
      winRatePct: null,
      pnlUsd: -310,
      bestName: "巨鲸",
      bestRoiPct: -2.5,
      url: "https://x.example/f",
    });
    expect(t).toContain("PnL -$310");
    expect(t).not.toContain("win rate");
    expect(t).toContain("Whale Follow -2.5% ROI");
  });
});

describe("STRATEGY_EN", () => {
  it("covers all 19 seed tiers and falls back to the original name", () => {
    expect(Object.keys(STRATEGY_EN)).toHaveLength(19);
    expect(strategyEn("反巨鲸")).toBe("Inverse Whale");
    expect(strategyEn("一边倒分歧")).toBe("Lopsided Majority");
    expect(strategyEn("未知新档")).toBe("未知新档");
  });
});
