import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import {
  formatRecordLine,
  typeSignalRecord,
  walletSignalRecord,
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
  } = {},
): void {
  const {
    type = "large",
    wallet = "0xAAA",
    createdAt = NOW - DAY,
    won = 1,
    resolved = 1,
  } = over;
  const r = db
    .prepare(
      "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(type, `k${seq++}`, JSON.stringify({ proxyWallet: wallet }), createdAt);
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
    expect(r.wilsonLo).toBeGreaterThan(0);
    expect(r.wilsonLo).toBeLessThan(2 / 3);
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
});

describe("formatRecordLine", () => {
  it("零样本 → null（无信息不占版面）", () => {
    expect(
      formatRecordLine("该钱包", { settled: 0, wins: 0, wilsonLo: 0 }),
    ).toBeNull();
  });
  it("样本不足（<5）→ 如实标注，不给 Wilson", () => {
    const line = formatRecordLine("该钱包", {
      settled: 3,
      wins: 2,
      wilsonLo: 0.2,
    });
    expect(line).toContain("2/3");
    expect(line).toContain("样本不足");
    expect(line).not.toContain("下界");
  });
  it("样本充足 → 命中 + 自解释的保守估计（不出现统计学术语）", () => {
    const line = formatRecordLine("该钱包", {
      settled: 18,
      wins: 12,
      wilsonLo: 0.44,
    });
    expect(line).toBe("📐 该钱包 30d 信号:12/18 中 · 剔除运气后至少 44%");
    // 频道读者不该需要统计学背景——术语只留在 glossary 里解释。
    expect(line).not.toContain("Wilson");
  });
});
