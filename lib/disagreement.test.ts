import { describe, it, expect } from "vitest";
import { detectDisagreement, qualityWeight } from "./disagreement";
import type { SmartTag } from "./smartWallets";
import type { Trade } from "./types";

const mk = (over: Partial<Trade> = {}): Trade =>
  ({
    transactionHash: `0xtx${Math.random().toString(36).slice(2, 8)}`,
    asset: "assetYes",
    proxyWallet: "0xW1",
    side: "BUY",
    size: 20000,
    price: 0.5, // $10k notional by default
    timestamp: 1000,
    title: "Market",
    slug: "slug",
    eventSlug: "event",
    outcome: "Yes",
    outcomeIndex: 0,
    conditionId: "0xc",
    ...over,
  }) as Trade;

const tag = (score: number | null = 80): SmartTag => ({
  score,
  winRate: 0.7,
  netPnl: 100_000,
  isWhitelist: false,
});

// Smart-tag map with per-wallet scores (lowercased keys, like the real lookup).
const smartMap = (
  entries: Record<string, number | null>,
): Map<string, SmartTag> =>
  new Map(Object.entries(entries).map(([w, s]) => [w.toLowerCase(), tag(s)]));

const OPTS = {
  minPerSideUsd: 5000,
  minWalletsPerSide: 1,
  lopsidedTiltPct: 0.7,
};

describe("qualityWeight", () => {
  it("floors at 0.2 (score 0 / unknown), saturates at 1.0 (score 100)", () => {
    expect(qualityWeight(0)).toBeCloseTo(0.2);
    expect(qualityWeight(50)).toBeCloseTo(0.6);
    expect(qualityWeight(100)).toBeCloseTo(1.0);
    expect(qualityWeight(null)).toBeCloseTo(0.2);
    // Out-of-range scores are clamped, never negative or > 1.
    expect(qualityWeight(-20)).toBeCloseTo(0.2);
    expect(qualityWeight(140)).toBeCloseTo(1.0);
  });
});

describe("detectDisagreement", () => {
  it("surfaces a market where smart money net-buys BOTH opposing outcomes", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1", outcome: "Yes" }),
      mk({
        proxyWallet: "0xB",
        transactionHash: "0x2",
        outcome: "No",
        outcomeIndex: 1,
        asset: "assetNo",
      }),
    ];
    const markets = detectDisagreement(
      trades,
      smartMap({ "0xA": 80, "0xB": 80 }),
      OPTS,
    );
    expect(markets).toHaveLength(1);
    expect(markets[0].sides).toHaveLength(2);
    expect(markets[0].sides.map((s) => s.outcome).sort()).toEqual([
      "No",
      "Yes",
    ]);
    // Equal quality + equal amount → a dead-even split.
    expect(markets[0].tiltPct).toBeCloseTo(0.5);
    expect(markets[0].tilt).toBe("balanced");
  });

  it("ignores a market where only one side has smart buying (no disagreement)", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1", outcome: "Yes" }),
      mk({ proxyWallet: "0xB", transactionHash: "0x2", outcome: "Yes" }),
    ];
    const markets = detectDisagreement(
      trades,
      smartMap({ "0xA": 80, "0xB": 80 }),
      OPTS,
    );
    expect(markets).toHaveLength(0);
  });

  it("等股买卖的假净买不构成分歧一侧（P0.6 验收）", () => {
    // No 侧唯一钱包买 20000 股 @75¢ 后全部卖出 @25¢：USD 净买 $10k 但仓位 0 股
    // —— 不是真实对立面，市场不算分歧。
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1", outcome: "Yes" }),
      mk({
        proxyWallet: "0xC",
        transactionHash: "0x2",
        outcome: "No",
        asset: "assetNo",
        outcomeIndex: 1,
        price: 0.75,
      }),
      mk({
        proxyWallet: "0xC",
        transactionHash: "0x3",
        outcome: "No",
        asset: "assetNo",
        outcomeIndex: 1,
        side: "SELL",
        price: 0.25,
      }),
    ];
    expect(
      detectDisagreement(trades, smartMap({ "0xA": 80, "0xC": 80 }), OPTS),
    ).toHaveLength(0);
  });

  it("MM 不构成分歧对立面：isMarketMaker 一侧不足额时市场不算 contested（P0.5）", () => {
    // 做市挂单吃掉一边不代表方向性反对 —— 若对立面全是 MM，市场不该被
    // 归为分歧（否则 P0.7 互斥会连带压掉另一侧真实共识的推送）。
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1", outcome: "Yes" }),
      mk({
        proxyWallet: "0xMM",
        transactionHash: "0x2",
        outcome: "No",
        asset: "assetNo",
        outcomeIndex: 1,
      }),
    ];
    const smart = smartMap({ "0xA": 80 });
    smart.set("0xmm", { ...tag(80), isMarketMaker: true });
    expect(detectDisagreement(trades, smart, OPTS)).toHaveLength(0);
  });

  it("drops a wallet net-buying BOTH sides (hedger/market-maker = fake opposition)", () => {
    const trades = [
      // 0xMM plays both sides — a hedge, not an opinion.
      mk({ proxyWallet: "0xMM", transactionHash: "0x1", outcome: "Yes" }),
      mk({ proxyWallet: "0xMM", transactionHash: "0x2", outcome: "No" }),
      // Only a genuine Yes bet remains; No side has no real buyer left.
      mk({ proxyWallet: "0xA", transactionHash: "0x3", outcome: "Yes" }),
    ];
    const markets = detectDisagreement(
      trades,
      smartMap({ "0xMM": 80, "0xA": 80 }),
      OPTS,
    );
    expect(markets).toHaveLength(0);
  });

  it("excludes the both-sides hedger but still surfaces the genuine disagreement", () => {
    const trades = [
      mk({ proxyWallet: "0xMM", transactionHash: "0x1", outcome: "Yes" }),
      mk({ proxyWallet: "0xMM", transactionHash: "0x2", outcome: "No" }),
      mk({ proxyWallet: "0xA", transactionHash: "0x3", outcome: "Yes" }),
      mk({ proxyWallet: "0xB", transactionHash: "0x4", outcome: "No" }),
    ];
    const markets = detectDisagreement(
      trades,
      smartMap({ "0xMM": 80, "0xA": 80, "0xB": 80 }),
      OPTS,
    );
    expect(markets).toHaveLength(1);
    expect(markets[0].excludedWallets).toBe(1);
    for (const side of markets[0].sides) {
      expect(side.walletCount).toBe(1);
      expect(side.wallets.map((w) => w.wallet)).not.toContain("0xmm");
    }
  });

  it("tilts by QUALITY-weighted amount, not raw USD", () => {
    const trades = [
      // Yes: score-100 wallet, $10k → weighted 10000 × 1.0 = 10000
      mk({ proxyWallet: "0xHI", transactionHash: "0x1", outcome: "Yes" }),
      // No: score-0 wallet, BIGGER $20k → weighted 20000 × 0.2 = 4000
      mk({
        proxyWallet: "0xLO",
        transactionHash: "0x2",
        outcome: "No",
        size: 40000,
        price: 0.5,
      }),
    ];
    const markets = detectDisagreement(
      trades,
      smartMap({ "0xHI": 100, "0xLO": 0 }),
      OPTS,
    );
    expect(markets).toHaveLength(1);
    // Raw USD favors No ($20k > $10k) but quality-weight flips it to Yes.
    expect(markets[0].sides[0].outcome).toBe("Yes");
    expect(markets[0].tiltPct).toBeCloseTo(10000 / (10000 + 4000));
    expect(markets[0].tilt).toBe("lopsided"); // ~0.714 ≥ 0.7
  });

  it("requires each side to clear the per-side USD floor", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1", outcome: "Yes" }), // $10k
      mk({
        proxyWallet: "0xB",
        transactionHash: "0x2",
        outcome: "No",
        size: 4000,
        price: 0.5,
      }), // $2k < $5k floor
    ];
    const markets = detectDisagreement(
      trades,
      smartMap({ "0xA": 80, "0xB": 80 }),
      OPTS,
    );
    expect(markets).toHaveLength(0);
  });

  it("dedups re-served pagination rows so a side isn't double-counted", () => {
    const yesA = mk({
      proxyWallet: "0xA",
      transactionHash: "0xsame",
      outcome: "Yes",
    });
    const markets = detectDisagreement(
      [
        yesA,
        { ...yesA },
        mk({ proxyWallet: "0xB", transactionHash: "0xb", outcome: "No" }),
      ],
      smartMap({ "0xA": 80, "0xB": 80 }),
      OPTS,
    );
    const yesSide = markets[0].sides.find((s) => s.outcome === "Yes");
    expect(yesSide?.netUsd).toBe(10000);
  });

  it("ignores non-whitelist wallets entirely", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1", outcome: "Yes" }),
      mk({ proxyWallet: "0xDUMB", transactionHash: "0x2", outcome: "No" }),
    ];
    const markets = detectDisagreement(trades, smartMap({ "0xA": 80 }), OPTS);
    expect(markets).toHaveLength(0);
  });

  it("a net-seller of an outcome doesn't count as buying that side", () => {
    const trades = [
      mk({ proxyWallet: "0xA", transactionHash: "0x1", outcome: "Yes" }), // +$10k Yes
      mk({ proxyWallet: "0xB", transactionHash: "0x2", outcome: "No" }), // +$10k No
      mk({
        proxyWallet: "0xB",
        transactionHash: "0x3",
        outcome: "No",
        side: "SELL",
        size: 40000,
        price: 0.5,
      }), // -$20k No → net -$10k
    ];
    const markets = detectDisagreement(
      trades,
      smartMap({ "0xA": 80, "0xB": 80 }),
      OPTS,
    );
    expect(markets).toHaveLength(0);
  });
});

// Task 7: DisagreementSide.formationTs —— C1(一边倒分歧)跟单档的新鲜度闸门 /
// 护栏基准取价 / markout 锚点都靠它。语义:tiltPct 首次跨过 lopsidedTiltPct 的
// 那一笔成交时间,只认【最终主导边】(sides[0]),既不能用市场级 lastTs(被组内
// 任何白名单成交刷新,含 SELL/不达标钱包 —— 见 lib/follow.ts 的
// FollowCycleDeps.fetchWindow 注释记录的同一个已修 bug),也不能用"本边自己
// 成立时刻"(多数边往往早就站住,倾斜是少数边后来撤退才形成的)。
describe("detectDisagreement — 倾斜形成时刻(formationTs)", () => {
  it("tiltPct 首次跨过阈值的那一刻 = 主导边(sides[0])的 formationTs", () => {
    // t=100: A 单独买 Yes $6k(只一边,还未 contested)
    // t=200: B 买 No $6k(两边都过 $5k floor,但 tilt=6/12=0.5 < 0.7)
    // t=300: C 再买 Yes $20k → Yes=$26k vs No=$6k,tilt=26/32=0.8125 ≥ 0.7
    //        ← 倾斜形成
    const trades = [
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x1",
        timestamp: 100,
        outcome: "Yes",
        size: 12000,
        price: 0.5,
      }), // $6k Yes
      mk({
        proxyWallet: "0xB",
        transactionHash: "0x2",
        timestamp: 200,
        outcome: "No",
        outcomeIndex: 1,
        asset: "assetNo",
        size: 12000,
        price: 0.5,
      }), // $6k No
      mk({
        proxyWallet: "0xC",
        transactionHash: "0x3",
        timestamp: 300,
        outcome: "Yes",
        size: 40000,
        price: 0.5,
      }), // $20k more Yes
    ];
    const out = detectDisagreement(
      trades,
      smartMap({ "0xA": 80, "0xB": 80, "0xC": 80 }),
      OPTS,
    );
    expect(out).toHaveLength(1);
    expect(out[0].tilt).toBe("lopsided");
    expect(out[0].sides[0].outcome).toBe("Yes");
    expect(out[0].sides[0].formationTs).toBe(300);
    // 非主导边不适用"形成"概念(C1 只读 sides[0].formationTs),恒为 null。
    expect(out[0].sides[1].formationTs).toBeNull();
  });

  it("balanced 市场(从未跨过阈值)→ formationTs 为 null", () => {
    const trades = [
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x1",
        timestamp: 100,
        outcome: "Yes",
      }), // $10k
      mk({
        proxyWallet: "0xB",
        transactionHash: "0x2",
        timestamp: 200,
        outcome: "No",
        outcomeIndex: 1,
        asset: "assetNo",
      }), // $10k;tiltPct=0.5,从未跨过 0.7
    ];
    const out = detectDisagreement(
      trades,
      smartMap({ "0xA": 80, "0xB": 80 }),
      OPTS,
    );
    expect(out[0].tilt).toBe("balanced");
    expect(out[0].sides[0].formationTs).toBeNull();
  });

  it("倾斜后回落再重新跨过 → 取【首次】跨过的时刻,不被后来的波动重置", () => {
    const trades = [
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x1",
        timestamp: 100,
        outcome: "Yes",
        size: 12000,
        price: 0.5,
      }), // Yes $6k
      mk({
        proxyWallet: "0xB",
        transactionHash: "0x2",
        timestamp: 200,
        outcome: "No",
        outcomeIndex: 1,
        asset: "assetNo",
        size: 12000,
        price: 0.5,
      }), // No $6k;5:5 未跨线
      mk({
        proxyWallet: "0xC",
        transactionHash: "0x3",
        timestamp: 300,
        outcome: "Yes",
        size: 40000,
        price: 0.5,
      }), // Yes+$20k=$26k;26/32=0.8125≥0.7 ← 首次跨线
      mk({
        proxyWallet: "0xD",
        transactionHash: "0x4",
        timestamp: 400,
        outcome: "No",
        outcomeIndex: 1,
        asset: "assetNo",
        size: 40000,
        price: 0.5,
      }), // No+$20k=$26k;26/52=0.5,回落
      mk({
        proxyWallet: "0xE",
        transactionHash: "0x5",
        timestamp: 500,
        outcome: "Yes",
        size: 120000,
        price: 0.5,
      }), // Yes+$60k=$86k;86/112≈0.768,再次跨线(不该被计)
    ];
    const out = detectDisagreement(
      trades,
      smartMap({ "0xA": 80, "0xB": 80, "0xC": 80, "0xD": 80, "0xE": 80 }),
      OPTS,
    );
    expect(out[0].sides[0].outcome).toBe("Yes");
    expect(out[0].sides[0].formationTs).toBe(300); // 首次(t=300),不是第二次的 t=500
  });

  it("重放只认最终主导边:中途曾由另一边领先并一度达标,也不算", () => {
    // t=100~300 Under 领先 —— t=300 时若拿 Under 自己当 leadOutcome,它的占比
    // 20000/25000=0.8 ≥ 0.7,会在这里就"跨线"。但 t=400 起 Over 追加买入反超
    // 并成为最终主导边,重放全程只认 Over 一侧的占比,Over 首次达标在 t=600。
    const trades = [
      mk({
        proxyWallet: "0xA",
        transactionHash: "0x1",
        timestamp: 100,
        outcome: "Under",
        outcomeIndex: 1,
        asset: "assetUnder",
        size: 16000,
        price: 0.5,
      }), // Under $8k
      mk({
        proxyWallet: "0xB",
        transactionHash: "0x2",
        timestamp: 200,
        outcome: "Over",
        outcomeIndex: 0,
        asset: "assetOver",
        size: 10000,
        price: 0.5,
      }), // Over $5k(恰过 floor)
      mk({
        proxyWallet: "0xC",
        transactionHash: "0x3",
        timestamp: 300,
        outcome: "Under",
        outcomeIndex: 1,
        asset: "assetUnder",
        size: 24000,
        price: 0.5,
      }), // Under+$12k=$20k(Under 自己占比 0.8,陷阱:若误用会在此跨线)
      mk({
        proxyWallet: "0xD",
        transactionHash: "0x4",
        timestamp: 400,
        outcome: "Over",
        outcomeIndex: 0,
        asset: "assetOver",
        size: 60000,
        price: 0.5,
      }), // Over+$30k=$35k;35/55=0.636
      mk({
        proxyWallet: "0xE",
        transactionHash: "0x5",
        timestamp: 500,
        outcome: "Over",
        outcomeIndex: 0,
        asset: "assetOver",
        size: 10000,
        price: 0.5,
      }), // Over+$5k=$40k;40/60=0.667
      mk({
        proxyWallet: "0xF",
        transactionHash: "0x6",
        timestamp: 600,
        outcome: "Over",
        outcomeIndex: 0,
        asset: "assetOver",
        size: 40000,
        price: 0.5,
      }), // Over+$20k=$60k;60/80=0.75≥0.7 ← Over 首次达标
    ];
    const out = detectDisagreement(
      trades,
      smartMap({
        "0xA": 80,
        "0xB": 80,
        "0xC": 80,
        "0xD": 80,
        "0xE": 80,
        "0xF": 80,
      }),
      OPTS,
    );
    expect(out[0].sides[0].outcome).toBe("Over");
    expect(out[0].sides[0].formationTs).toBe(600);
  });

  it("主导边未过 floor 但加权占比虚高 → 不能在那一刻误判达标(回归:leadOutcome 必须自己也在 qualified 里)", () => {
    // t=300 时 Over 净买仅 $4900 < $5000 floor(本不该进 qualified),但满分
    // 钱包(quality weight 1.0)撑出 weighted $4900;Under/Third 各净买 $5000
    // 但都是 0 分钱包(weight 地板 0.2)只撑出 weighted $1000。若达标判定不要求
    // leadOutcome 自己也在 qualified 里,4900/(1000+1000)=2.45 ≥ 0.7,会在
    // t=300 误判倾斜已形成 —— 而此刻 Over 离 floor 还差 $100,根本没站稳。
    // t=400 Over 再买 $200 才真正过 floor,此时 5100/(5100+1000+1000)≈0.718
    // 才是诚实的首次达标时刻。
    const trades = [
      mk({
        proxyWallet: "0xOver",
        transactionHash: "0x1",
        timestamp: 100,
        outcome: "Over",
        outcomeIndex: 0,
        asset: "assetOver",
        size: 9800,
        price: 0.5,
      }), // Over $4900,未过 floor
      mk({
        proxyWallet: "0xUnder",
        transactionHash: "0x2",
        timestamp: 200,
        outcome: "Under",
        outcomeIndex: 1,
        asset: "assetUnder",
        size: 10000,
        price: 0.5,
      }), // Under $5000
      mk({
        proxyWallet: "0xThird",
        transactionHash: "0x3",
        timestamp: 300,
        outcome: "Third",
        outcomeIndex: 2,
        asset: "assetThird",
        size: 10000,
        price: 0.5,
      }), // Third $5000 ← bug 会在此误判
      mk({
        proxyWallet: "0xOver",
        transactionHash: "0x4",
        timestamp: 400,
        outcome: "Over",
        outcomeIndex: 0,
        asset: "assetOver",
        size: 400,
        price: 0.5,
      }), // Over 再买 $200 → 净买 $5100,首次真正过 floor
    ];
    const out = detectDisagreement(
      trades,
      smartMap({ "0xOver": 100, "0xUnder": 0, "0xThird": 0 }),
      OPTS,
    );
    expect(out).toHaveLength(1);
    expect(out[0].sides[0].outcome).toBe("Over");
    expect(out[0].sides[0].formationTs).not.toBe(300); // bug 会误判的时刻
    expect(out[0].sides[0].formationTs).toBe(400); // 诚实的首次达标时刻
  });

  it("同一秒内跨边的反向大单:formationTs 不随这些成交在数组里的相对顺序摆动(按秒分批判定,回归)", () => {
    // 早前时刻先站稳 Over=$10k / Under=$10k(比例 0.5,未跨线)。
    const A = mk({
      proxyWallet: "0xA",
      transactionHash: "0x1",
      timestamp: 100,
      outcome: "Over",
      outcomeIndex: 0,
      asset: "assetOver",
      size: 20000,
      price: 0.5,
    }); // Over $10k
    const B = mk({
      proxyWallet: "0xB",
      transactionHash: "0x2",
      timestamp: 200,
      outcome: "Under",
      outcomeIndex: 1,
      asset: "assetUnder",
      size: 20000,
      price: 0.5,
    }); // Under $10k
    // 同一秒 t=300 两笔反向大单:整组算完后 Over=Under=$40k,比例仍是 0.5,
    // 不该跨线 —— 但若逐笔判定,先处理 Over 那笔会在组内瞬间读到
    // 40000/50000=0.8 并立即 return,这个瞬时假象只取决于这两笔在输入数组里
    // 的先后,不代表链上真实执行序。
    const X = mk({
      proxyWallet: "0xX",
      transactionHash: "0x3",
      timestamp: 300,
      outcome: "Over",
      outcomeIndex: 0,
      asset: "assetOver",
      size: 60000,
      price: 0.5,
    }); // Over +$30k
    const Y = mk({
      proxyWallet: "0xY",
      transactionHash: "0x4",
      timestamp: 300,
      outcome: "Under",
      outcomeIndex: 1,
      asset: "assetUnder",
      size: 60000,
      price: 0.5,
    }); // Under +$30k
    // t=400 才是诚实的跨线:Over 再 +$60k → 100000/140000≈0.714 ≥ 0.7。
    const C = mk({
      proxyWallet: "0xC",
      transactionHash: "0x5",
      timestamp: 400,
      outcome: "Over",
      outcomeIndex: 0,
      asset: "assetOver",
      size: 120000,
      price: 0.5,
    }); // Over +$60k

    const smart = smartMap({
      "0xA": 80,
      "0xB": 80,
      "0xX": 80,
      "0xY": 80,
      "0xC": 80,
    });
    const outXY = detectDisagreement([A, B, X, Y, C], smart, OPTS);
    const outYX = detectDisagreement([A, B, Y, X, C], smart, OPTS);

    expect(outXY[0].sides[0].outcome).toBe("Over");
    expect(outYX[0].sides[0].outcome).toBe("Over");
    // 两种数组序结果必须一致,且都是诚实的 t=400,不是同秒乱序造出的 t=300。
    expect(outXY[0].sides[0].formationTs).toBe(400);
    expect(outYX[0].sides[0].formationTs).toBe(400);
  });

  it("SELL 引发的部分平仓必须按 exposureUsd 增量计入,不能按裸现金流(回归:锁死重放口径)", () => {
    // No 边:单钱包买 $10k,先站稳一个已过线的对照边。
    const trades = [
      mk({
        proxyWallet: "0xN",
        transactionHash: "0x1",
        timestamp: 50,
        outcome: "No",
        outcomeIndex: 1,
        asset: "assetNo",
      }), // $10k
      // Yes 边:0xY 买 100,000 股 @$0.10 = $10k(avgBuyPrice=0.10)。
      mk({
        proxyWallet: "0xY",
        transactionHash: "0x2",
        timestamp: 100,
        outcome: "Yes",
        size: 100000,
        price: 0.1,
      }),
      // 0xY 卖 20,000 股 @$0.90 = $18k(留仓 80,000 股)。
      // exposureUsd: 10000→8000,delta=−2000,只掉留仓那 20,000 股按买入均价
      // (0.10)算的成本 —— 裸现金流口径会把整笔卖出金额 $18k 倒扣,
      // delta=−18000,天差地别。
      mk({
        proxyWallet: "0xY",
        transactionHash: "0x3",
        timestamp: 200,
        outcome: "Yes",
        side: "SELL",
        size: 20000,
        price: 0.9,
      }),
      // 另一钱包 0xY2 买 30,800 股 @$0.5 = $15,400。
      // 正确口径(exposureUsd 增量):Yes=8000+15400=23400,
      //   比例=23400/(23400+10000)≈0.7006 ≥ 0.7 → 跨线于 t=300
      // 裸现金流口径(退化,防止未来重构不小心退回去):
      //   Yes=(10000−18000)+15400=7400,比例≈0.425,永不跨线
      mk({
        proxyWallet: "0xY2",
        transactionHash: "0x4",
        timestamp: 300,
        outcome: "Yes",
        size: 30800,
        price: 0.5,
      }),
    ];
    const out = detectDisagreement(
      trades,
      smartMap({ "0xN": 80, "0xY": 80, "0xY2": 80 }),
      OPTS,
    );
    expect(out).toHaveLength(1);
    expect(out[0].sides[0].outcome).toBe("Yes");
    expect(out[0].sides[0].formationTs).toBe(300);
  });
});
