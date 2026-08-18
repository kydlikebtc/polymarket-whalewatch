// 标签系统单测(buildTags / entityTag)—— 从 lib/xComposer.test.ts 拆出:
// 标签是独立于五类模板的可测单元,拆开让两个文件都待在 800 行以内。
import { describe, it, expect } from "vitest";
import { buildTags, entityTag } from "./xComposer";

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
