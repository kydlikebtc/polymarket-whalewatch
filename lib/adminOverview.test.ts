import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import { recordStrategySignal } from "./strategySignals";
import { DIGEST_DAY_KEY, DIGEST_PREV_KEY } from "./signalDigest";
import {
  buildAdminSignalOverview,
  buildBusLedger,
  setStrategyPush,
} from "./adminOverview";

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
  it("列出全部档位(含未放开),带 pushEnabled/source/信号计数/投递计数", () => {
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
    // 档位总数随种子版本演进(v3=13 档、v4=19 档含反向对照)—— 断言「与库内
    // 实际条数一致」而非钉死数字,否则每次扩档都要来改这行。
    const seeded = (
      db.prepare("SELECT COUNT(*) AS n FROM follow_strategies").get() as {
        n: number;
      }
    ).n;
    expect(o.strategies).toHaveLength(seeded);
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

  it("ops 摘要:engineStartedAt/signalsLast24h/activeKeys(顶部状态条数据源)", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "engine_started_at",
      String(NOW - 3600),
    );
    seed(db, { strategy: "巨鲸", cid: "c1", emittedAt: NOW - 100 });
    seed(db, { strategy: "巨鲸", cid: "c2", emittedAt: NOW - 2 * 86_400 });
    db.prepare(
      "INSERT INTO api_keys (key_hash, label, tier, created_at) VALUES ('h1','a','delayed',1)",
    ).run();
    db.prepare(
      "INSERT INTO api_keys (key_hash, label, tier, created_at, revoked_at) VALUES ('h2','b','delayed',1,2)",
    ).run();
    const o = buildAdminSignalOverview(db, { nowSec: NOW });
    expect(o.ops.engineStartedAt).toBe(NOW - 3600);
    expect(o.ops.signalsLast24h).toBe(1);
    expect(o.ops.activeKeys).toBe(1);
    db.close();
  });

  it("通道积压:与投递循环同口径 —— 到点未投计入,未到点/已过期/已投递不计", () => {
    const db = openDb(":memory:");
    const sid = idOf(db, "巨鲸");
    setStrategyPush(db, sid, true);
    // ① 到点未投:积压。
    seed(db, { strategy: "巨鲸", cid: "due", emittedAt: NOW - 100 });
    // ② 已投:不计。
    seed(db, {
      strategy: "巨鲸",
      cid: "sent",
      emittedAt: NOW - 200,
      channels: [{ channel: "tg_paid", status: "sent" }],
    });
    // ③ 超过新鲜度上限(6h):不计(投递循环会标 skipped_stale,不是积压)。
    seed(db, { strategy: "巨鲸", cid: "stale", emittedAt: NOW - 7 * 3600 });
    const o = buildAdminSignalOverview(db, {
      nowSec: NOW,
      channels: [
        { key: "tg_paid", minEmitAgeSec: 0 },
        // 延迟通道:三条 emitted 都晚于 now-1800 之外只有 stale 一条,而它
        // 对延迟通道同样超过 minEmitAge+6h → 积压 0。
        { key: "tg_public", minEmitAgeSec: 1800 },
      ],
    });
    const paid = o.ops.channels.find((c) => c.key === "tg_paid")!;
    expect(paid.pendingEntries).toBe(1);
    const pub = o.ops.channels.find((c) => c.key === "tg_public")!;
    expect(pub.pendingEntries).toBe(0);
    // 未传通道 = 未配置部署:不臆造条目。
    const none = buildAdminSignalOverview(db, { nowSec: NOW });
    expect(none.ops.channels).toEqual([]);
    db.close();
  });
});

describe("buildBusLedger —— 总线台账的运营视图", () => {
  const NOW = 1_790_000_000;
  function seedBus(
    db: DB,
    over: Partial<{ sourceType: string; payload: unknown; emittedAt: number }> = {},
  ): number {
    const r = db
      .prepare(
        "INSERT INTO bus_signals (source_type, dedup_key, condition_id, title, payload, emitted_at) VALUES (?, ?, '0xabc', 'Market A', ?, ?)",
      )
      .run(
        over.sourceType ?? "large",
        `k${Math.random()}`,
        JSON.stringify(over.payload ?? { usd: 120000, side: "BUY", price: 0.4 }),
        over.emittedAt ?? NOW,
      );
    return Number(r.lastInsertRowid);
  }

  it("三类摘要各按类型取最有信息量的字段", () => {
    const db = openDb(":memory:");
    seedBus(db, { sourceType: "large", payload: { usd: 120000, side: "BUY", price: 0.4 }, emittedAt: NOW - 3 });
    seedBus(db, { sourceType: "consensus", payload: { walletCount: 3, totalNetUsd: 92000, outcome: "Yes" }, emittedAt: NOW - 2 });
    seedBus(db, { sourceType: "discovery", payload: { address: "0x1234567890abcdef1234567890abcdef12345678", score: 87 }, emittedAt: NOW - 1 });
    const rows = buildBusLedger(db);
    expect(rows.map((r) => r.summary)).toEqual([
      "0x1234…5678 · score 87",
      "3 钱包 · $92,000 · Yes",
      "$120,000 BUY @0.4",
    ]);
  });

  it("带上逐通道投递状态(bus_deliveries)", () => {
    const db = openDb(":memory:");
    const id = seedBus(db);
    db.prepare(
      "INSERT INTO bus_deliveries (bus_signal_id, channel, status, created_at) VALUES (?, 'webhook:1', 'sent', ?), (?, 'webhook:2', 'failed_permanent', ?)",
    ).run(id, NOW, id, NOW);
    const [row] = buildBusLedger(db);
    expect(row.channels).toEqual([
      { channel: "webhook:1", status: "sent" },
      { channel: "webhook:2", status: "failed_permanent" },
    ]);
  });

  it("坏载荷降级为空摘要,行不丢", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO bus_signals (source_type, dedup_key, condition_id, title, payload, emitted_at) VALUES ('large', 'k', NULL, NULL, 'not json', ?)",
    ).run(NOW);
    const [row] = buildBusLedger(db);
    expect(row.summary).toBe("");
    expect(row.channels).toEqual([]);
  });

  it("新在前,限 20 条", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 25; i++) seedBus(db, { emittedAt: NOW - 100 + i });
    const rows = buildBusLedger(db);
    expect(rows).toHaveLength(20);
    expect(rows[0].emittedAt).toBe(NOW - 100 + 24);
  });
});
