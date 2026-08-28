import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import type { WalletStats } from "./walletStats";
import {
  ADMIT_MIN_WIN_RATE,
  ADMIT_MIN_SETTLED,
  ADMIT_MIN_ROI,
  ADMIT_MIN_SETTLED_ROI,
  evaluateAdmission,
} from "./admissionGate";
import {
  buildSelfTestVerdict,
  midrankPercentile,
  readPool,
  readLocalStats,
  type PoolMemberRow,
} from "./selfTest";

// 聪明钱自测(设计文档 2026-08-28-smart-money-selftest-design.md):
// 判决口径 = evaluateAdmission 原样透传;表现层只在 hold 之上分「为什么
// 判不了」。「你没过」与「我判不了」必须是两个不同的字。

const stats = (over: Partial<WalletStats> = {}): WalletStats => ({
  winRate: null,
  netPnl: null,
  roi: null,
  settledCount: 0,
  truncated: false,
  marketsTraded: 10,
  isMarketMaker: false,
  ...over,
});

const member = (
  address: string,
  over: Partial<Omit<PoolMemberRow, "address">> = {},
): PoolMemberRow => ({
  address,
  score: 50,
  winRate: 0.6,
  netPnl: 1000,
  ...over,
});

describe("midrankPercentile", () => {
  it("严格居中:低于一半高于一半 → 50", () => {
    expect(midrankPercentile(5, [1, 3, 7, 9])).toBeCloseTo(50);
  });
  it("同值算一半(midrank):value=5 在 [1,5,5] → (1+1)/3", () => {
    expect(midrankPercentile(5, [1, 5, 5])).toBeCloseTo((2 / 3) * 100);
  });
  it("全体低于 → 100;全体高于 → 0", () => {
    expect(midrankPercentile(10, [1, 2])).toBe(100);
    expect(midrankPercentile(0, [1, 2])).toBe(0);
  });
});

describe("buildSelfTestVerdict 判决分层", () => {
  const pool = [member("0xaaa"), member("0xbbb")];

  it("胜率路过闸:已结算≥10、胜率≥55%、净盈亏为正 → pass,gate 透传 admit", () => {
    const s = stats({
      winRate: 0.6,
      netPnl: 1200,
      roi: 0.02,
      settledCount: 12,
    });
    const v = buildSelfTestVerdict("0x1", s, pool);
    expect(v.verdict).toBe("pass");
    expect(v.gate).toBe("admit");
    expect(v.gate).toBe(evaluateAdmission(s));
    expect(v.unjudgedReason).toBeNull();
  });

  it("ROI 路过闸:胜率不够但 ROI≥5%、已结算≥5、净盈亏为正 → pass", () => {
    const s = stats({ winRate: 0.5, netPnl: 500, roi: 0.08, settledCount: 6 });
    const v = buildSelfTestVerdict("0x1", s, pool);
    expect(v.verdict).toBe("pass");
    expect(v.gate).toBe("admit");
  });

  it("做市商 → bot,评分为 null(胜率/ROI 口径不适用)", () => {
    const s = stats({
      netPnl: 90000,
      marketsTraded: 5000,
      isMarketMaker: true,
    });
    const v = buildSelfTestVerdict("0x1", s, pool);
    expect(v.verdict).toBe("bot");
    expect(v.gate).toBe("reject_bot");
    expect(v.score).toBeNull();
    expect(v.percentiles.score).toBeNull();
  });

  it("截断样本 → unjudged/truncated(胜率/ROI 已为 null,绝不显示错数)", () => {
    const s = stats({ netPnl: 8000, settledCount: 900, truncated: true });
    const v = buildSelfTestVerdict("0x1", s, pool);
    expect(v.verdict).toBe("unjudged");
    expect(v.unjudgedReason).toBe("truncated");
    expect(v.gate).toBe("hold");
  });

  it("已结算不足 5 市场 → unjudged/small_sample(两条路的样本线都没到)", () => {
    const s = stats({ winRate: 1, netPnl: 300, roi: 0.5, settledCount: 3 });
    const v = buildSelfTestVerdict("0x1", s, pool);
    expect(v.verdict).toBe("unjudged");
    expect(v.unjudgedReason).toBe("small_sample");
  });

  it("净盈亏不可得 → unjudged/pnl_unavailable(闸门拒绝凭信仰,自测同样拒绝)", () => {
    const s = stats({ winRate: 0.7, netPnl: null, roi: 0.1, settledCount: 20 });
    const v = buildSelfTestVerdict("0x1", s, pool);
    expect(v.verdict).toBe("unjudged");
    expect(v.unjudgedReason).toBe("pnl_unavailable");
  });

  it("样本够、判得出、没过 → fail(与 unjudged 严格分家)", () => {
    const s = stats({
      winRate: 0.4,
      netPnl: -500,
      roi: -0.1,
      settledCount: 20,
    });
    const v = buildSelfTestVerdict("0x1", s, pool);
    expect(v.verdict).toBe("fail");
    expect(v.gate).toBe("hold");
    expect(v.unjudgedReason).toBeNull();
  });

  it("正盈亏但两条路都差口气 → fail(不是 unjudged)", () => {
    const s = stats({ winRate: 0.5, netPnl: 200, roi: 0.03, settledCount: 15 });
    expect(buildSelfTestVerdict("0x1", s, pool).verdict).toBe("fail");
  });

  it("stats 为 null(上游取数失败)→ no_data", () => {
    const v = buildSelfTestVerdict("0x1", null, pool);
    expect(v.verdict).toBe("no_data");
    expect(v.stats).toBeNull();
    expect(v.score).toBeNull();
    expect(v.percentiles.winRate).toBeNull();
  });

  it("criteria 快照 = admissionGate 导出常量(展示口径永不另抄一份)", () => {
    const v = buildSelfTestVerdict("0x1", null, []);
    expect(v.criteria).toEqual({
      minWinRate: ADMIT_MIN_WIN_RATE,
      minSettled: ADMIT_MIN_SETTLED,
      minRoi: ADMIT_MIN_ROI,
      minSettledRoi: ADMIT_MIN_SETTLED_ROI,
    });
  });

  it("inPool:地址已在池内时如实标注(大小写不敏感)", () => {
    const s = stats({
      winRate: 0.6,
      netPnl: 1000,
      roi: 0.02,
      settledCount: 12,
    });
    expect(buildSelfTestVerdict("0xAAA", s, pool).inPool).toBe(true);
    expect(buildSelfTestVerdict("0x999", s, pool).inPool).toBe(false);
  });
});

describe("buildSelfTestVerdict 池内百分位", () => {
  const pool = [
    member("0xa", { winRate: 0.5, netPnl: 100, score: 40 }),
    member("0xb", { winRate: 0.6, netPnl: 200, score: 60 }),
    member("0xc", { winRate: 0.7, netPnl: 300, score: 80 }),
    // win_rate 为 null 的成员不进胜率轴样本
    member("0xd", { winRate: null, netPnl: 400, score: 20 }),
  ];

  it("三轴各算 midrank,分轴样本数只计该列非 null 成员", () => {
    const s = stats({
      winRate: 0.65,
      netPnl: 250,
      roi: 0.06,
      settledCount: 12,
    });
    const v = buildSelfTestVerdict("0x1", s, pool);
    expect(v.poolSize).toBe(4);
    expect(v.percentiles.winRate).toEqual({
      pct: midrankPercentile(0.65, [0.5, 0.6, 0.7]),
      sampleN: 3,
    });
    expect(v.percentiles.netPnl).toEqual({
      pct: midrankPercentile(250, [100, 200, 300, 400]),
      sampleN: 4,
    });
    expect(v.percentiles.score?.sampleN).toBe(4);
  });

  it("访客某轴为 null → 该轴不出(不是 0 分位)", () => {
    const s = stats({ netPnl: 8000, settledCount: 900, truncated: true });
    const v = buildSelfTestVerdict("0x1", s, pool);
    expect(v.percentiles.winRate).toBeNull();
    expect(v.percentiles.netPnl).not.toBeNull();
  });

  it("空池 → 三轴全 null,poolSize 0", () => {
    const s = stats({
      winRate: 0.6,
      netPnl: 1000,
      roi: 0.02,
      settledCount: 12,
    });
    const v = buildSelfTestVerdict("0x1", s, []);
    expect(v.poolSize).toBe(0);
    expect(v.percentiles).toEqual({ winRate: null, netPnl: null, score: null });
  });

  it("评分轴用 admission 同款构造(vol=0):分位可与池成员比较", () => {
    const s = stats({ winRate: 0.7, netPnl: 500, roi: 0.06, settledCount: 12 });
    const v = buildSelfTestVerdict("0x1", s, pool);
    // computeScore({pnl:500,vol:0,winRate:0.7,roi:0.06}) = 0 + 18 + 21 = 39
    expect(v.score).toBe(39);
    expect(v.percentiles.score).toEqual({
      pct: midrankPercentile(39, [40, 60, 80, 20]),
      sampleN: 4,
    });
  });
});

describe("readPool(零上游:只读本地 smart_wallets)", () => {
  it("映射列名(realized_pnl 物理列存的是 netPnl)并全量返回", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO smart_wallets (address, score, realized_pnl, win_rate, roi, is_whitelist, updated_at)
       VALUES ('0xAA', 70, 5000, 0.62, 0.08, 0, 1), ('0xbb', NULL, NULL, NULL, NULL, 1, 2)`,
    ).run();
    const pool = readPool(db);
    expect(pool).toHaveLength(2);
    const a = pool.find((m) => m.address === "0xaa");
    expect(a).toEqual({
      address: "0xaa",
      score: 70,
      winRate: 0.62,
      netPnl: 5000,
    });
    const b = pool.find((m) => m.address === "0xbb");
    expect(b?.score).toBeNull();
    expect(b?.netPnl).toBeNull();
    db.close();
  });
});

describe("readLocalStats(降级/嵌入共用:只读缓存、绝不回源)", () => {
  it("命中 wallet_stats 行(不限龄)→ 返回 stats 与 fetchedAt", async () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO wallet_stats (wallet, win_rate, realized_pnl, roi, settled_count, truncated, markets_traded, fetched_at)
       VALUES ('0xcc', 0.58, 900, 0.06, 14, 0, 30, 1000)`,
    ).run();
    const r = await readLocalStats(db, "0xCC");
    expect(r.fetchedAt).toBe(1000);
    expect(r.stats).toMatchObject({
      winRate: 0.58,
      netPnl: 900,
      roi: 0.06,
      settledCount: 14,
      truncated: false,
      isMarketMaker: false,
    });
    db.close();
  });

  it("无缓存行 → stats null、fetchedAt null,且不触发任何上游", async () => {
    const db = openDb(":memory:");
    const r = await readLocalStats(db, "0xdd");
    expect(r).toEqual({ stats: null, fetchedAt: null });
    db.close();
  });
});
