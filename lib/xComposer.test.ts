import { describe, it, expect } from "vitest";
import {
  composeWhalePost,
  composeConsensusPost,
  composePregamePost,
  composeWeeklyPost,
  composeSettlementPost,
  usdCompact,
  buildTags,
  entityTag,
  strategyEn,
  STRATEGY_EN,
  weightedLength,
  fitPost,
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
    category: "Sports",
    subcategory: "NFL",
  };
  it("结构化四段:断言抬头 / 标题 / 佐证 / 标签", () => {
    expect(composeWhalePost(base)).toBe(
      "🐳 WHALE: $184K says YES @ 67¢\n\n" +
        "Chiefs win Super Bowl LX?\n\n" +
        "📊 12% of 24h vol · 💧 $229K liq · ⏳ 5h to settle\n\n" +
        // 三标签:平台 + 赛道 + 标题命中的实体(Super Bowl)。
        "#Polymarket #NFL #SuperBowl",
    );
  });
  it("单笔占满全天成交量时,抬头追加反常断言", () => {
    // $121K 在 Polymarket 上不算罕见,但「一笔单子 ≥ 该市场全天所有人的
    // 成交量」很罕见。时间线上只有首行有机会被扫到,最稀奇的事实必须放在
    // 那里 —— 否则它躺在第三行中间,等于没说。
    const t = composeWhalePost({ ...base, usd: 121_000, pct24h: 115 });
    expect(t).toMatch(
      /^🐳 WHALE: \$121K says YES @ 67¢ — more than this market's entire 24h volume/,
    );
    // 抬头已经讲了占比,佐证段不再重复 📊,把字符让给别的事实。
    expect(t).not.toContain("📊");
    expect(t).toContain("💧");
  });
  it("占比未过线时保持普通断言抬头(不为了戏剧性而夸张)", () => {
    const t = composeWhalePost({ ...base, pct24h: 12 });
    expect(t).toMatch(/^🐳 WHALE: \$184K says YES @ 67¢/);
    expect(t).not.toContain("entire 24h volume");
    expect(t).toContain("📊 12% of 24h vol"); // 仍作为佐证出现
  });
  it("反常抬头下 🚨 分档与 SELL 方向都不丢", () => {
    const t = composeWhalePost({
      ...base,
      usd: 300_000,
      side: "SELL",
      pct24h: 150,
    });
    expect(t).toMatch(
      /^🚨 WHALE: \$300K sells YES @ 67¢ — more than this market's entire 24h volume/,
    );
  });
  it("SELL 与 🚨 分档在首行体现", () => {
    expect(composeWhalePost({ ...base, side: "SELL" })).toContain(
      "🐳 WHALE: $184K sells YES @ 67¢",
    );
    expect(composeWhalePost({ ...base, usd: 250_000 })).toMatch(/^🚨 WHALE: /);
  });
  it("佐证缺失就整段省略,绝不用 0/N-A 占位", () => {
    const t = composeWhalePost({
      ...base,
      pct24h: null,
      liquidityUsd: null,
      hoursToEnd: null,
    });
    expect(t).toBe(
      "🐳 WHALE: $184K says YES @ 67¢\n\nChiefs win Super Bowl LX?\n\n#Polymarket #NFL #SuperBowl",
    );
    expect(t).not.toContain("📊");
  });
  it("含标签时仍守住 ≤280 与无 URL 两条硬不变量", () => {
    const t = composeWhalePost({ ...base, title: "A".repeat(300) });
    expect([...t].length).toBeLessThanOrEqual(280);
    expect(t).toContain("…");
    expect(t).toContain("#Polymarket");
    expect(t).not.toContain("http");
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
  it("结构化,带聚钱均价 —— 读者要能判断现在还跟不跟得上", () => {
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
        "└ 3 top-PnL wallets → YES @ 58¢ · $92K combined\n\n" +
        "#Polymarket #Economy #Fed",
    );
  });
  it("二级分类优先(#MLB 比 #Sports 精准)", () => {
    expect(
      composeConsensusPost({
        walletCount: 2,
        outcome: "Atlanta Braves",
        title: "Atlanta Braves vs. Minnesota Twins",
        totalUsd: 18_400,
        priceCents: 58,
        category: "Sports",
        subcategory: "MLB",
      }),
    ).toContain("#Polymarket #MLB");
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
        "#Polymarket #NBA",
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
        "#Polymarket #PredictionMarkets",
    );
    expect([...t].length).toBeLessThanOrEqual(280);
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
  it("不再产出 #SmartMoney —— 它在加密圈已被营销号用滥,引来的是垃圾流量", () => {
    // 且 X 对多标签帖降权:两个精准标签 > 三个含泛滥词的标签。
    expect(buildTags({ category: "Crypto" })).toBe("#Polymarket #Crypto");
    expect(buildTags({ category: "Sports", subcategory: "MLB" })).not.toContain(
      "#SmartMoney",
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

describe("entityTag(第三个标签)", () => {
  it("按白名单命中主体,大小写不敏感", () => {
    expect(entityTag("Will Bitcoin close above $95,000 in August?")).toBe(
      "#Bitcoin",
    );
    expect(entityTag("FIFA World Cup: France vs Norway")).toBe("#WorldCup");
    expect(entityTag("Counter-Strike: MIBR vs Astralis (BO1)")).toBe("#CS2");
    expect(entityTag("Fed cut rates in September?")).toBe("#Fed");
  });

  it("词边界:Fed 不误伤 Federer,sol 不误伤 solution", () => {
    // 这类误伤会产出与内容无关的标签 —— 比不加标签更糟(像机器人)。
    expect(entityTag("Wimbledon: Federer vs Nadal")).toBe("#Wimbledon");
    expect(entityTag("Will the solution be adopted?")).toBeNull();
  });

  it("名单外一律不加 —— 宁可少一个,也不要 #Will / #June 这种废标签", () => {
    expect(entityTag("Atlanta Braves vs. Minnesota Twins")).toBeNull();
    expect(entityTag("Will Norway win on 2026-06-28?")).toBeNull();
    expect(entityTag("")).toBeNull();
    expect(entityTag(null)).toBeNull();
  });

  it("顺序即优先级,只取第一个命中", () => {
    // 标题同时含 Bitcoin 与 Election 时取靠前的 Bitcoin。
    expect(entityTag("Bitcoin price on election day?")).toBe("#Bitcoin");
  });

  it("具体项目压过泛赛事名 —— Esports World Cup 该标 #CS2 不是 #WorldCup", () => {
    // 真实数据踩到的:#WorldCup 在足球世界杯赛期会被足球内容淹没,
    // 给一场 CS 比赛贴这个标签,精准度还不如不加。
    expect(
      entityTag(
        "Counter-Strike: Team Falcons vs K27 (BO1) - Esports World Cup Group B",
      ),
    ).toBe("#CS2");
    expect(entityTag("LoL: T1 vs DN SOOPers — Esports World Cup")).toBe(
      "#LeagueOfLegends",
    );
    // 没有更具体标的时,泛赛事名仍然可用。
    expect(entityTag("FIFA World Cup: France vs Norway")).toBe("#WorldCup");
  });
});

describe("buildTags 三标签上限", () => {
  it("平台 + 赛道 + 主体,最多三个", () => {
    const tags = buildTags({
      category: "Crypto",
      subcategory: "Bitcoin",
      title: "Will Bitcoin close above $95,000?",
    });
    // 赛道二级已是 #Bitcoin,实体同名 → 去重,不出现两次。
    expect(tags).toBe("#Polymarket #Bitcoin");
  });

  it("赛道与主体不同名时才凑满三个", () => {
    expect(
      buildTags({
        category: "Sports",
        subcategory: "Esports",
        title: "Counter-Strike: MIBR vs Astralis",
      }),
    ).toBe("#Polymarket #Esports #CS2");
  });

  it("标题无命中时退回两标签", () => {
    expect(
      buildTags({
        category: "Sports",
        subcategory: "MLB",
        title: "Atlanta Braves vs. Minnesota Twins",
      }),
    ).toBe("#Polymarket #MLB");
  });

  it("标签数恒不超过 3", () => {
    const tags = buildTags({
      category: "Politics",
      subcategory: "Geopolitics",
      title: "Will Trump win the 2026 election?",
    });
    expect(tags.split(" ").length).toBeLessThanOrEqual(3);
  });
});

describe("composeSettlementPost(结算战报)", () => {
  const base = {
    title: "Baltimore Orioles vs. Tampa Bay Rays",
    outcome: "Baltimore Orioles",
    entryCents: 40,
    won: true,
    category: "Sports",
    subcategory: "MLB",
  };

  it("赢单:标出入场价 → 结算价与名义回报", () => {
    expect(composeSettlementPost(base)).toBe(
      "✅ SETTLED · CALLED IT\n\n" +
        "Baltimore Orioles vs. Tampa Bay Rays\n" +
        "└ Baltimore Orioles 40¢ → $1.00 · +150%\n\n" +
        "#Polymarket #MLB",
    );
  });

  it("输单一样发 —— 只发赢的就是 cherry-picking,等于自毁「just the record」", () => {
    // 这条是产品立场,不是技术细节:账号简介写着 No screenshots. Just the
    // record. 只挑赢的发,读者第一次对照就会发现,信任一次性归零。
    const t = composeSettlementPost({ ...base, won: false });
    expect(t).toBe(
      "❌ SETTLED · MISSED\n\n" +
        "Baltimore Orioles vs. Tampa Bay Rays\n" +
        "└ Baltimore Orioles 40¢ → $0.00 · -100%\n\n" +
        "#Polymarket #MLB",
    );
  });

  it("高价入场的赢单回报小(40¢ 赢 +150%,90¢ 赢只有 +11%)", () => {
    expect(composeSettlementPost({ ...base, entryCents: 90 })).toContain(
      "90¢ → $1.00 · +11%",
    );
  });

  it("守住 ≤280 与无 URL 两条硬不变量", () => {
    const t = composeSettlementPost({ ...base, title: "A".repeat(300) });
    expect([...t].length).toBeLessThanOrEqual(280);
    expect(t).not.toContain("http");
  });

  it("入场价缺失/越界时不编回报率,只报结果", () => {
    const t = composeSettlementPost({ ...base, entryCents: null });
    expect(t).toContain("✅ SETTLED · CALLED IT");
    expect(t).not.toContain("%");
    expect(t).not.toContain("→");
  });
});

describe("composeSettlementPost · 卖单方向", () => {
  // 真实数据实测踩到的 bug:settleWon 对 SELL 的 won 语义是「卖出后价格
  // 下跌」,套用买入的 entry→$1.00 公式会把「卖对了」说成「买赢了」,
  // 数字与方向全错。
  const sell = {
    title: "The Hundred, Women: Welsh Fire vs London Spirit",
    outcome: "Welsh Fire",
    entryCents: 100,
    side: "SELL" as const,
    category: "Sports",
  };

  it("卖对了 = 标的归零,写成 Sold …¢ → $0.00", () => {
    expect(composeSettlementPost({ ...sell, won: true })).toContain(
      "└ Sold Welsh Fire at 100¢ → $0.00",
    );
  });

  it("卖错了 = 标的结算为 $1", () => {
    expect(composeSettlementPost({ ...sell, won: false })).toContain(
      "└ Sold Welsh Fire at 100¢ → $1.00",
    );
  });

  it("卖单不编回报率(空头的回报基准在预测市场没有统一口径)", () => {
    expect(composeSettlementPost({ ...sell, won: true })).not.toContain("%");
  });

  it("100¢ 成交合法,不该因边界检查丢掉整段价格", () => {
    // 以 $1.00 卖出很常见;老边界写的是 c < 100,把这类整段吞掉了。
    expect(composeSettlementPost({ ...sell, won: true })).toContain("100¢");
    // 买方 100¢ 入场则回报恒为 0%,也应照实显示。
    expect(
      composeSettlementPost({ ...sell, side: "BUY", won: true }),
    ).toContain("100¢ → $1.00 · +0%");
  });

  it("脏价(0 / >100)仍然只报结果", () => {
    expect(
      composeSettlementPost({ ...sell, entryCents: 0, won: true }),
    ).not.toContain("¢");
    expect(
      composeSettlementPost({ ...sell, entryCents: 140, won: true }),
    ).not.toContain("¢");
  });
});

describe("weightedLength", () => {
  it("拉丁字母/数字/常用标点计 1", () => {
    expect(weightedLength("WHALE: $200K @ 80")).toBe(17);
    expect(weightedLength("¢")).toBe(1); // U+00A2 在拉丁补充区
    expect(weightedLength("·")).toBe(1); // U+00B7
    expect(weightedLength("—")).toBe(1); // U+2014 em dash 在 [8208,8223]
    expect(weightedLength("\u2009")).toBe(1); // thin space 在 [8192,8205]
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

describe("composeWhalePost v2", () => {
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
  it("占比 ≥100% 升级抬头,佐证行不重复占比", () => {
    const t = composeWhalePost({ ...base, usd: 300_000, pct24h: 140 });
    expect(t).toContain(
      "🚨 WHALE: $300K says NO @ 80¢ — more than this market's entire 24h volume",
    );
    expect(t).not.toContain("% of 24h vol");
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
  it("超长标题:先丢承诺行再丢佐证行,标题最后才截", () => {
    const t = composeWhalePost({
      ...base,
      title: "Will " + "the committee ".repeat(18) + "decide?",
      promiseSettled: true,
    });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).not.toContain("Result posted");
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
