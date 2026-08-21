import { describe, it, expect } from "vitest";
import { scoreBand, toPublicCard } from "./cardPublicView";
import type { MarketCard } from "./marketCard";

describe("scoreBand", () => {
  it("三档 + 未知", () => {
    expect(scoreBand(95)).toBe("high");
    expect(scoreBand(80)).toBe("high");
    expect(scoreBand(70)).toBe("mid");
    expect(scoreBand(60)).toBe("mid");
    expect(scoreBand(10)).toBe("low");
    expect(scoreBand(null)).toBeNull();
  });
});

const wallet = (score: number | null) => ({
  wallet: "0xa",
  netUsd: 100,
  avgBuyPrice: 0.5,
  score,
  winRate: 0.6,
});

function cardWith(classification: unknown): MarketCard {
  return {
    conditionId: "0xc1",
    identity: null,
    meta: null,
    brief: {
      classification,
      smartFlow: [
        {
          outcome: "Yes",
          totalExposureUsd: 100,
          wallets: [
            {
              ...wallet(88),
              exposureUsd: 100,
              netShares: 200,
              isMarketMaker: false,
            },
          ],
        },
      ],
      accum: [],
    },
    freshFlow: [],
    history: [],
    window: { trades: 0, truncated: false, hours: 24 },
  } as unknown as MarketCard;
}

describe("toPublicCard", () => {
  it("smartFlow 的每钱包 score 换成 scoreBand,原始分不出现", () => {
    const pub = toPublicCard(cardWith({ kind: "none" }));
    const w = pub.brief.smartFlow[0].wallets[0] as unknown as Record<
      string,
      unknown
    >;
    expect(w.scoreBand).toBe("high");
    expect(w).not.toHaveProperty("score");
    // winRate 是实测统计而非模型输出,照给。
    expect(w.winRate).toBe(0.6);
  });

  it("共识分类里的钱包同样分档 —— 漏一处就等于没做", () => {
    const pub = toPublicCard(
      cardWith({ kind: "consensus", group: { wallets: [wallet(65)] } }),
    );
    const g = (pub.brief.classification as Record<string, any>).group;
    expect(g.wallets[0].scoreBand).toBe("mid");
    expect(g.wallets[0]).not.toHaveProperty("score");
  });

  it("分歧分类的双边钱包同样分档", () => {
    const pub = toPublicCard(
      cardWith({
        kind: "disagreement",
        market: {
          sides: [{ wallets: [wallet(30)] }, { wallets: [wallet(90)] }],
        },
      }),
    );
    const m = (pub.brief.classification as Record<string, any>).market;
    expect(m.sides[0].wallets[0].scoreBand).toBe("low");
    expect(m.sides[1].wallets[0].scoreBand).toBe("high");
    expect(m.sides[0].wallets[0]).not.toHaveProperty("score");
  });

  it("kind:none 不炸", () => {
    expect(() => toPublicCard(cardWith({ kind: "none" }))).not.toThrow();
  });

  it("不改动入参 —— 内部面仍拿得到原始分", () => {
    const card = cardWith({ kind: "none" });
    toPublicCard(card);
    expect(card.brief.smartFlow[0].wallets[0].score).toBe(88);
  });
});
