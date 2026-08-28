import { describe, expect, it } from "vitest";
import { openDb } from "./db";
import { computeChannelScorecard, loadScorecardRows } from "./channelScorecard";

// 渠道效果记分卡(设计:docs/plans/2026-08-28-channel-scorecard-design.md)。
// 告警台账 × 结局 × source 归因 = 每渠道的向前战绩;共识告警按成员展开,
// 各用各的入场价;离池钱包独立桶防幸存者偏差;fee 不可定价整行出宇宙。

type DB = ReturnType<typeof openDb>;

function seedWallet(
  db: DB,
  address: string,
  source: string | null,
  over: { isWhitelist?: number; marketsTraded?: number } = {},
) {
  db.prepare(
    "INSERT INTO smart_wallets (address, score, is_whitelist, updated_at, source) VALUES (?, 80, ?, 1, ?)",
  ).run(address, over.isWhitelist ?? 0, source);
  if (over.marketsTraded != null) {
    db.prepare(
      "INSERT INTO wallet_stats (wallet, markets_traded, fetched_at) VALUES (?, ?, 1)",
    ).run(address, over.marketsTraded);
  }
}

function seedMeta(db: DB, cid: string, meta: unknown) {
  db.prepare(
    "INSERT INTO market_meta (condition_id, meta_json, fetched_at) VALUES (?, ?, 1)",
  ).run(cid, JSON.stringify(meta));
}

let alertSeq = 0;
function seedAlert(
  db: DB,
  type: string,
  payload: unknown,
  outcome: { won: number | null; resolutionPrice: number | null },
) {
  alertSeq++;
  const res = db
    .prepare(
      "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(type, `k${alertSeq}`, JSON.stringify(payload), 1_000 + alertSeq);
  db.prepare(
    "INSERT INTO alert_outcomes (alert_id, resolved, resolution_price, won, checked_at) VALUES (?, 1, ?, ?, 1)",
  ).run(Number(res.lastInsertRowid), outcome.resolutionPrice, outcome.won);
}

const smartPayload = (
  wallet: string,
  cid: string,
  over: Partial<{ side: string; price: number; size: number }> = {},
) => ({
  proxyWallet: wallet,
  side: over.side ?? "BUY",
  price: over.price ?? 0.5,
  size: over.size ?? 20_000,
  conditionId: cid,
});

describe("loadScorecardRows — 归因与展开", () => {
  it("smart 行:钱包→渠道归一(全局榜/echo/分类榜/手动/未归因/已离池)", () => {
    const db = openDb(":memory:");
    seedWallet(db, "0xa", "leaderboard");
    seedWallet(db, "0xb", "discovered:echo");
    seedWallet(db, "0xc", "category:sports");
    seedWallet(db, "0xd", null, { isWhitelist: 1 });
    seedWallet(db, "0xe", null);
    seedMeta(db, "m1", { feesEnabled: false });
    for (const w of ["0xA", "0xB", "0xC", "0xD", "0xE", "0xGone"]) {
      seedAlert(db, "smart", smartPayload(w, "m1"), {
        won: 1,
        resolutionPrice: 1,
      });
    }
    const { rows } = loadScorecardRows(db);
    const byWallet = new Map(rows.map((r) => [r.wallet, r.channel]));
    expect(byWallet.get("0xa")).toBe("leaderboard");
    expect(byWallet.get("0xb")).toBe("echo");
    expect(byWallet.get("0xc")).toBe("category:sports");
    expect(byWallet.get("0xd")).toBe("manual");
    expect(byWallet.get("0xe")).toBe("unattributed");
    expect(byWallet.get("0xgone")).toBe("departed"); // 离池:行被删,来源失联
  });

  it("SELL 单:q 取 1−price,结算按方向重判(跌赢)", () => {
    const db = openDb(":memory:");
    seedWallet(db, "0xa", "leaderboard");
    seedMeta(db, "m1", { feesEnabled: false });
    seedAlert(
      db,
      "smart",
      smartPayload("0xA", "m1", { side: "SELL", price: 0.6 }),
      { won: null, resolutionPrice: 0 }, // 跌到 0:SELL 赢(won 列故意给 null,靠 resolution 重判)
    );
    const { rows } = loadScorecardRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].q).toBeCloseTo(0.4, 12);
    expect(rows[0].won).toBe(true);
  });

  it("consensus:成员展开,各用各的 avgBuyPrice;同市场去重由聚类兜", () => {
    const db = openDb(":memory:");
    seedWallet(db, "0xa", "leaderboard");
    seedWallet(db, "0xb", "discovered:splitter");
    seedMeta(db, "m2", { feesEnabled: false });
    seedAlert(
      db,
      "consensus",
      {
        conditionId: "m2",
        avgBuyPrice: 0.5,
        wallets: [
          { wallet: "0xA", netUsd: 6_000, avgBuyPrice: 0.4 },
          { wallet: "0xB", netUsd: 4_000, avgBuyPrice: 0.6 },
        ],
      },
      { won: 1, resolutionPrice: 1 },
    );
    const { rows, gradedAlerts } = loadScorecardRows(db);
    expect(gradedAlerts).toBe(1);
    expect(rows).toHaveLength(2);
    const qs = new Map(rows.map((r) => [r.wallet, r.q]));
    expect(qs.get("0xa")).toBeCloseTo(0.4, 12);
    expect(qs.get("0xb")).toBeCloseTo(0.6, 12);
    expect(rows.every((r) => r.alertType === "consensus")).toBe(true);
    expect(rows.every((r) => r.conditionId === "m2")).toBe(true);
  });

  it("fee 三态:免费=0、费率表可算、meta 缺失整行剔除并计数(绝不当 0)", () => {
    const db = openDb(":memory:");
    seedWallet(db, "0xa", "leaderboard");
    seedMeta(db, "mFree", { feesEnabled: false });
    seedMeta(db, "mFee", {
      feesEnabled: true,
      feeSchedule: { exponent: 1, rate: 0.05, takerOnly: true },
    });
    seedAlert(db, "smart", smartPayload("0xA", "mFree"), {
      won: 1,
      resolutionPrice: 1,
    });
    seedAlert(db, "smart", smartPayload("0xA", "mFee"), {
      won: 1,
      resolutionPrice: 1,
    });
    seedAlert(db, "smart", smartPayload("0xA", "mNoMeta"), {
      won: 1,
      resolutionPrice: 1,
    });
    const { rows, feeUnknownDropped } = loadScorecardRows(db);
    expect(rows).toHaveLength(2);
    expect(feeUnknownDropped).toBe(1);
    const byCid = new Map(rows.map((r) => [r.conditionId, r.feePerShare]));
    expect(byCid.get("mFree")).toBe(0);
    // rate×p(1−p) = 0.05×0.5×0.5 = 0.0125 每股。
    expect(byCid.get("mFee")).toBeCloseTo(0.0125, 12);
  });

  it("平局(结算价 ≈0.5 或贴着进价)整行跳过 —— push 不进任何分母", () => {
    const db = openDb(":memory:");
    seedWallet(db, "0xa", "leaderboard");
    seedMeta(db, "m1", { feesEnabled: false });
    seedAlert(db, "smart", smartPayload("0xA", "m1"), {
      won: null,
      resolutionPrice: 0.5,
    });
    expect(loadScorecardRows(db).rows).toHaveLength(0);
  });
});

describe("computeChannelScorecard — 分组统计", () => {
  const row = (
    over: Partial<import("./channelScorecard").ScorecardRow> = {},
  ): import("./channelScorecard").ScorecardRow => ({
    wallet: "0xa",
    conditionId: "m1",
    alertType: "smart",
    q: 0.5,
    won: true,
    feePerShare: 0,
    channel: "leaderboard",
    isMarketMaker: false,
    ...over,
  });

  it("主表:免费市场 12 市场全胜@0.5 → 净 edge +0.50,判定显著为正", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ conditionId: `m${i}`, wallet: `0xw${i % 3}` }),
    );
    const sc = computeChannelScorecard(rows);
    const g = sc.groups.find((g) => g.key === "leaderboard")!;
    expect(g.n).toBe(12);
    expect(g.wallets).toBe(3);
    expect(g.markets).toBe(12);
    expect(g.netEdge).toBeCloseTo(0.5, 12);
    expect(g.verdict).toBe("pos");
    expect(g.smartN).toBe(12);
    expect(g.consensusN).toBe(0);
  });

  it("市场数 <10 → 判定 lowN(样本不足,不给方向结论)", () => {
    const sc = computeChannelScorecard([
      row({ conditionId: "m1" }),
      row({ conditionId: "m2" }),
    ]);
    expect(sc.groups[0].verdict).toBe("lowN");
  });

  it("MM 横切:只切全局榜,机器人与人类各自成组", () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) =>
        row({ conditionId: `a${i}`, wallet: "0xbot", isMarketMaker: true }),
      ),
      ...Array.from({ length: 12 }, (_, i) =>
        row({
          conditionId: `b${i}`,
          wallet: "0xhuman",
          won: i % 2 === 0,
        }),
      ),
      row({ channel: "echo", conditionId: "c1", isMarketMaker: true }),
    ];
    const sc = computeChannelScorecard(rows);
    const mm = sc.mmSplit.find((g) => g.key === "leaderboard:mm")!;
    const human = sc.mmSplit.find((g) => g.key === "leaderboard:human")!;
    expect(mm.n).toBe(12);
    expect(human.n).toBe(12);
    // echo 的 MM 行不进全局榜横切。
    expect(mm.n + human.n).toBe(24);
  });

  it("多重比较分母 = 主表组数 + 横切组数,如实上报", () => {
    const sc = computeChannelScorecard([
      row(),
      row({ channel: "echo", wallet: "0xb", conditionId: "m2" }),
    ]);
    expect(sc.groupCount).toBe(sc.groups.length + sc.mmSplit.length);
    expect(sc.groupCount).toBeGreaterThanOrEqual(2);
  });
});
