import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import { recordStrategySignal } from "./strategySignals";
import {
  computeDigestChain,
  DIGEST_PREV_KEY,
  maybeDailySignalDigest,
} from "./signalDigest";

// 对外信号批次 3:每日存证 digest。把「昨日全部已发布信号」做成链式 sha256
// 摘要发到公开频道 —— TG 频道消息带官方时间戳且不可编辑历史,第三方可复算
// 验证「信号是事前发布的,没删帖没改单」。零成本 timestamping。

const DAY2 = 200 * 86_400; // UTC day boundary(第 200 天 00:00)
const YESTERDAY_NOON = DAY2 - 43_200;

const idOf = (db: ReturnType<typeof openDb>, name: string): number =>
  (
    db.prepare("SELECT id FROM follow_strategies WHERE name = ?").get(name) as {
      id: number;
    }
  ).id;

const seedDelivered = (
  db: ReturnType<typeof openDb>,
  o: { cid: string; emittedAt: number; delivered?: boolean },
): number => {
  const sid = idOf(db, "巨鲸");
  const id = recordStrategySignal(db, {
    strategyId: sid,
    positionId: null,
    conditionId: o.cid,
    outcome: "Yes",
    outcomeIndex: 0,
    asset: "tok",
    title: "T",
    slug: "s",
    eventSlug: "e",
    formationTs: o.emittedAt - 60,
    referencePrice: 0.6,
    walletCount: 1,
    totalNetUsd: 52_000,
    entryPrice: 0.63,
    sizeUsd: 500,
    emittedAt: o.emittedAt,
  });
  if (id == null) throw new Error("seed 冲突");
  if (o.delivered !== false) {
    db.prepare(
      "INSERT INTO signal_deliveries (signal_id, event, channel, delivered_at, status) VALUES (?, 'entry', 'tg_paid', ?, 'sent')",
    ).run(id, o.emittedAt + 5);
  }
  return id;
};

describe("computeDigestChain", () => {
  it("确定性:同 prev 同行序 → 同摘要;prev 变则全变(链式)", () => {
    const rows = [
      {
        id: 1,
        strategyName: "巨鲸",
        conditionId: "c1",
        outcome: "Yes",
        emittedAt: 100,
        entryPrice: 0.63,
      },
      {
        id: 2,
        strategyName: "巨鲸",
        conditionId: "c2",
        outcome: "No",
        emittedAt: 200,
        entryPrice: 0.4,
      },
    ];
    const a = computeDigestChain("genesis", rows);
    const b = computeDigestChain("genesis", rows);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(computeDigestChain("other-prev", rows)).not.toBe(a);
    expect(computeDigestChain("genesis", rows.slice(0, 1))).not.toBe(a);
  });
});

describe("maybeDailySignalDigest", () => {
  it("昨日有已发布信号 → 推一条含摘要前缀的消息,day-gate 当日只跑一次,prev 滚动", async () => {
    const db = openDb(":memory:");
    seedDelivered(db, { cid: "c1", emittedAt: YESTERDAY_NOON });
    seedDelivered(db, { cid: "c2", emittedAt: YESTERDAY_NOON + 60 });
    // 未投递的不进链。
    seedDelivered(db, {
      cid: "c3",
      emittedAt: YESTERDAY_NOON + 120,
      delivered: false,
    });
    const sent: string[] = [];
    const send = vi.fn(async (html: string) => {
      sent.push(html);
    });
    const r1 = await maybeDailySignalDigest(db, send, DAY2 + 100);
    expect(r1?.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("信号存证");
    expect(sent[0]).toContain("2 条");
    const prev = (
      db
        .prepare("SELECT value FROM config WHERE key = ?")
        .get(DIGEST_PREV_KEY) as { value: string } | undefined
    )?.value;
    expect(prev).toMatch(/^[0-9a-f]{64}$/);
    expect(sent[0]).toContain(prev!.slice(0, 16));
    // 同日第二次:no-op。
    const r2 = await maybeDailySignalDigest(db, send, DAY2 + 200);
    expect(r2).toBeNull();
    expect(sent).toHaveLength(1);
    db.close();
  });

  it("昨日无已发布信号 → 不发消息但消耗当日(昨日是已封闭事实)", async () => {
    const db = openDb(":memory:");
    const send = vi.fn(async () => {});
    const r = await maybeDailySignalDigest(db, send, DAY2 + 100);
    expect(r).toBeNull();
    expect(send).not.toHaveBeenCalled();
    const again = await maybeDailySignalDigest(db, send, DAY2 + 200);
    expect(again).toBeNull();
    db.close();
  });

  it("无 send(公开频道未配置)→ 完全 no-op 且不消耗当日", async () => {
    const db = openDb(":memory:");
    seedDelivered(db, { cid: "c1", emittedAt: YESTERDAY_NOON });
    const r = await maybeDailySignalDigest(db, undefined, DAY2 + 100);
    expect(r).toBeNull();
    // 配好凭证后当日仍可补发。
    const sent: string[] = [];
    const r2 = await maybeDailySignalDigest(
      db,
      async (h) => {
        sent.push(h);
      },
      DAY2 + 200,
    );
    expect(r2?.sent).toBe(true);
    db.close();
  });
});
