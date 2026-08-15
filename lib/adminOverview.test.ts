import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { recordStrategySignal } from "./strategySignals";
import { DIGEST_DAY_KEY, DIGEST_PREV_KEY } from "./signalDigest";
import { buildAdminSignalOverview, setStrategyPush } from "./adminOverview";

// /manage 运营页的数据层:全部 13 档的推送开关态 + 台账/投递摘要 + 运维状态。
// 与 /record(公开,只含已发布)不同,这里是运营者视角:未放开的档也要看到,
// 才能决定「放开哪几档」。

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
    channels?: { channel: string; status: string }[];
    settled?: { ts: number; pnl: number };
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
  for (const c of o.channels ?? []) {
    db.prepare(
      "INSERT INTO signal_deliveries (signal_id, event, channel, delivered_at, status) VALUES (?, 'entry', ?, ?, ?)",
    ).run(id, c.channel, (o.emittedAt ?? NOW) + 5, c.status);
  }
  if (o.settled) {
    db.prepare(
      "UPDATE strategy_signals SET settled=1, settled_ts=?, exit_price=1, won=?, realized_pnl=? WHERE id=?",
    ).run(o.settled.ts, o.settled.pnl > 0 ? 1 : 0, o.settled.pnl, id);
  }
  return id;
};

describe("setStrategyPush", () => {
  it("开/关落库并返回 true;未知 id 返回 false", () => {
    const db = openDb(":memory:");
    const id = idOf(db, "巨鲸");
    expect(setStrategyPush(db, id, true)).toBe(true);
    expect(
      (
        db
          .prepare("SELECT push_enabled FROM follow_strategies WHERE id = ?")
          .get(id) as { push_enabled: number }
      ).push_enabled,
    ).toBe(1);
    expect(setStrategyPush(db, id, false)).toBe(true);
    expect(setStrategyPush(db, 9999, true)).toBe(false);
    db.close();
  });
});

describe("buildAdminSignalOverview", () => {
  it("列出全部 13 档(含未放开),带 pushEnabled/source/信号计数/投递计数", () => {
    const db = openDb(":memory:");
    const whaleId = idOf(db, "巨鲸");
    setStrategyPush(db, whaleId, true);
    seed(db, {
      strategy: "巨鲸",
      cid: "c1",
      channels: [
        { channel: "tg_paid", status: "sent" },
        { channel: "tg_public", status: "sent" },
      ],
    });
    seed(db, {
      strategy: "巨鲸",
      cid: "c2",
      emittedAt: NOW - 2 * 86_400, // 24h 窗口之外
      channels: [{ channel: "tg_paid", status: "sent" }],
    });
    seed(db, { strategy: "保守", cid: "c3" });
    const o = buildAdminSignalOverview(db, { nowSec: NOW });
    expect(o.strategies).toHaveLength(13);
    const whale = o.strategies.find((s) => s.name === "巨鲸")!;
    expect(whale.pushEnabled).toBe(true);
    expect(whale.source).toBe("heavy");
    expect(whale.signals.total).toBe(2);
    expect(whale.signals.last24h).toBe(1);
    expect(whale.signals.lastEmittedAt).toBe(NOW);
    expect(whale.deliveries.sentPaid).toBe(2);
    expect(whale.deliveries.sentPublic).toBe(1);
    const conservative = o.strategies.find((s) => s.name === "保守")!;
    expect(conservative.pushEnabled).toBe(false);
    expect(conservative.signals.total).toBe(1);
    expect(conservative.deliveries.sentPaid).toBe(0);
    db.close();
  });

  it("recent:最近信号新在前,带每通道投递状态与结算态", () => {
    const db = openDb(":memory:");
    seed(db, {
      strategy: "巨鲸",
      cid: "old",
      emittedAt: NOW - 5000,
      channels: [{ channel: "tg_paid", status: "skipped_stale" }],
    });
    seed(db, {
      strategy: "精英共识",
      cid: "new",
      emittedAt: NOW - 100,
      channels: [{ channel: "tg_paid", status: "sent" }],
      settled: { ts: NOW - 50, pnl: 100 },
    });
    const o = buildAdminSignalOverview(db, { nowSec: NOW });
    expect(o.recent.map((r) => r.conditionId)).toEqual(["new", "old"]);
    const first = o.recent[0];
    expect(first.strategyName).toBe("精英共识");
    expect(first.settled).toBe(true);
    expect(first.won).toBe(true);
    expect(first.channels).toEqual([{ channel: "tg_paid", status: "sent" }]);
    expect(o.recent[1].channels[0].status).toBe("skipped_stale");
    db.close();
  });

  it("ops:digest/备份日/TG 健康三态透出(空库为 null/默认)", () => {
    const db = openDb(":memory:");
    const empty = buildAdminSignalOverview(db, { nowSec: NOW });
    expect(empty.ops.digest).toEqual({ day: null, tail: null });
    expect(empty.ops.backupDay).toBeNull();
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      DIGEST_DAY_KEY,
      "2026-08-15",
    );
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      DIGEST_PREV_KEY,
      "cd".repeat(32),
    );
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "db_backup_last_day",
      "2026-08-15",
    );
    const o = buildAdminSignalOverview(db, { nowSec: NOW });
    expect(o.ops.digest.day).toBe("2026-08-15");
    expect(o.ops.backupDay).toBe("2026-08-15");
    // 空库无发送记录:consecutiveSendFailures=0 且不 failing。
    expect(o.ops.tg?.failing ?? false).toBe(false);
    db.close();
  });
});
