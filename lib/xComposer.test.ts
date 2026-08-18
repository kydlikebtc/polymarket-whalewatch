import { describe, it, expect } from "vitest";
import {
  composeWhalePost,
  composeConsensusPost,
  composePregamePost,
  composeWeeklyPost,
  usdCompact,
  buildTags,
  strategyEn,
  STRATEGY_EN,
  weightedLength,
} from "./xComposer";

describe("weightedLength(X 的加权字符口径)", () => {
  it("ASCII 逐字符算 1", () => {
    expect(weightedLength("hello")).toBe(5);
  });
  it("emoji 算 2 —— 这正是码点计数漏掉的那一半", () => {
    expect(weightedLength("🐳")).toBe(2);
    expect(weightedLength("📊💧⏳")).toBe(6);
  });
  it("制表符号与省略号也算 2(模板里真实用到的两个)", () => {
    expect(weightedLength("└")).toBe(2);
    expect(weightedLength("…")).toBe(2);
  });
  it("¢ 在权重 100 段内,算 1(模板里的价格符号不该被误判)", () => {
    expect(weightedLength("67¢")).toBe(3);
  });
});

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
    category: "Sports",
    subcategory: "NFL",
  };
  it("结构化四段:标题行 / 标的+方向 / 佐证 / 标签", () => {
    expect(composeWhalePost(base)).toBe(
      "🐳 WHALE BUY · $184K\n\n" +
        "Chiefs win Super Bowl LX?\n" +
        "└ YES @ 67¢\n\n" +
        "📊 12% of 24h vol · 💧 $229K liq · ⏳ 5h to settle\n\n" +
        "#Polymarket #NFL",
    );
  });
  it("SELL 与 🚨 分档在首行体现", () => {
    expect(composeWhalePost({ ...base, side: "SELL" })).toContain(
      "🐳 WHALE SELL · $184K",
    );
    expect(composeWhalePost({ ...base, usd: 250_000 })).toMatch(
      /^🚨 WHALE BUY/,
    );
  });
  it("佐证缺失就整段省略,绝不用 0/N-A 占位", () => {
    const t = composeWhalePost({
      ...base,
      pct24h: null,
      liquidityUsd: null,
      hoursToEnd: null,
    });
    expect(t).toBe(
      "🐳 WHALE BUY · $184K\n\nChiefs win Super Bowl LX?\n└ YES @ 67¢\n\n#Polymarket #NFL",
    );
    expect(t).not.toContain("📊");
  });
  it("含标签时仍守住 ≤280 与无 URL 两条硬不变量", () => {
    const t = composeWhalePost({ ...base, title: "A".repeat(300) });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).toContain("…");
    expect(t).toContain("#Polymarket");
    expect(t).not.toContain("http");
  });
  it("截断触发时守住的是 X 的加权 280,不是码点 280", () => {
    // 六个双宽字符(🐳 📊 💧 ⏳ └ …)让"码点 280"实际等于"X 眼里 286"。
    // 修复前这条必挂:X 返回 403,帖子被标 failed 静默丢弃。
    const t = composeWhalePost({ ...base, title: "A".repeat(400) });
    expect(t).toContain("…");
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
  });
  it("截断后仍是能塞下的最长标题(不过度砍)", () => {
    // 二分必须收敛到上界:再多留一个字符就会超限。
    const t = composeWhalePost({ ...base, title: "A".repeat(400) });
    expect(weightedLength(t)).toBeGreaterThanOrEqual(279);
  });
  it("剥掉标题里混入的 URL(带链接帖计费 13×)", () => {
    const t = composeWhalePost({
      ...base,
      title: "Weird market https://evil.example/x ok?",
    });
    expect(t).not.toContain("http");
    expect(t).toContain("Weird market");
  });
});

describe("composeConsensusPost", () => {
  it("结构化 + #SmartMoney(独家能力才加这个标签)", () => {
    expect(
      composeConsensusPost({
        walletCount: 3,
        outcome: "Yes",
        title: "Fed cut in Sept?",
        totalUsd: 92_000,
        category: "Economy",
      }),
    ).toBe(
      "🔥 SMART-MONEY CONSENSUS\n\n" +
        "Fed cut in Sept?\n" +
        "└ 3 top-PnL wallets → YES · $92K combined\n\n" +
        "#Polymarket #Economy #SmartMoney",
    );
  });
});

describe("composePregamePost", () => {
  it("结构化:结算倒计时抬头 + 站位 + 聚合佐证 + 标签", () => {
    expect(
      composePregamePost({
        title: "Lakers vs Celtics",
        hoursToEnd: 3,
        alertCount: 7,
        totalUsd: 310_000,
        topSide: "Yes",
        topSidePriceCents: 61,
        category: "Sports",
        subcategory: "NBA",
      }),
    ).toBe(
      "⏰ SETTLING IN 3H\n\n" +
        "Lakers vs Celtics\n" +
        "└ Leaning YES @ 61¢\n\n" +
        "📡 7 smart-money signals · $310K in 24h\n\n" +
        "#Polymarket #NBA #SmartMoney",
    );
  });
  it("无明显站位时省略该行", () => {
    const t = composePregamePost({
      title: "Lakers vs Celtics",
      hoursToEnd: 2,
      alertCount: 3,
      totalUsd: 55_000,
      topSide: null,
      topSidePriceCents: null,
    });
    expect(t).not.toContain("Leaning");
    expect(t).not.toContain("http");
    expect(t).toContain("#Polymarket");
  });
});

describe("composeWeeklyPost", () => {
  it("结构化战绩卡 —— 唯一允许带 URL 的模板", () => {
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
      "📊 WEEKLY REPORT · Aug 10–16\n\n" +
        "19 paper strategies tracking Polymarket smart money\n\n" +
        "✅ 42 settled · 55% win rate\n" +
        "💰 PnL +$1.2K\n" +
        "🏆 Best: Mega Whale +12.3% ROI\n\n" +
        "Full verified record: https://whalewatch.wired.fund/follow?utm_source=x\n\n" +
        "#Polymarket #PredictionMarkets #SmartMoney",
    );
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
  });
  it("负 PnL 与无胜率样本时优雅降级", () => {
    const t = composeWeeklyPost({
      weekLabel: "Aug 10–16",
      settled: 0,
      winRatePct: null,
      pnlUsd: -310,
      bestName: "巨鲸",
      bestRoiPct: -2.5,
      url: "https://x.example/f",
    });
    expect(t).toContain("💰 PnL -$310");
    expect(t).not.toContain("win rate");
    expect(t).toContain("🏆 Best: Whale Follow -2.5% ROI");
  });
});

describe("buildTags", () => {
  it("恒有根标签;赛道取二级优先(#NFL 比 #Sports 精准)", () => {
    expect(buildTags({ category: "Sports", subcategory: "NFL" })).toBe(
      "#Polymarket #NFL",
    );
    expect(buildTags({ category: "Sports" })).toBe("#Polymarket #Sports");
    expect(buildTags({})).toBe("#Polymarket");
  });
  it("#SmartMoney 只给独家类型(共识/赛前),大单不加", () => {
    expect(buildTags({ category: "Crypto", smartMoney: true })).toBe(
      "#Polymarket #Crypto #SmartMoney",
    );
  });
  it("脏值丢弃而不是产出 #undefined 这种废标签", () => {
    expect(buildTags({ category: "  ", subcategory: "!!!" })).toBe(
      "#Polymarket",
    );
    // 数字开头不是合法标签体。
    expect(buildTags({ subcategory: "2026Election" })).toBe("#Polymarket");
    // 空格/连字符压掉后仍是合法标签。
    expect(buildTags({ subcategory: "Formula 1" })).toBe(
      "#Polymarket #Formula1",
    );
  });
  it("未知一级类别透传(新赛道上线不必等代码改)", () => {
    expect(buildTags({ category: "Music" })).toBe("#Polymarket #Music");
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
