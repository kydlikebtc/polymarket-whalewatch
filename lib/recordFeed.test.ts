import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { recordStrategySignal } from "./strategySignals";
import { buildRecordFeed } from "./recordFeed";
import { DIGEST_DAY_KEY, DIGEST_PREV_KEY } from "./signalDigest";

// 对外信号批次 3:/record 公开战绩页的数据层。
// 口径:只统计**已发布**(存在 sent entry 投递)的信号 —— 这页的主张是
// 「我们公开发出的信号事后如何」,未发布的纸面仓不进这本账(它们在 /follow)。

const NOW = 1_000_000;

const idOf = (db: ReturnType<typeof openDb>, name: string): number =>
  (
    db.prepare("SELECT id FROM follow_strategies WHERE name = ?").get(name) as {
      id: number;
    }
  ).id;

const seed = (
  db: ReturnType<typeof openDb>,
  o: {
    strategy: string;
    cid: string;
    emittedAt?: number;
    delivered?: boolean;
    settled?: { ts: number; exit: number; pnl: number };
  },
) => {
  const sid = idOf(db, o.strategy);
  const id = recordStrategySignal(db, {
    strategyId: sid,
    positionId: null,
    conditionId: o.cid,
    outcome: "Yes",
    outcomeIndex: 0,
    asset: "tok",
    title: `T-${o.cid}`,
    slug: "s",
    eventSlug: "e",
    formationTs: (o.emittedAt ?? NOW) - 60,
    referencePrice: 0.6,
    walletCount: 1,
    totalNetUsd: 52_000,
    entryPrice: 0.63,
    sizeUsd: 500,
    emittedAt: o.emittedAt ?? NOW,
  });
  if (id == null) throw new Error("seed 冲突");
  if (o.delivered !== false) {
    db.prepare(
      "INSERT INTO signal_deliveries (signal_id, event, channel, delivered_at, status) VALUES (?, 'entry', 'tg_paid', ?, 'sent')",
    ).run(id, (o.emittedAt ?? NOW) + 5);
  }
  if (o.settled) {
    db.prepare(
      "UPDATE strategy_signals SET settled=1, settled_ts=?, exit_price=?, won=?, realized_pnl=? WHERE id=?",
    ).run(
      o.settled.ts,
      o.settled.exit,
      o.settled.pnl > 0 ? 1 : o.settled.pnl < 0 ? 0 : null,
      o.settled.pnl,
      id,
    );
  }
  return id;
};

describe("buildRecordFeed", () => {
  it("只统计已发布信号;record 走 gradeRows(implied=入场价);未投递的不进账", () => {
    const db = openDb(":memory:");
    seed(db, {
      strategy: "巨鲸",
      cid: "w1",
      emittedAt: NOW - 86_400,
      settled: { ts: NOW - 3600, exit: 1, pnl: 293.7 },
    });
    seed(db, {
      strategy: "巨鲸",
      cid: "w2",
      emittedAt: NOW - 86_400,
      settled: { ts: NOW - 3600, exit: 0, pnl: -500 },
    });
    // 未投递:settled 也不进公开账。
    seed(db, {
      strategy: "巨鲸",
      cid: "w3",
      emittedAt: NOW - 86_400,
      delivered: false,
      settled: { ts: NOW - 3600, exit: 1, pnl: 100 },
    });
    // 未结算:计入 pushedCount,不进 record 分母。
    seed(db, { strategy: "巨鲸", cid: "w4", emittedAt: NOW - 3600 });
    const feed = buildRecordFeed(db, { nowSec: NOW });
    expect(feed.strategies).toHaveLength(1);
    const s = feed.strategies[0];
    expect(s.name).toBe("巨鲸");
    expect(s.source).toBe("heavy");
    expect(s.pushedCount).toBe(3);
    expect(s.record.settled).toBe(2);
    expect(s.record.wins).toBe(1);
    expect(s.record.implied).toBeCloseTo(1.26, 6);
    // 纸面盈亏只加 record 分母里的那两行:w3 未投递、w4 未结算都不进。
    expect(s.realizedPnl).toBeCloseTo(293.7 - 500, 6);
    db.close();
  });

  it("纸面盈亏与 record 咬同一批行:无入场价的行不可评级,也不进合计", () => {
    const db = openDb(":memory:");
    seed(db, {
      strategy: "巨鲸",
      cid: "w1",
      emittedAt: NOW - 86_400,
      settled: { ts: NOW - 3600, exit: 1, pnl: 100 },
    });
    const noPrice = seed(db, {
      strategy: "巨鲸",
      cid: "w2",
      emittedAt: NOW - 86_400,
      settled: { ts: NOW - 3600, exit: 1, pnl: 900 },
    });
    db.prepare(
      "UPDATE strategy_signals SET entry_price = NULL WHERE id = ?",
    ).run(noPrice);
    const s = buildRecordFeed(db, { nowSec: NOW }).strategies[0];
    expect(s.record.settled).toBe(1);
    expect(s.realizedPnl).toBe(100);
    db.close();
  });

  it("任一可评级行缺 realized_pnl → 合计给 null(缺一行的和是错的和,不是部分的和)", () => {
    const db = openDb(":memory:");
    seed(db, {
      strategy: "巨鲸",
      cid: "w1",
      emittedAt: NOW - 86_400,
      settled: { ts: NOW - 3600, exit: 1, pnl: 100 },
    });
    const blank = seed(db, {
      strategy: "巨鲸",
      cid: "w2",
      emittedAt: NOW - 86_400,
      settled: { ts: NOW - 3600, exit: 1, pnl: 50 },
    });
    db.prepare(
      "UPDATE strategy_signals SET realized_pnl = NULL WHERE id = ?",
    ).run(blank);
    expect(
      buildRecordFeed(db, { nowSec: NOW }).strategies[0].realizedPnl,
    ).toBeNull();
    db.close();
  });

  it("尚无可评级行 → 合计给 null,不是 0(「—」是判不了)", () => {
    const db = openDb(":memory:");
    seed(db, { strategy: "巨鲸", cid: "w1" });
    const s = buildRecordFeed(db, { nowSec: NOW }).strategies[0];
    expect(s.record.settled).toBe(0);
    expect(s.realizedPnl).toBeNull();
    db.close();
  });

  it("push_enabled 已关但有历史发布的档仍在账上(历史不可抹)", () => {
    const db = openDb(":memory:");
    seed(db, {
      strategy: "巨鲸",
      cid: "w1",
      emittedAt: NOW - 86_400,
      settled: { ts: NOW - 3600, exit: 1, pnl: 100 },
    });
    // 种子默认 push_enabled=0,恰好就是「已关」状态。
    const feed = buildRecordFeed(db, { nowSec: NOW });
    expect(feed.strategies).toHaveLength(1);
    db.close();
  });

  it("settledRecent:新在前、封顶 10 条、带结算细节", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 12; i++) {
      seed(db, {
        strategy: "巨鲸",
        cid: `c${i}`,
        emittedAt: NOW - 86_400,
        settled: { ts: NOW - 10_000 + i * 100, exit: 1, pnl: 10 },
      });
    }
    const feed = buildRecordFeed(db, { nowSec: NOW });
    const s = feed.strategies[0];
    expect(s.settledRecent).toHaveLength(10);
    expect(s.settledRecent[0].conditionId).toBe("c11");
    expect(s.settledRecent[0].won).toBe(true);
    db.close();
  });

  it("digest 状态透出(config 两键);无链时为 null", () => {
    const db = openDb(":memory:");
    expect(buildRecordFeed(db, { nowSec: NOW }).digest).toEqual({
      day: null,
      tail: null,
    });
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      DIGEST_DAY_KEY,
      "2026-08-14",
    );
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      DIGEST_PREV_KEY,
      "ab".repeat(32),
    );
    const d = buildRecordFeed(db, { nowSec: NOW }).digest;
    expect(d.day).toBe("2026-08-14");
    expect(d.tail).toBe("ab".repeat(32));
    db.close();
  });

  it("每档带 code —— 公开战绩页是第三方对账入口,不能只给部署本地的 id", () => {
    const db = openDb(":memory:");
    seed(db, { strategy: "超级巨鲸", cid: "c1" });
    const s = buildRecordFeed(db, { nowSec: NOW }).strategies;
    expect(s.map((x) => [x.name, x.code])).toEqual([
      ["超级巨鲸", "mega_whale"],
    ]);
    db.close();
  });
});
