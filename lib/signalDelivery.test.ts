import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import { parseConfig } from "./config";
import {
  CONDITIONAL_LOOPS,
  evaluateHealth,
  LOOP_STALE_AFTER_SEC,
} from "./health";
import {
  ENTRY_MAX_AGE_SEC,
  runDeliveryCycle,
  type DeliveryChannel,
} from "./signalDelivery";
import { recordStrategySignal } from "./strategySignals";
import { TelegramPermanentError } from "./telegram";

// 对外信号批次 1:投递循环。claim-then-send(signal_deliveries 主键即幂等锁)、
// 延迟闸门(免费通道晚 N 分钟)、新鲜度(不推旧信号)、健康冻结(引擎停跳时
// 宁静默)、多档合并(同市场方向一条消息)、每轮上限(顺延不折叠)。

const NOW = 100_000;

/** 找种子档位 id(openDb 种子已含 13 档,按名取用避免硬编码 id)。 */
const idOf = (db: ReturnType<typeof openDb>, name: string): number =>
  (
    db.prepare("SELECT id FROM follow_strategies WHERE name = ?").get(name) as {
      id: number;
    }
  ).id;

const enablePush = (db: ReturnType<typeof openDb>, name: string): number => {
  const id = idOf(db, name);
  db.prepare("UPDATE follow_strategies SET push_enabled = 1 WHERE id = ?").run(
    id,
  );
  return id;
};

const seedSignal = (
  db: ReturnType<typeof openDb>,
  o: {
    strategyId: number;
    cid?: string;
    outcome?: string;
    emittedAt?: number;
    positionId?: number;
  },
): number => {
  const id = recordStrategySignal(db, {
    strategyId: o.strategyId,
    positionId: o.positionId ?? null,
    conditionId: o.cid ?? "c1",
    outcome: o.outcome ?? "Yes",
    outcomeIndex: 0,
    asset: "tok",
    title: "T",
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
  if (id == null) throw new Error("seedSignal: UNIQUE 命中(用例数据冲突)");
  return id;
};

const makeChannel = (
  key: string,
  minEmitAgeSec: number,
): DeliveryChannel & { sent: string[]; sendMock: ReturnType<typeof vi.fn> } => {
  const sent: string[] = [];
  const sendMock = vi.fn(async (html: string) => {
    sent.push(html);
  });
  return { key, minEmitAgeSec, send: sendMock, sent, sendMock };
};

const deliveries = (db: ReturnType<typeof openDb>) =>
  db
    .prepare(
      "SELECT signal_id, event, channel, status FROM signal_deliveries ORDER BY signal_id, event, channel",
    )
    .all() as {
    signal_id: number;
    event: string;
    channel: string;
    status: string;
  }[];

describe("runDeliveryCycle — entry 投递", () => {
  it("push_enabled 档的信号发送一次并落 sent 行;第二轮不重发", async () => {
    const db = openDb(":memory:");
    const sid = enablePush(db, "巨鲸");
    seedSignal(db, { strategyId: sid });
    const ch = makeChannel("tg_paid", 0);
    const r1 = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + 10,
      sleep: async () => {},
    });
    expect(r1.sent).toBe(1);
    expect(ch.sent[0]).toContain("巨鲸");
    const rows = deliveries(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
    const r2 = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + 40,
      sleep: async () => {},
    });
    expect(r2.sent).toBe(0);
    expect(ch.sent).toHaveLength(1);
    db.close();
  });

  it("push_enabled=0 的档不投递也不 claim", async () => {
    const db = openDb(":memory:");
    // 不 enablePush —— 种子默认 0。
    seedSignal(db, { strategyId: idOf(db, "巨鲸") });
    const ch = makeChannel("tg_paid", 0);
    const r = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + 10,
      sleep: async () => {},
    });
    expect(r.sent).toBe(0);
    expect(deliveries(db)).toHaveLength(0);
    db.close();
  });

  it("延迟闸门:未到点不发不写行(下轮再看),到点即发", async () => {
    const db = openDb(":memory:");
    const sid = enablePush(db, "巨鲸");
    seedSignal(db, { strategyId: sid, emittedAt: NOW });
    const ch = makeChannel("tg_public", 1800);
    const early = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + 100,
      sleep: async () => {},
    });
    expect(early.sent).toBe(0);
    expect(deliveries(db)).toHaveLength(0);
    const due = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + 1801,
      sleep: async () => {},
    });
    expect(due.sent).toBe(1);
    db.close();
  });

  it("新鲜度:超过 minEmitAge+6h 的旧信号落 skipped_stale,绝不推送", async () => {
    const db = openDb(":memory:");
    const sid = enablePush(db, "巨鲸");
    seedSignal(db, { strategyId: sid, emittedAt: NOW });
    const ch = makeChannel("tg_paid", 0);
    const r = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + ENTRY_MAX_AGE_SEC + 1,
      sleep: async () => {},
    });
    expect(r.sent).toBe(0);
    expect(r.skippedStale).toBe(1);
    const rows = deliveries(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("skipped_stale");
    // 已 claim 为 stale → 下轮不再扫到。
    const r2 = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + ENTRY_MAX_AGE_SEC + 100,
      sleep: async () => {},
    });
    expect(r2.skippedStale).toBe(0);
    db.close();
  });

  it("同市场同方向多档合并为一条消息,各档 delivery 行均记 sent", async () => {
    const db = openDb(":memory:");
    const a = enablePush(db, "巨鲸");
    const b = enablePush(db, "精英共识");
    seedSignal(db, { strategyId: a, cid: "cx" });
    seedSignal(db, { strategyId: b, cid: "cx" });
    const ch = makeChannel("tg_paid", 0);
    const r = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + 10,
      sleep: async () => {},
    });
    expect(r.sent).toBe(1);
    expect(ch.sent[0]).toContain("巨鲸");
    expect(ch.sent[0]).toContain("精英共识");
    expect(deliveries(db).filter((d) => d.status === "sent")).toHaveLength(2);
    db.close();
  });

  it("transient 失败回滚 claim,下轮重发成功(至少一次语义)", async () => {
    const db = openDb(":memory:");
    const sid = enablePush(db, "巨鲸");
    seedSignal(db, { strategyId: sid });
    const ch = makeChannel("tg_paid", 0);
    ch.sendMock.mockRejectedValueOnce(new Error("socket hang up"));
    const r1 = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + 10,
      sleep: async () => {},
    });
    expect(r1.sent).toBe(0);
    expect(deliveries(db)).toHaveLength(0);
    const r2 = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + 40,
      sleep: async () => {},
    });
    expect(r2.sent).toBe(1);
    db.close();
  });

  it("permanent 失败保留 claim 标 failed_permanent,下轮不再尝试(毒消息不卡队)", async () => {
    const db = openDb(":memory:");
    const sid = enablePush(db, "巨鲸");
    seedSignal(db, { strategyId: sid });
    const ch = makeChannel("tg_paid", 0);
    ch.sendMock.mockRejectedValueOnce(new TelegramPermanentError("400 bad"));
    const r1 = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + 10,
      sleep: async () => {},
    });
    expect(r1.failedPermanent).toBe(1);
    expect(deliveries(db)[0].status).toBe("failed_permanent");
    const r2 = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + 40,
      sleep: async () => {},
    });
    expect(ch.sendMock).toHaveBeenCalledTimes(1);
    expect(r2.sent).toBe(0);
    db.close();
  });

  it("每轮上限:超额顺延下轮,不折叠不丢失", async () => {
    const db = openDb(":memory:");
    const sid = enablePush(db, "巨鲸");
    seedSignal(db, { strategyId: sid, cid: "c1" });
    seedSignal(db, { strategyId: sid, cid: "c2" });
    seedSignal(db, { strategyId: sid, cid: "c3" });
    const ch = makeChannel("tg_paid", 0);
    const r1 = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + 10,
      maxSendsPerCycle: 2,
      sleep: async () => {},
    });
    expect(r1.sent).toBe(2);
    const r2 = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + 40,
      maxSendsPerCycle: 2,
      sleep: async () => {},
    });
    expect(r2.sent).toBe(1);
    db.close();
  });

  it("健康冻结:checkHealth 不 ok → 本轮零动作(宁静默不误导)", async () => {
    const db = openDb(":memory:");
    const sid = enablePush(db, "巨鲸");
    seedSignal(db, { strategyId: sid });
    const ch = makeChannel("tg_paid", 0);
    const r = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + 10,
      checkHealth: () => ({ ok: false }),
      sleep: async () => {},
    });
    expect(r.sent).toBe(0);
    expect(deliveries(db)).toHaveLength(0);
    db.close();
  });

  it("通道隔离:tg_paid 已发不影响 tg_public 到点后自己发", async () => {
    const db = openDb(":memory:");
    const sid = enablePush(db, "巨鲸");
    seedSignal(db, { strategyId: sid, emittedAt: NOW });
    const paid = makeChannel("tg_paid", 0);
    const pub = makeChannel("tg_public", 1800);
    await runDeliveryCycle({
      db,
      channels: [paid, pub],
      nowSec: NOW + 10,
      sleep: async () => {},
    });
    expect(paid.sent).toHaveLength(1);
    expect(pub.sent).toHaveLength(0);
    await runDeliveryCycle({
      db,
      channels: [paid, pub],
      nowSec: NOW + 1900,
      sleep: async () => {},
    });
    expect(paid.sent).toHaveLength(1);
    expect(pub.sent).toHaveLength(1);
    db.close();
  });
});

describe("runDeliveryCycle — settle 认账", () => {
  const settle = (
    db: ReturnType<typeof openDb>,
    signalId: number,
    ts: number,
  ) =>
    db
      .prepare(
        "UPDATE strategy_signals SET settled=1, settled_ts=?, exit_price=1, won=1, realized_pnl=293.7 WHERE id=?",
      )
      .run(ts, signalId);

  it("entry 已 sent 且结算后推认账;结算价与盈亏在消息里", async () => {
    const db = openDb(":memory:");
    const sid = enablePush(db, "巨鲸");
    const sigId = seedSignal(db, { strategyId: sid });
    const ch = makeChannel("tg_paid", 0);
    await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + 10,
      sleep: async () => {},
    });
    settle(db, sigId, NOW + 100);
    const r = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + 130,
      sleep: async () => {},
    });
    expect(r.sent).toBe(1);
    expect(ch.sent[1]).toContain("结算");
    expect(ch.sent[1]).toContain("100¢");
    expect(ch.sent[1]).toContain("+$294");
    db.close();
  });

  it("entry 被 skipped_stale 的信号绝不推认账(没发布过开仓就没有认账义务)", async () => {
    const db = openDb(":memory:");
    const sid = enablePush(db, "巨鲸");
    const sigId = seedSignal(db, { strategyId: sid, emittedAt: NOW });
    const ch = makeChannel("tg_paid", 0);
    // 第一轮就已超新鲜度 → entry 落 skipped_stale。
    await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + ENTRY_MAX_AGE_SEC + 1,
      sleep: async () => {},
    });
    settle(db, sigId, NOW + ENTRY_MAX_AGE_SEC + 100);
    const r = await runDeliveryCycle({
      db,
      channels: [ch],
      nowSec: NOW + ENTRY_MAX_AGE_SEC + 130,
      sleep: async () => {},
    });
    expect(r.sent).toBe(0);
    expect(ch.sent).toHaveLength(0);
    db.close();
  });
});

describe("config — 对外信号新字段", () => {
  it("TELEGRAM_SIGNAL_CHANNEL_ID 默认空;SIGNAL_PUBLIC_DELAY_MIN 默认 30、可覆盖、坏值回默认", () => {
    const base = parseConfig({});
    expect(base.telegramSignalChannelId).toBe("");
    expect(base.signalPublicDelayMin).toBe(30);
    expect(
      parseConfig({ SIGNAL_PUBLIC_DELAY_MIN: "15" }).signalPublicDelayMin,
    ).toBe(15);
    expect(
      parseConfig({ SIGNAL_PUBLIC_DELAY_MIN: "abc" }).signalPublicDelayMin,
    ).toBe(30);
    expect(
      parseConfig({ SIGNAL_PUBLIC_DELAY_MIN: "-5" }).signalPublicDelayMin,
    ).toBe(30);
    expect(
      parseConfig({ TELEGRAM_SIGNAL_CHANNEL_ID: "@vip" })
        .telegramSignalChannelId,
    ).toBe("@vip");
  });
});

describe("health — delivery 条件循环", () => {
  it("delivery 在阈值表里但从未 beat 不算 stale(records-only 部署没有它)", () => {
    expect(LOOP_STALE_AFTER_SEC.delivery).toBeGreaterThan(0);
    expect(CONDITIONAL_LOOPS.has("delivery")).toBe(true);
    const report = evaluateHealth(
      [{ loop: "alert", lastTs: 1000, day: "d", cycles: 1, maxGapSec: 0 }],
      1010,
      0, // 引擎已启动很久
    );
    expect(report.staleLoops).not.toContain("delivery");
  });

  it("delivery 一旦 beat 过,停跳超阈值照常算 stale", () => {
    const report = evaluateHealth(
      [
        { loop: "alert", lastTs: 10_000, day: "d", cycles: 1, maxGapSec: 0 },
        {
          loop: "delivery",
          lastTs: 10_000 - LOOP_STALE_AFTER_SEC.delivery - 1,
          day: "d",
          cycles: 1,
          maxGapSec: 0,
        },
      ],
      10_000,
      0,
    );
    expect(report.staleLoops).toContain("delivery");
  });
});
