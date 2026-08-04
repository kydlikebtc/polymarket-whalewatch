import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import {
  formatRecordLine,
  typeSignalRecord,
  walletSignalRecord,
  type SignalRecord,
} from "./signalRecord";

const NOW = 1_700_000_000;
const DAY = 86_400;

let seq = 0;
function insertSignal(
  db: ReturnType<typeof openDb>,
  over: {
    type?: string;
    wallet?: string;
    createdAt?: number;
    won?: number | null; // null = push 或未结算(见 resolved)
    resolved?: number;
    price?: number | null; // 成交价 = 市场隐含概率（评分基准）
    priceKey?: "price" | "avgBuyPrice"; // consensus 用后者
    side?: "BUY" | "SELL" | null; // null = payload 无该键（consensus 的形态）
    conditionId?: string; // 共识折叠键的一半
    outcome?: string; // 另一半
  } = {},
): void {
  const {
    type = "large",
    wallet = "0xAAA",
    createdAt = NOW - DAY,
    won = 1,
    resolved = 1,
    price = 0.5,
    priceKey = "price",
    side = "BUY",
    conditionId,
    outcome,
  } = over;
  const payload: Record<string, unknown> = { proxyWallet: wallet };
  if (price != null) payload[priceKey] = price;
  if (side != null) payload.side = side;
  if (conditionId != null) payload.conditionId = conditionId;
  if (outcome != null) payload.outcome = outcome;
  const r = db
    .prepare(
      "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(type, `k${seq++}`, JSON.stringify(payload), createdAt);
  db.prepare(
    "INSERT INTO alert_outcomes (alert_id, resolved, won, checked_at) VALUES (?, ?, ?, ?)",
  ).run(Number(r.lastInsertRowid), resolved, won, createdAt);
}

describe("walletSignalRecord", () => {
  it("统计该钱包 30d 内 large/smart 信号的已判定战绩（win/loss，push 与未结算不计分母）", () => {
    const db = openDb(":memory:");
    insertSignal(db, { won: 1 });
    insertSignal(db, { won: 0 });
    insertSignal(db, { type: "smart", won: 1 });
    insertSignal(db, { won: null, resolved: 1 }); // push → 不计
    insertSignal(db, { won: null, resolved: 0 }); // 未结算 → 不计
    insertSignal(db, { wallet: "0xOTHER", won: 1 }); // 别人的 → 不计
    insertSignal(db, { type: "consensus", won: 1 }); // 类型不符 → 不计
    insertSignal(db, { createdAt: NOW - 31 * DAY, won: 1 }); // 窗口外 → 不计
    const r = walletSignalRecord(db, "0xaaa", { nowSec: NOW });
    expect(r.settled).toBe(3);
    expect(r.wins).toBe(2);
    // 三笔都成交在 0.5：市场自己预期赢 1.5 次，实际 2 次 → 超额 +0.5
    expect(r.implied).toBeCloseTo(1.5);
    expect(r.excess).toBeCloseTo(0.5);
  });

  it("超额以成交价为基准，而非 50% —— 原始胜率会把两类钱包排反", () => {
    // 全买大热门 0.9，10 战 9 胜：原始胜率 90% 唬人，但市场本就预期 9 胜。
    const db = openDb(":memory:");
    for (let i = 0; i < 9; i++) insertSignal(db, { won: 1, price: 0.9 });
    insertSignal(db, { won: 0, price: 0.9 });
    const fav = walletSignalRecord(db, "0xaaa", { nowSec: NOW });
    expect(fav.wins).toBe(9);
    expect(fav.implied).toBeCloseTo(9);
    expect(fav.excess).toBeCloseTo(0); // 毫无信息量

    // 全买冷门 0.2，10 战 3 胜：原始胜率 30% 难看，实则跑赢市场。
    const db2 = openDb(":memory:");
    for (let i = 0; i < 3; i++) insertSignal(db2, { won: 1, price: 0.2 });
    for (let i = 0; i < 7; i++) insertSignal(db2, { won: 0, price: 0.2 });
    const dog = walletSignalRecord(db2, "0xaaa", { nowSec: NOW });
    expect(dog.excess).toBeCloseTo(1); // 比市场预期多赢 1 次
    expect(dog.wins / dog.settled).toBeLessThan(fav.wins / fav.settled);
    expect(dog.excess).toBeGreaterThan(fav.excess);
  });

  it("SELL 侧基准取 1−成交价 —— 市场对「跌」的隐含概率才是卖方的对手盘", () => {
    // 10 笔 SELL@0.20 全部结算到 0：settleWon 判 rp<entry 即卖方赢 → 10 胜。
    // 但市场在 0.20 处隐含的正是「有 80% 概率归零」——这 10 胜是市场自己
    // 预期的结果，零信息量。旧口径拿 Σ0.20=2.0 当预期，算出超额 +8.0
    // (6.3σ) 并往频道印「已超运气范围」，把一个零优势的策略认证成了 alpha。
    const db = openDb(":memory:");
    for (let i = 0; i < 10; i++) {
      insertSignal(db, { won: 1, price: 0.2, side: "SELL" });
    }
    const r = walletSignalRecord(db, "0xaaa", { nowSec: NOW });
    expect(r.wins).toBe(10);
    expect(r.implied).toBeCloseTo(8); // 旧口径:2.0
    expect(r.excess).toBeCloseTo(2); // 旧口径:+8.0
    // p(1−p) 对称 ⇒ sd 不随方向改变;错的只有 implied/excess 的中心。
    expect(r.sd).toBeCloseTo(Math.sqrt(10 * 0.2 * 0.8));
    // 修正后 2.0/1.26 = 1.58σ,诚实地落回运气范围内。
    expect(formatRecordLine("该钱包", r)).toContain("仍在运气范围内");
  });

  it("BUY 侧口径不变（回归保护）", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 10; i++) {
      insertSignal(db, { won: 1, price: 0.2, side: "BUY" });
    }
    const r = walletSignalRecord(db, "0xaaa", { nowSec: NOW });
    expect(r.implied).toBeCloseTo(2);
    expect(r.excess).toBeCloseTo(8);
  });

  it("payload 无 side 键时按 BUY 计（共识本身就是净买入）", () => {
    const db = openDb(":memory:");
    insertSignal(db, { won: 1, price: 0.3, side: null });
    const r = walletSignalRecord(db, "0xaaa", { nowSec: NOW });
    expect(r.implied).toBeCloseTo(0.3);
  });

  it("无成交价的行两侧都不计（没有基准就无法评分）", () => {
    const db = openDb(":memory:");
    insertSignal(db, { won: 1, price: 0.5 });
    insertSignal(db, { won: 1, price: null });
    const r = walletSignalRecord(db, "0xaaa", { nowSec: NOW });
    expect(r.settled).toBe(1);
    expect(r.wins).toBe(1);
    expect(r.implied).toBeCloseTo(0.5);
  });

  it("大小写不敏感（payload 里的地址可能是混合大小写）", () => {
    const db = openDb(":memory:");
    insertSignal(db, { wallet: "0xAbCd", won: 1 });
    expect(walletSignalRecord(db, "0xabcd", { nowSec: NOW }).settled).toBe(1);
  });
});

describe("typeSignalRecord", () => {
  it("按信号类型统计 30d 战绩（共识推送用）", () => {
    const db = openDb(":memory:");
    insertSignal(db, { type: "consensus", won: 1 });
    insertSignal(db, { type: "consensus", won: 0 });
    insertSignal(db, { type: "large", won: 1 }); // 类型不符 → 不计
    const r = typeSignalRecord(db, "consensus", { nowSec: NOW });
    expect(r.settled).toBe(2);
    expect(r.wins).toBe(1);
  });

  it("同一次共识的升级行折叠为一条 —— 第 3 人加入不是第二个信号", () => {
    // dedup_key 含 walletCount(consensus.ts),2 人升 3 人升 4 人 = 三条 alerts
    // 行，逐行计数会把同一次共识计三次。方向性偏差明确:升级过的组恰是更强
    // 的组，重复计数给强信号加权 → 战绩系统性抬高;同时这三行显然不独立，
    // sd=√Σp(1−p) 的伯努利独立性假设被破坏，「已超运气范围」判定偏乐观。
    const db = openDb(":memory:");
    const base = {
      type: "consensus",
      priceKey: "avgBuyPrice" as const,
      side: null,
      conditionId: "0xCID",
      outcome: "Yes",
    };
    insertSignal(db, { ...base, createdAt: NOW - 3 * DAY, price: 0.4, won: 1 });
    insertSignal(db, { ...base, createdAt: NOW - 2 * DAY, price: 0.5, won: 1 });
    insertSignal(db, { ...base, createdAt: NOW - DAY, price: 0.6, won: 1 });
    const r = typeSignalRecord(db, "consensus", { nowSec: NOW });
    expect(r.settled).toBe(1);
    expect(r.wins).toBe(1);
    // 保留的是形成时刻那一条 —— 读者当时真正能行动的价格。
    expect(r.implied).toBeCloseTo(0.4);
  });

  it("不同市场 / 不同结果的共识各算各的（折叠不过度）", () => {
    const db = openDb(":memory:");
    const base = {
      type: "consensus",
      priceKey: "avgBuyPrice" as const,
      side: null,
      price: 0.5,
      won: 1,
    };
    insertSignal(db, { ...base, conditionId: "0xA", outcome: "Yes" });
    insertSignal(db, { ...base, conditionId: "0xA", outcome: "No" });
    insertSignal(db, { ...base, conditionId: "0xB", outcome: "Yes" });
    expect(typeSignalRecord(db, "consensus", { nowSec: NOW }).settled).toBe(3);
  });

  it("大额/聪明钱不折叠 —— 每笔成交是独立信号", () => {
    // 同一钱包在同一市场的多笔大额买入是多次独立决策，折叠会丢样本。
    const db = openDb(":memory:");
    for (let i = 0; i < 3; i++) {
      insertSignal(db, { conditionId: "0xA", outcome: "Yes", won: 1 });
    }
    expect(walletSignalRecord(db, "0xaaa", { nowSec: NOW }).settled).toBe(3);
  });

  it("共识 payload 缺 conditionId/outcome 时不折叠（宁可重复也不误合并）", () => {
    const db = openDb(":memory:");
    const base = {
      type: "consensus",
      priceKey: "avgBuyPrice" as const,
      side: null,
      price: 0.5,
      won: 1,
    };
    insertSignal(db, base);
    insertSignal(db, base);
    expect(typeSignalRecord(db, "consensus", { nowSec: NOW }).settled).toBe(2);
  });

  it("共识的成交价在 avgBuyPrice 键下，同样能取到基准", () => {
    const db = openDb(":memory:");
    const o = {
      type: "consensus",
      price: 0.4,
      priceKey: "avgBuyPrice" as const,
    };
    insertSignal(db, { ...o, won: 1 });
    insertSignal(db, { ...o, won: 0 });
    const r = typeSignalRecord(db, "consensus", { nowSec: NOW });
    expect(r.settled).toBe(2);
    expect(r.implied).toBeCloseTo(0.8);
    expect(r.excess).toBeCloseTo(0.2);
  });
});

// 构造 formatRecordLine 的输入：给定笔数/胜数/统一成交价。
function rec(settled: number, wins: number, price: number): SignalRecord {
  return {
    settled,
    wins,
    implied: settled * price,
    excess: wins - settled * price,
    sd: Math.sqrt(settled * price * (1 - price)),
  };
}

describe("formatRecordLine", () => {
  it("零样本 → null（无信息不占版面）", () => {
    expect(formatRecordLine("该钱包", rec(0, 0, 0.5))).toBeNull();
  });

  it("样本不足（<5）→ 只报原始战绩并如实标注", () => {
    const line = formatRecordLine("该钱包", rec(3, 2, 0.5))!;
    expect(line).toContain("2/3");
    expect(line).toContain("样本不足");
    expect(line).not.toContain("超额");
  });

  it("样本充足 → 命中数、市场同价位预期、超额、噪音判定 四件同框", () => {
    const line = formatRecordLine("该钱包", rec(18, 12, 0.5))!;
    expect(line).toBe(
      "📐 该钱包 30d 信号:12/18 中 · 市场同价位预期 9.0 中 · 超额 +3.0（仍在运气范围内）",
    );
    // 频道读者不该需要统计学背景——术语只留在 glossary 里解释。
    expect(line).not.toContain("Wilson");
  });

  it("超额永不脱离噪音判定单独出现（防被截图当结论）", () => {
    for (const r of [rec(18, 12, 0.5), rec(40, 30, 0.5), rec(20, 6, 0.5)]) {
      const line = formatRecordLine("该钱包", r)!;
      expect(line).toContain("超额");
      expect(line).toMatch(/（(已超运气范围|仍在运气范围内)）/);
    }
  });

  it("超过 2σ 才敢说已超运气范围", () => {
    // 40 笔 @0.5：sd≈3.16，2σ≈6.3。30 胜 → 超额 +10，越线。
    expect(formatRecordLine("该钱包", rec(40, 30, 0.5))!).toContain(
      "已超运气范围",
    );
    // 同样 40 笔，24 胜 → 超额 +4，未越线。
    expect(formatRecordLine("该钱包", rec(40, 24, 0.5))!).toContain(
      "仍在运气范围内",
    );
  });

  it("跑输市场时超额为负，不会被包装成正面数字", () => {
    // 旧文案的病灶：20 笔 @0.9 只中 16（比市场预期少 2 次）会印「至少 58%」。
    const line = formatRecordLine("该钱包", rec(20, 16, 0.9))!;
    expect(line).toContain("超额 −2.0");
    expect(line).not.toMatch(/至少/);
  });
});
