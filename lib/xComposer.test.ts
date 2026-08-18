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
        "└ 3 top-PnL wallets → YES @ 58¢ avg · $92K combined\n\n" +
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
  it("结构化全输出锁定:单边站位 every-signal 抬头 + └ 行 + 资金段 + 标签", () => {
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
  it("无站位(sides 缺省)时省略 └ 行与资金段", () => {
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
      "$BTC",
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
    expect(entityTag("Bitcoin price on election day?")).toBe("$BTC");
  });

  it("加密币种输出 cashtag(交易员真在监控的流)", () => {
    expect(entityTag("Will Bitcoin dip to $45,000?")).toBe("$BTC");
    expect(entityTag("Ethereum above $5k?")).toBe("$ETH");
    expect(buildTags({ category: "Crypto", title: "Bitcoin up?" })).toBe(
      "#Polymarket #Crypto $BTC",
    );
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
    // 赛道话题页(#Bitcoin)与实体 cashtag($BTC)是两个不同频道,
    // 形态不同不触发去重 —— 恰好凑满「平台 + 赛道 + 主体」三个。
    expect(tags).toBe("#Polymarket #Bitcoin $BTC");
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

  it("赢单:入场价 → 结算价与名义回报都在抬头", () => {
    expect(composeSettlementPost(base)).toBe(
      "✅ CALLED IT · 40¢ → $1.00 (+150%)\n\n" +
        "Baltimore Orioles vs. Tampa Bay Rays\n" +
        "└ Signal on Baltimore Orioles\n\n" +
        "#Polymarket #MLB",
    );
  });

  it("输单一样发 —— 只发赢的就是 cherry-picking,等于自毁「just the record」", () => {
    // 这条是产品立场,不是技术细节:账号简介写着 No screenshots. Just the
    // record. 只挑赢的发,读者第一次对照就会发现,信任一次性归零。
    const t = composeSettlementPost({ ...base, won: false });
    expect(t).toBe(
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

  it("守住 ≤280 与无 URL 两条硬不变量", () => {
    const t = composeSettlementPost({ ...base, title: "A".repeat(300) });
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    expect(t).not.toContain("http");
  });

  it("入场价缺失/越界时不编回报率,只报结果", () => {
    const t = composeSettlementPost({ ...base, entryCents: null });
    expect(t).toContain("✅ CALLED IT");
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

  it("卖对了 = 标的归零,抬头写 sold …¢ → $0.00", () => {
    expect(composeSettlementPost({ ...sell, won: true })).toContain(
      "✅ CALLED IT · sold 100¢ → $0.00",
    );
  });

  it("卖错了 = 标的结算为 $1", () => {
    expect(composeSettlementPost({ ...sell, won: false })).toContain(
      "❌ MISSED · sold 100¢ → $1.00",
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
    ).toContain("100¢ → $1.00 (+0%)");
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

describe("composeConsensusPost v2", () => {
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

describe("composePregamePost v2", () => {
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

describe("composeSettlementPost v2", () => {
  const base = {
    title: "Baltimore Orioles vs. Tampa Bay Rays",
    outcome: "Baltimore Orioles",
    entryCents: 40,
    side: "BUY" as const,
    won: true,
    signalKind: "consensus" as const,
    postedAgoSec: 2 * 86400,
  };
  it("赢:回报率提进抬头(被 quote 的就是这行),无立场行", () => {
    const t = composeSettlementPost(base);
    expect(t.startsWith("✅ CALLED IT · 40¢ → $1.00 (+150%)")).toBe(true);
    expect(t).toContain(
      "└ Consensus signal on Baltimore Orioles, posted 2d ago",
    );
    expect(t).not.toContain("every result");
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
  it("SELL 沿用两个可核对价格,不编回报率", () => {
    const t = composeSettlementPost({
      ...base,
      side: "SELL",
      entryCents: 62,
      won: true,
    });
    expect(t.startsWith("✅ CALLED IT · sold 62¢ → $0.00")).toBe(true);
  });
  it("无入场价:裸抬头", () => {
    const t = composeSettlementPost({ ...base, entryCents: null });
    expect(t.startsWith("✅ CALLED IT\n")).toBe(true);
  });
  it("postedAgoSec <48h 用小时,缺失省略从句", () => {
    expect(
      composeSettlementPost({ ...base, postedAgoSec: 14 * 3600 }),
    ).toContain("posted 14h ago");
    expect(
      composeSettlementPost({ ...base, postedAgoSec: null }),
    ).not.toContain("posted");
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
});
