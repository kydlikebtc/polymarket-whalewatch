// 标签系统(buildTags/entityTag)的测试在 lib/xComposer.tags.test.ts。
import { describe, it, expect } from "vitest";
import {
  composeWhalePost,
  composeConsensusPost,
  composePregamePost,
  composeWeeklyPost,
  composeSettlementPost,
  usdCompact,
  strategyEn,
  STRATEGY_EN,
  weightedLength,
  fitPost,
  TEMPLATE_VOCAB,
} from "./xComposer";

// ---- 底座:格式化 / 计数 / 限长 / 标签 --------------------------------

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

describe("weightedLength", () => {
  it("拉丁字母/数字/常用标点计 1", () => {
    expect(weightedLength("WHALE: $200K @ 80")).toBe(17);
    expect(weightedLength("¢")).toBe(1); // U+00A2 在拉丁补充区
    expect(weightedLength("·")).toBe(1); // U+00B7
    expect(weightedLength("—")).toBe(1); // U+2014 em dash 在 [8208,8223]
    expect(weightedLength(" ")).toBe(1); // thin space 在 [8192,8205]
    expect(weightedLength("′")).toBe(1); // U+2032 prime 在 [8242,8247]
  });
  it("emoji 与制表符号计 2", () => {
    expect(weightedLength("🐳")).toBe(2);
    expect(weightedLength("└")).toBe(2); // U+2514
    expect(weightedLength("…")).toBe(2); // U+2026 不在权 1 区间
    expect(weightedLength("⏳")).toBe(2);
  });
  it("混排:真实抬头行", () => {
    // 🐳(2) + 空格(1)*6 + "WHALE:"(6) + "$200K"(5) + "says"(4) + "NO"(2) + "@"(1) + "80¢"(3)
    expect(weightedLength("🐳 WHALE: $200K says NO @ 80¢")).toBe(29);
  });
});

describe("fitPost", () => {
  const tags = "\n\n#Polymarket";
  it("取第一个 ≤280 加权的变体", () => {
    const rich = (t: string) => `HEAD\n\n${t}\n\nEXTRA LINE${tags}`;
    const lean = (t: string) => `HEAD\n\n${t}${tags}`;
    const title = "short title";
    expect(fitPost([rich, lean], title)).toBe(rich(title));
  });
  it("富变体超限时降到简变体,标题不动", () => {
    const pad = "x".repeat(270); // 富变体必超
    const rich = (t: string) => `${pad}\n\n${t}${tags}`;
    const lean = (t: string) => `HEAD\n\n${t}${tags}`;
    const title = "short title";
    expect(fitPost([rich, lean], title)).toBe(lean(title));
  });
  it("全部变体超限才截标题(按加权预算装入 + 省略号)", () => {
    const lean = (t: string) => `HEAD\n\n${t}${tags}`;
    const title = "T".repeat(400);
    const out = fitPost([lean], title);
    expect(weightedLength(out)).toBeLessThanOrEqual(280);
    expect(out).toContain("…");
    expect(out.startsWith("HEAD")).toBe(true);
  });
  it("emoji 标题截断不超限(权 2 字符正确扣预算)", () => {
    const lean = (t: string) => `HEAD\n\n${t}${tags}`;
    const title = "🐳".repeat(300);
    expect(weightedLength(fitPost([lean], title))).toBeLessThanOrEqual(280);
  });
  it("全超时用最简(最后一个)变体截断,不是第一个", () => {
    // 钉住 variants[variants.length-1]:误改成 variants[0] 会让截断发生在
    // 最富变体上 —— 标题被砍得更狠,可选事实行反而全保留,降级顺序倒置。
    const rich = (t: string) => `RICH\n\nEXTRA LINE\n\n${t}${tags}`;
    const lean = (t: string) => `LEAN\n\n${t}${tags}`;
    const title = "T".repeat(400); // 两个变体都必超
    const out = fitPost([rich, lean], title);
    expect(out.startsWith("LEAN")).toBe(true);
    expect(out).not.toContain("EXTRA LINE");
    expect(weightedLength(out)).toBeLessThanOrEqual(280);
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

// ---- 五类模板 ----------------------------------------------------------

describe("composeWhalePost", () => {
  const base = {
    usd: 200_000,
    side: "BUY" as const,
    outcome: "No",
    title: "Will Bitcoin dip to $45,000 by December 31, 2026?",
    priceCents: 80,
    pct24h: 94,
    liquidityUsd: 186_000,
    hoursToEnd: 136 * 24,
  };
  // 带赛道分类的夹具:钉逐字布局与标签接线(#NFL 二级 + SuperBowl 实体)。
  const nfl = {
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
  it("结构化四段逐字锁定:断言抬头 / 标题 / 佐证 / 标签", () => {
    expect(composeWhalePost(nfl)).toBe(
      "🐳 WHALE: $184K says YES @ 67¢\n\n" +
        "Chiefs win Super Bowl LX?\n\n" +
        "📊 12% of 24h vol · 💧 $229K liq · ⏳ 5h to settle\n\n" +
        // 三标签:平台 + 赛道 + 标题命中的实体(Super Bowl)。
        "#Polymarket #NFL #SuperBowl",
    );
  });
  it("匿名大单:断言式抬头 says + outcome + 价格一行读完", () => {
    const t = composeWhalePost(base);
    expect(t.startsWith("🐳 WHALE: $200K says NO @ 80¢")).toBe(true);
    expect(t).toContain("📊 94% of 24h vol");
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
  });
  it("SELL 用 sells(卖出≠看反,不硬造方向)", () => {
    const t = composeWhalePost({ ...base, side: "SELL" });
    expect(t).toContain("$200K sells NO @ 80¢");
  });
  it("SELL 与 🚨 分档在首行体现(250K 恰压 WHALE_SIREN_USD 线)", () => {
    expect(composeWhalePost({ ...nfl, side: "SELL" })).toContain(
      "🐳 WHALE: $184K sells YES @ 67¢",
    );
    expect(composeWhalePost({ ...nfl, usd: 250_000 })).toMatch(/^🚨 WHALE: /);
  });
  it("占比 ≥100% 升级抬头,佐证行不重复占比", () => {
    const t = composeWhalePost({ ...base, usd: 300_000, pct24h: 140 });
    expect(t).toContain(
      "🚨 WHALE: $300K says NO @ 80¢ — more than this market's entire 24h volume",
    );
    expect(t).not.toContain("% of 24h vol");
  });
  it("单笔占满全天成交量:🐳 档也触发反常断言,其余佐证(💧)保留", () => {
    // $121K 在 Polymarket 上不算罕见,但「一笔单子 ≥ 该市场全天所有人的
    // 成交量」很罕见。时间线上只有首行有机会被扫到,最稀奇的事实必须放在
    // 那里 —— 否则它躺在第三行中间,等于没说。
    const t = composeWhalePost({ ...nfl, usd: 121_000, pct24h: 115 });
    expect(t).toMatch(
      /^🐳 WHALE: \$121K says YES @ 67¢ — more than this market's entire 24h volume/,
    );
    // 抬头已经讲了占比,佐证段不再重复 📊,把字符让给别的事实。
    expect(t).not.toContain("📊");
    expect(t).toContain("💧");
  });
  it("占比未过线时保持普通断言抬头(不为了戏剧性而夸张)", () => {
    const t = composeWhalePost({ ...nfl, pct24h: 12 });
    expect(t).toMatch(/^🐳 WHALE: \$184K says YES @ 67¢/);
    expect(t).not.toContain("entire 24h volume");
    expect(t).toContain("📊 12% of 24h vol"); // 仍作为佐证出现
  });
  it("反常抬头下 🚨 分档与 SELL 方向都不丢", () => {
    const t = composeWhalePost({
      ...nfl,
      usd: 300_000,
      side: "SELL",
      pct24h: 150,
    });
    expect(t).toMatch(
      /^🚨 WHALE: \$300K sells YES @ 67¢ — more than this market's entire 24h volume/,
    );
  });
  it("佐证缺失就整段省略,绝不用 0/N-A 占位", () => {
    const t = composeWhalePost({
      ...nfl,
      pct24h: null,
      liquidityUsd: null,
      hoursToEnd: null,
    });
    expect(t).toBe(
      "🐳 WHALE: $184K says YES @ 67¢\n\nChiefs win Super Bowl LX?\n\n#Polymarket #NFL #SuperBowl",
    );
    expect(t).not.toContain("📊");
  });
  it("smart 传入 → 🏆 抬头 + Track record 行(null 段省略)", () => {
    const t = composeWhalePost({
      ...base,
      smart: { winRate: 0.74, netPnl: 1_200_000 },
    });
    expect(t.startsWith("🏆 SMART MONEY: $200K says NO @ 80¢")).toBe(true);
    expect(t).toContain("Track record: 74% win rate · +$1.2M PnL");
  });
  it("smart 全 null → 🏆 抬头保留,凭证行整行不出", () => {
    const t = composeWhalePost({ ...base, smart: {} });
    expect(t.startsWith("🏆 SMART MONEY:")).toBe(true);
    expect(t).not.toContain("Track record");
  });
  it("负 PnL 照实输出(Just the record)", () => {
    const t = composeWhalePost({ ...base, smart: { netPnl: -50_000 } });
    expect(t).toContain("Track record: -$50K PnL");
  });
  it("promiseSettled → 承诺行独立成段", () => {
    const t = composeWhalePost({
      ...base,
      hoursToEnd: 30,
      promiseSettled: true,
    });
    expect(t).toContain("\n\nResult posted at settlement — win or lose.\n\n");
  });
  it("中间梯级:承诺先丢,佐证还在", () => {
    // 钉住阶梯的中间态:repeat(11) 让全量变体恰好超限、去掉承诺行后又装得
    // 下 —— 若 promise/facts 的丢弃顺序被对调,📊 断言立刻红。
    const mid = composeWhalePost({
      ...base,
      title: "Will " + "the committee ".repeat(11) + "decide?",
      promiseSettled: true,
    });
    expect(mid).not.toContain("Result posted");
    expect(mid).toContain("📊"); // 承诺先丢,佐证还在
  });
  it("超长标题:先丢承诺行再丢佐证行,标题最后才截", () => {
    const t = composeWhalePost({
      ...base,
      title: "Will " + "the committee ".repeat(18) + "decide?",
      promiseSettled: true,
    });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).not.toContain("Result posted");
  });
  it("标题截到补 … 时,标签行仍完整保留", () => {
    const t = composeWhalePost({ ...nfl, title: "A".repeat(300) });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).toContain("…");
    expect(t).toContain("#Polymarket");
    expect(t).not.toContain("http");
  });
  it("剥掉标题里混入的 URL(带链接帖计费 13×),其余正文保留", () => {
    const t = composeWhalePost({
      ...nfl,
      title: "Weird market https://evil.example/x ok?",
    });
    expect(t).not.toContain("http");
    expect(t).toContain("Weird market");
  });
  it("硬不变量:≤280 加权 + 无 URL", () => {
    const t = composeWhalePost({
      ...base,
      smart: { winRate: 0.74, netPnl: 1_200_000 },
      promiseSettled: true,
      title: base.title + " https://example.com/x",
    });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).not.toMatch(/https?:\/\//);
  });
});

describe("composeConsensusPost", () => {
  const base = {
    walletCount: 2,
    outcome: "Nongshim Red Force",
    title: "LoL: Nongshim Red Force vs DN SOOPers - Game 2 Winner",
    totalUsd: 33_900,
    priceCents: 49,
    spanSec: 14 * 60,
    wallets: [
      { netUsd: 12_499, avgPriceCents: 64, winRate: 0.74 },
      { netUsd: 9_600, avgPriceCents: 45, winRate: 0.57 },
    ],
  };
  // 梯级降档系列共用的 96 字符长标题(命中 #Fed)与 3 钱包回执。
  const longTitle =
    "Will the Federal Reserve cut interest rates by 50bps or more at the September 2026 FOMC meeting?";
  const wallets3 = [
    { netUsd: 48_000, avgPriceCents: 57, winRate: 0.81 },
    { netUsd: 27_000, avgPriceCents: 58, winRate: 0.74 },
    { netUsd: 17_000, avgPriceCents: 60, winRate: 0.57 },
  ];
  it("满配:叙事 └ 行 + 逐钱包回执(截图传播主体)", () => {
    const t = composeConsensusPost(base);
    expect(t).toContain(
      "└ 2 top-PnL wallets → Nongshim Red Force @ 49¢ avg · $33.9K within 14 min",
    );
    expect(t).toContain("🏆 $12.5K @ 64¢ · 74% win rate");
    expect(t).toContain("🏆 $9.6K @ 45¢ · 57% win rate");
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
  });
  it("满配逐字:设计文档 §3③ 样例,空行布局与三标签全锁定", () => {
    const t = composeConsensusPost({ ...base, subcategory: "Esports" });
    expect(t).toBe(
      "🔥 SMART-MONEY CONSENSUS\n\n" +
        "LoL: Nongshim Red Force vs DN SOOPers - Game 2 Winner\n" +
        "└ 2 top-PnL wallets → Nongshim Red Force @ 49¢ avg · $33.9K within 14 min\n\n" +
        "🏆 $12.5K @ 64¢ · 74% win rate\n" +
        "🏆 $9.6K @ 45¢ · 57% win rate\n\n" +
        "#Polymarket #Esports #LeagueOfLegends",
    );
    expect(weightedLength(t)).toBe(256);
  });
  it("无回执逐字(老 payload 形态):└ 行 + 赛道/实体标签,布局完整", () => {
    expect(
      composeConsensusPost({
        walletCount: 3,
        outcome: "Yes",
        title: "Fed cut in Sept?",
        totalUsd: 92_000,
        priceCents: 58,
        category: "Economy",
      }),
    ).toBe(
      "🔥 SMART-MONEY CONSENSUS\n\n" +
        "Fed cut in Sept?\n" +
        "└ 3 top-PnL wallets → YES @ 58¢ avg · $92K combined\n\n" +
        "#Polymarket #Economy #Fed",
    );
  });
  it("窗口 >60min 不讲集中度(不稀奇就删句),金额落回 combined", () => {
    const t = composeConsensusPost({ ...base, spanSec: 2 * 3600 });
    expect(t).not.toContain("within");
    expect(t).toContain("$33.9K combined");
  });
  it("spanSec 边界:0 clamp 到 1 min;3600 是最后一档 within;3601 落回 combined", () => {
    expect(composeConsensusPost({ ...base, spanSec: 0 })).toContain(
      "within 1 min",
    );
    expect(composeConsensusPost({ ...base, spanSec: 3600 })).toContain(
      "within 60 min",
    );
    const t = composeConsensusPost({ ...base, spanSec: 3601 });
    expect(t).not.toContain("within");
    expect(t).toContain("combined");
  });
  it("缺价格时省略该段,不用 0¢ 占位", () => {
    const t = composeConsensusPost({
      walletCount: 2,
      outcome: "Yes",
      title: "Fed cut in Sept?",
      totalUsd: 18_400,
    });
    expect(t).toContain("→ YES · $18.4K combined");
    expect(t).not.toContain("¢");
  });
  it("winRate 为 null 的回执省略胜率段", () => {
    const t = composeConsensusPost({
      ...base,
      wallets: [{ netUsd: 12_499, avgPriceCents: 64, winRate: null }],
    });
    expect(t).toContain("🏆 $12.5K @ 64¢\n");
    expect(t).not.toContain("null");
  });
  it("老 payload 无 wallets/spanSec → 无回执块,└ 行仍完整", () => {
    const t = composeConsensusPost({
      walletCount: 3,
      outcome: "Yes",
      title: "Fed cut in Sept?",
      totalUsd: 92_000,
      priceCents: 58,
    });
    expect(t).toContain("└ 3 top-PnL wallets → YES @ 58¢ avg · $92K combined");
    expect(t).not.toContain("🏆 $");
  });
  it("长标题降级:回执坍缩,标题不截", () => {
    const t = composeConsensusPost({
      ...base,
      title: longTitle,
      walletCount: 3,
      wallets: wallets3,
      spanSec: 41 * 60,
    });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).toContain(longTitle); // 标题完整
    // 3 行回执装不下(实测 304) → 先试 2 行(实测 275,装得下)
    expect(t).toContain("🏆 $48K @ 57¢ · 81% win rate");
    expect(t).toContain("🏆 $27K @ 58¢ · 74% win rate");
    expect(t).not.toContain("$17K");
  });
  it("更长标题:两行回执也装不下时,坍缩成聚合胜率行", () => {
    // 96 字符基准下 2 行回执变体实测 275;标题 +30 加权后它到 305 超限,
    // 聚合行变体实测 277 恰好装下 —— 命中「🏆 Win rates」梯级。
    const t = composeConsensusPost({
      ...base,
      title: longTitle + " Or hold rates steady instead?",
      walletCount: 3,
      wallets: wallets3,
      spanSec: 41 * 60,
    });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).toContain("🏆 Win rates: 81% · 74% · 57%");
    expect(t).not.toContain("🏆 $");
  });
  it("再长:聚合行也装不下 → 凭证块全降光,标题仍完整不截", () => {
    // 标题 +47 加权后聚合行变体实测 294 超限,裸变体 263 装得下 ——
    // 标题是 fitPost 降级顺序里最后才动的。
    const title = longTitle + " Or hold steady and revisit the decision later?";
    const t = composeConsensusPost({
      ...base,
      title,
      walletCount: 3,
      wallets: wallets3,
      spanSec: 41 * 60,
    });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).not.toContain("🏆");
    expect(t).toContain(title); // 标题完整
  });
  it("5 钱包输入:聚合行与回执同口径,只列前 3 个胜率", () => {
    // 聚合行是回执的坍缩形态 —— 若口径不同(回执前 3、聚合全量),降档瞬间
    // 会凭空多出两个数字,读者对不上。
    const t = composeConsensusPost({
      ...base,
      title: longTitle + " Or hold rates steady instead?",
      walletCount: 5,
      wallets: [
        ...wallets3,
        { netUsd: 9_000, avgPriceCents: 61, winRate: 0.9 },
        { netUsd: 8_000, avgPriceCents: 62, winRate: 0.99 },
      ],
      spanSec: 41 * 60,
    });
    expect(t).toContain("🏆 Win rates: 81% · 74% · 57%");
    expect(t).not.toContain("90%");
    expect(t).not.toContain("99%");
  });
  it("硬不变量:≤280 加权 + 无 URL", () => {
    const t = composeConsensusPost({
      ...base,
      title: base.title + " https://leak.example",
    });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).not.toMatch(/https?:\/\//);
  });
});

describe("composePregamePost", () => {
  const base = {
    title: "Lakers vs Celtics",
    hoursToEnd: 3,
    alertCount: 7,
    topSidePriceCents: 61,
    sides: [
      { name: "Lakers", usd: 310_000 },
      { name: "Celtics", usd: 42_000 },
    ],
  };
  it("单边站位逐字锁定:every-signal 抬头 + └ 行 + 资金段 + 标签", () => {
    expect(
      composePregamePost({
        title: "Lakers vs Celtics",
        hoursToEnd: 3,
        alertCount: 7,
        sides: [{ name: "Yes", usd: 310_000 }],
        topSidePriceCents: 61,
        category: "Sports",
        subcategory: "NBA",
      }),
    ).toBe(
      "⏰ SETTLES IN 3H — every signal is on YES\n\n" +
        "Lakers vs Celtics\n" +
        "└ YES @ 61¢\n\n" +
        "📡 7 signals in 24h · all $310K on one side\n\n" +
        "#Polymarket #NBA",
    );
  });
  it("比例 ≥2:X-to-1 抬头 + 双边资金行", () => {
    const t = composePregamePost(base);
    expect(t).toContain("⏰ SETTLES IN 3H — smart money is 7-to-1 on Lakers");
    expect(t).toContain("└ Lakers @ 61¢");
    expect(t).toContain(
      "📡 7 signals in 24h · $310K on Lakers vs $42K on Celtics",
    );
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
  });
  it("一边倒:every signal 抬头 + all on one side(不输出 vs $0)", () => {
    const t = composePregamePost({
      ...base,
      hoursToEnd: 6,
      alertCount: 1,
      topSidePriceCents: 62,
      title: "LoL: Nongshim Red Force vs DN SOOPers - Game 1 Winner",
      sides: [{ name: "Nongshim Red Force", usd: 13_100 }],
    });
    expect(t).toContain("— every signal is on Nongshim Red Force");
    expect(t).toContain("📡 1 signal in 24h · all $13.1K on one side");
    expect(t).not.toContain("vs $0");
  });
  it("比例 <2:SPLIT 抬头 + Slight lean 前缀(分歧本身是好故事)", () => {
    const t = composePregamePost({
      ...base,
      hoursToEnd: 2,
      alertCount: 9,
      topSidePriceCents: 54,
      title: "Chiefs vs Bills",
      sides: [
        { name: "Chiefs", usd: 180_000 },
        { name: "Bills", usd: 150_000 },
      ],
    });
    expect(t).toContain("— smart money is SPLIT on this one");
    expect(t).toContain("└ Slight lean Chiefs @ 54¢");
  });
  it("无 sides(全 SELL 市场):裸抬头不崩,资金行不出", () => {
    const t = composePregamePost({ ...base, sides: [] });
    expect(t).toContain("⏰ SETTLES IN 3H\n");
    expect(t).toContain("📡 7 signals in 24h\n");
  });
  it("sides 整个缺省:└ 行与资金段都不出", () => {
    const t = composePregamePost({
      title: "Lakers vs Celtics",
      hoursToEnd: 2,
      alertCount: 3,
    });
    expect(t).not.toContain("└");
    expect(t).toContain("📡 3 signals in 24h\n");
    expect(t).not.toContain("http");
    expect(t).toContain("#Polymarket");
  });
  it("二元市场 outcome 大写:YES/NO 经 outcomeDisplay", () => {
    const t = composePregamePost({
      ...base,
      sides: [
        { name: "Yes", usd: 200_000 },
        { name: "No", usd: 50_000 },
      ],
    });
    expect(t).toContain("4-to-1 on YES");
    expect(t).toContain("$200K on YES vs $50K on NO");
  });
  it("比例向下取整:2.5 说 2-to-1 不说 3-to-1(不编数字是品牌立场)", () => {
    // round 在 2.5 会说 3-to-1,凭空夸大 20%;floor 永不夸大。
    const t = composePregamePost({
      ...base,
      sides: [
        { name: "Lakers", usd: 250_000 },
        { name: "Celtics", usd: 100_000 },
      ],
    });
    expect(t).toContain("smart money is 2-to-1 on Lakers");
  });
  it("三向盘(足球主/平/客)传 3 个 sides:只用前两名,第三名不出现", () => {
    // PregamePostInput.sides 契约是调用方只给前两个,但 composer 收到 3 个
    // 时不该崩,也不该让第三名混进任何文案。
    const t = composePregamePost({
      ...base,
      title: "Arsenal vs Chelsea",
      sides: [
        { name: "Arsenal", usd: 120_000 },
        { name: "Draw", usd: 50_000 },
        { name: "Chelsea", usd: 30_000 },
      ],
    });
    expect(t).toContain("$120K on Arsenal vs $50K on Draw");
    expect(t).not.toContain("$30K");
    // 标题里本来就有 Chelsea,只需资金行不含它 —— 断言资金行片段而非全文。
    expect(t).not.toContain("on Chelsea");
  });
  it("硬不变量:超长标题先丢资金段再截标题,≤280 加权 + 无 URL", () => {
    // 钉住 fitPost 阶梯前提(最简底座 ≤278):标题被截时资金段已让位,
    // 抬头故事(X-to-1)与 └ 行保留 —— 标题是最后才动的。
    const t = composePregamePost({
      ...base,
      title:
        "Will " + "the committee ".repeat(20) + "decide? https://leak.example",
    });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).not.toMatch(/https?:\/\//);
    expect(t).not.toContain("$310K on Lakers"); // 资金段先丢
    expect(t).toContain("7-to-1 on Lakers"); // 抬头故事保留
    expect(t).toContain("…");
  });
});

describe("composeSettlementPost", () => {
  const base = {
    title: "Baltimore Orioles vs. Tampa Bay Rays",
    outcome: "Baltimore Orioles",
    entryCents: 40,
    side: "BUY" as const,
    won: true,
    signalKind: "consensus" as const,
    postedAgoSec: 2 * 86400,
  };
  // SELL 语义夹具(100¢ 边界):真实数据实测踩到的 bug —— settleWon 的 won
  // 对 SELL 是「卖出后价格下跌」,套用买入的 entry→$1.00 公式会把「卖对了」
  // 说成「买赢了」,数字与方向全错。
  const sell = {
    title: "The Hundred, Women: Welsh Fire vs London Spirit",
    outcome: "Welsh Fire",
    entryCents: 100,
    side: "SELL" as const,
    category: "Sports",
  };
  it("赢:回报率提进抬头(被 quote 的就是这行),无立场行", () => {
    const t = composeSettlementPost(base);
    expect(t.startsWith("✅ CALLED IT · 40¢ → $1.00 (+150%)")).toBe(true);
    expect(t).toContain(
      "└ Consensus signal on Baltimore Orioles, posted 2d ago",
    );
    expect(t).not.toContain("every result");
  });
  it("赢单逐字(signalKind/postedAgoSec 缺省 → Signal 标签、无 posted 从句)", () => {
    expect(
      composeSettlementPost({
        title: "Baltimore Orioles vs. Tampa Bay Rays",
        outcome: "Baltimore Orioles",
        entryCents: 40,
        won: true,
        category: "Sports",
        subcategory: "MLB",
      }),
    ).toBe(
      "✅ CALLED IT · 40¢ → $1.00 (+150%)\n\n" +
        "Baltimore Orioles vs. Tampa Bay Rays\n" +
        "└ Signal on Baltimore Orioles\n\n" +
        "#Polymarket #MLB",
    );
  });
  it("输:立场行是全场最硬的信任证明(不对称是刻意的)", () => {
    const t = composeSettlementPost({
      ...base,
      entryCents: 62,
      won: false,
      signalKind: "whale",
    });
    expect(t.startsWith("❌ MISSED · 62¢ → $0")).toBe(true);
    expect(t).toContain("└ Whale signal on Baltimore Orioles");
    expect(t).toContain("We post every result, wins and losses.");
  });
  it("输单逐字 —— 只发赢的就是 cherry-picking,等于自毁「just the record」", () => {
    // 这条是产品立场,不是技术细节:账号简介写着 No screenshots. Just the
    // record. 只挑赢的发,读者第一次对照就会发现,信任一次性归零。
    expect(
      composeSettlementPost({
        title: "Baltimore Orioles vs. Tampa Bay Rays",
        outcome: "Baltimore Orioles",
        entryCents: 40,
        won: false,
        category: "Sports",
        subcategory: "MLB",
      }),
    ).toBe(
      "❌ MISSED · 40¢ → $0\n\n" +
        "Baltimore Orioles vs. Tampa Bay Rays\n" +
        "└ Signal on Baltimore Orioles\n\n" +
        "We post every result, wins and losses.\n\n" +
        "#Polymarket #MLB",
    );
  });
  it("高价入场的赢单回报小(40¢ 赢 +150%,90¢ 赢只有 +11%)", () => {
    expect(composeSettlementPost({ ...base, entryCents: 90 })).toContain(
      "90¢ → $1.00 (+11%)",
    );
  });
  it("SELL 沿用两个可核对价格,不编回报率", () => {
    const t = composeSettlementPost({
      ...base,
      side: "SELL",
      entryCents: 62,
      won: true,
    });
    expect(t.startsWith("✅ CALLED IT · sold 62¢ → $0.00")).toBe(true);
    // 空头的回报基准(保证金/占用资金)在预测市场没有统一口径 —— 不编。
    expect(t).not.toContain("%");
  });
  it("卖对了 = 标的归零:100¢ 成交合法,不因边界检查丢掉价格段", () => {
    // 以 $1.00 卖出很常见;老边界写的是 c < 100,把这类整段吞掉了。
    expect(composeSettlementPost({ ...sell, won: true })).toContain(
      "✅ CALLED IT · sold 100¢ → $0.00",
    );
    // 买方 100¢ 入场则回报恒为 0%,也应照实显示。
    expect(
      composeSettlementPost({ ...sell, side: "BUY", won: true }),
    ).toContain("100¢ → $1.00 (+0%)");
  });
  it("卖错了 = 标的结算为 $1", () => {
    expect(composeSettlementPost({ ...sell, won: false })).toContain(
      "❌ MISSED · sold 100¢ → $1.00",
    );
  });
  it("脏价(0 / >100)仍然只报结果", () => {
    expect(
      composeSettlementPost({ ...sell, entryCents: 0, won: true }),
    ).not.toContain("¢");
    expect(
      composeSettlementPost({ ...sell, entryCents: 140, won: true }),
    ).not.toContain("¢");
  });
  it("入场价缺失:裸抬头,不编回报率也不留箭头", () => {
    const t = composeSettlementPost({ ...base, entryCents: null });
    expect(t.startsWith("✅ CALLED IT\n")).toBe(true);
    expect(t).not.toContain("%");
    expect(t).not.toContain("→");
  });
  it("postedAgoSec <48h 用小时,缺失省略从句", () => {
    expect(
      composeSettlementPost({ ...base, postedAgoSec: 14 * 3600 }),
    ).toContain("posted 14h ago");
    expect(
      composeSettlementPost({ ...base, postedAgoSec: null }),
    ).not.toContain("posted");
  });
  it("postedAgoSec <1h 档:posted under 1h ago", () => {
    expect(composeSettlementPost({ ...base, postedAgoSec: 1800 })).toContain(
      "posted under 1h ago",
    );
  });
  it("signalKind 缺失退化为 Signal(旧调用零破坏)", () => {
    const t = composeSettlementPost({ ...base, signalKind: undefined });
    expect(t).toContain("└ Signal on Baltimore Orioles");
  });
  it("硬不变量:≤280 加权 + 无 URL + 超长标题截断", () => {
    const t = composeSettlementPost({
      ...base,
      title: "X".repeat(400) + " https://leak.example",
    });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).not.toMatch(/https?:\/\//);
  });
  it("硬不变量 · 输帖最重版式:立场行 + posted-ago 全在时超长标题仍 ≤280", () => {
    const t = composeSettlementPost({
      ...base,
      won: false,
      title: "X".repeat(400) + " https://leak.example",
    });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).not.toMatch(/https?:\/\//);
    expect(t).toContain("We post every result, wins and losses.");
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
        "#Polymarket #PredictionMarkets",
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

// ---- 可配置文案模板 ------------------------------------------------------

describe("文案模板(template)", () => {
  // 每个 kind 的「富输入」:让全部占位符都渲染出非空值 —— 词表与 compose
  // 内部 vars 构建的漂移守卫(renderTemplate 对未知键静默置空,普通断言
  // 抓不到漂移,必须逐 token 断非空)。
  const RICH = {
    whale: () => ({
      usd: 300_000,
      side: "BUY" as const,
      outcome: "Yes",
      title: "Will Bitcoin hit $150,000 by Dec 31?",
      priceCents: 67,
      pct24h: 120,
      liquidityUsd: 186_000,
      hoursToEnd: 30,
      smart: { winRate: 0.74, netPnl: 1_200_000 },
      promiseSettled: true,
      category: "Crypto",
    }),
    consensus: () => ({
      walletCount: 2,
      outcome: "Nongshim Red Force",
      title: "LoL: NRF vs DNS — Game 2 Winner",
      totalUsd: 33_900,
      priceCents: 49,
      spanSec: 840,
      wallets: [
        { netUsd: 12_500, avgPriceCents: 64, winRate: 0.74 },
        { netUsd: 9_600, avgPriceCents: 45, winRate: 0.57 },
      ],
      category: "Esports",
    }),
    pregame: () => ({
      title: "Lakers vs Celtics",
      hoursToEnd: 3,
      alertCount: 12,
      topSidePriceCents: 61,
      sides: [
        { name: "Lakers", usd: 310_000 },
        { name: "Celtics", usd: 42_000 },
      ],
      category: "Sports",
    }),
    settled: () => ({
      title: "Baltimore Orioles vs. Tampa Bay Rays",
      outcome: "Baltimore Orioles",
      entryCents: 40,
      side: "BUY" as const,
      won: false, // 输帖才有 stance 行
      signalKind: "consensus" as const,
      postedAgoSec: 2 * 86400,
      category: "Sports",
    }),
    weekly: () => ({
      weekLabel: "Aug 10–16",
      settled: 42,
      winRatePct: 55,
      pnlUsd: 1200,
      bestName: "超级巨鲸",
      bestRoiPct: 12.3,
      url: "https://whalewatch.wired.fund/follow?utm_source=x",
    }),
  };

  const compose = (kind: keyof typeof RICH, template: string): string => {
    const input = { ...RICH[kind](), template };
    switch (kind) {
      case "whale":
        return composeWhalePost(input as never);
      case "consensus":
        return composeConsensusPost(input as never);
      case "pregame":
        return composePregamePost(input as never);
      case "settled":
        return composeSettlementPost(input as never);
      case "weekly":
        return composeWeeklyPost(input as never);
    }
  };

  it("词表逐 token 非空:TEMPLATE_VOCAB 与 compose 内部 vars 不漂移", () => {
    // renderTemplate 对未知键静默置空,整版模板断言抓不到漂移;且全词表
    // 拼一版会超 280 触发回退。故逐 token 渲染:每次一个短模板。
    for (const kind of Object.keys(RICH) as (keyof typeof RICH)[]) {
      for (const v of TEMPLATE_VOCAB[kind]) {
        const tpl =
          kind === "weekly"
            ? `[${v}={${v}}]`
            : v === "title"
              ? `[title={title}]`
              : `[${v}={${v}}]\n{title}`;
        const out = compose(kind, tpl);
        // [token=非空] —— 值里不含 "]"(receipts 多行也成立)。
        expect(out, `${kind}.{${v}} 应渲染出非空值`).toMatch(
          new RegExp(`\\[${v}=[^\\]]+\\]`),
        );
      }
    }
  });

  it("whale:自定义文案生效,数据占位符替换正确", () => {
    const out = compose(
      "whale",
      "{icon} {amount} smashed {outcome} @ {price}\n\n{title}\n\n{track}\n\n{tags}",
    );
    expect(out).toContain("🏆 $300K smashed YES @ 67¢");
    expect(out).toContain("Track record: 74% win rate · +$1.2M PnL");
    expect(out).not.toContain("WHALE:"); // 内置抬头没出现
  });

  it("数据缺失的占位符渲染为空并收行(匿名大单无 track)", () => {
    const input = { ...RICH.whale(), smart: null, promiseSettled: false };
    const out = composeWhalePost({
      ...input,
      template: "{icon} {amount}\n\n{track}\n\n{promise}\n\n{title}\n\n{tags}",
    } as never);
    expect(out).toContain("🚨 $300K"); // 300k ≥ 出厂 250k → 🚨
    expect(out).not.toContain("Track record");
    // 空段收行:不允许三连换行残留。
    expect(out).not.toMatch(/\n{3,}/);
  });

  it("sirenUsd 可配:同一笔金额,分档线不同图标不同", () => {
    const base = { ...RICH.whale(), smart: null, promiseSettled: false };
    expect(composeWhalePost({ ...base, sirenUsd: 500_000 } as never)).toContain(
      "🐳 WHALE",
    );
    expect(composeWhalePost({ ...base, sirenUsd: 100_000 } as never)).toContain(
      "🚨 WHALE",
    );
  });

  it("模板安全网:缺 {title}/夹带 URL → 回退内置;超长标题被截且 ≤280", () => {
    const noTitle = compose("whale", "{icon} {amount} {tags}");
    expect(noTitle).toContain("SMART MONEY:"); // 内置抬头 = 回退发生
    const withUrl = compose("whale", "{title} see https://spam.example {tags}");
    expect(withUrl).toContain("SMART MONEY:");
    expect(withUrl).not.toContain("spam.example");
    const long = composeWhalePost({
      ...RICH.whale(),
      title: "A".repeat(400),
      template: "{icon} {amount} on {outcome}\n\n{title}\n\n{tags}",
    } as never);
    expect(weightedLength(long)).toBeLessThanOrEqual(280);
    expect(long).toContain("…");
  });

  it("consensus/pregame/settled 模板路径各自生效", () => {
    expect(
      compose(
        "consensus",
        "{walletCount} wallets → {outcome}\n{title}\n{receipts}",
      ),
    ).toContain("2 wallets → Nongshim Red Force");
    expect(
      compose("pregame", "T-{countdown}: {stance}\n{title}\n{money}"),
    ).toContain("T-3H: smart money is 7-to-1 on Lakers");
    expect(
      compose("settled", "{result} {priceMove}\n{title}\n{stance}"),
    ).toContain("❌ MISSED 40¢ → $0");
  });

  it("weekly 模板:允许 {url};渲染超 280 回退内置", () => {
    const out = compose("weekly", "📊 {week} · {settled} settled\n{url}");
    expect(out).toBe(
      "📊 Aug 10–16 · 42 settled\nhttps://whalewatch.wired.fund/follow?utm_source=x",
    );
    const fat = compose("weekly", `${"long weekly copy ".repeat(30)}{url}`);
    expect(fat).toContain("WEEKLY REPORT"); // 回退内置
  });
});
