import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import { recordStrategySignal } from "./strategySignals";
import {
  computeDigestChain,
  DIGEST_POST_UTC_HOUR,
  DIGEST_PREV_KEY,
  listDigestDays,
  maybeDailySignalDigest,
} from "./signalDigest";

// 对外信号批次 3:每日存证 digest。把「昨日全部已发布信号」做成链式 sha256
// 摘要发到公开频道 —— TG 频道消息带官方时间戳且不可编辑历史,第三方可复算
// 验证「信号是事前发布的,没删帖没改单」。零成本 timestamping。

const DAY2 = 200 * 86_400; // UTC day boundary(第 200 天 00:00)
const YESTERDAY_NOON = DAY2 - 43_200;
/** 过了成员集冻结闸(DIGEST_POST_UTC_HOUR)之后的一个时刻。 */
const AFTER_GATE = DIGEST_POST_UTC_HOUR * 3600 + 100;

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

describe("成员集冻结闸(DIGEST_POST_UTC_HOUR)", () => {
  it("闸门取自 ENTRY_MAX_AGE_SEC,不是写死的数字", () => {
    // 6h:过了这个点,昨日 entry 只会 skipped_stale,成员集不可能再变 ——
    // 复算方拿公开导出算出的行集合才等于摘要当时看到的那一批。
    expect(DIGEST_POST_UTC_HOUR).toBe(6);
  });

  it("零点刚过不发,也不消耗当日 —— 是晚发不是不发", async () => {
    const db = openDb(":memory:");
    seedDelivered(db, { cid: "c1", emittedAt: YESTERDAY_NOON });
    const send = vi.fn(async () => {});
    expect(await maybeDailySignalDigest(db, send, DAY2 + 100)).toBeNull();
    expect(send).not.toHaveBeenCalled();
    // 同一天晚些时候(过闸)照常发出。
    const r = await maybeDailySignalDigest(db, send, DAY2 + AFTER_GATE);
    expect(r?.sent).toBe(true);
    db.close();
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
    const r1 = await maybeDailySignalDigest(db, send, DAY2 + AFTER_GATE);
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
    const r2 = await maybeDailySignalDigest(db, send, DAY2 + AFTER_GATE + 100);
    expect(r2).toBeNull();
    expect(sent).toHaveLength(1);
    db.close();
  });

  it("逐日存证行落库:day/prev/count/参数指纹都在,链尾与行一致", async () => {
    const db = openDb(":memory:");
    seedDelivered(db, { cid: "c1", emittedAt: YESTERDAY_NOON });
    const r = await maybeDailySignalDigest(db, async () => {}, DAY2 + AFTER_GATE);
    const days = listDigestDays(db);
    expect(days).toHaveLength(1);
    expect(days[0].day).toBe(new Date((DAY2 - 43_200) * 1000).toISOString().slice(0, 10));
    expect(days[0].count).toBe(1);
    expect(days[0].prev).toBe("genesis");
    expect(days[0].digest).toBe(r?.digest);
    expect(days[0].paramsDigest).toMatch(/^[0-9a-f]{64}$/);
    db.close();
  });

  it("昨日无已发布信号且参数没变 → 不发消息,但仍落存证行并消耗当日", async () => {
    const db = openDb(":memory:");
    const send = vi.fn(async () => {});
    // 第一天:0 信号、参数首次记录 → 不发(paramsChanged 为 null 不算变)。
    const r = await maybeDailySignalDigest(db, send, DAY2 + AFTER_GATE);
    expect(r?.sent).toBe(false);
    expect(r?.count).toBe(0);
    expect(send).not.toHaveBeenCalled();
    // 存证行照落 —— 复算方需要每一天的锚点,包括空的那些。
    expect(listDigestDays(db)).toHaveLength(1);
    const again = await maybeDailySignalDigest(db, send, DAY2 + AFTER_GATE + 100);
    expect(again).toBeNull();
    db.close();
  });

  it("无 send(公开频道未配置)→ 完全 no-op 且不消耗当日", async () => {
    const db = openDb(":memory:");
    seedDelivered(db, { cid: "c1", emittedAt: YESTERDAY_NOON });
    const r = await maybeDailySignalDigest(db, undefined, DAY2 + AFTER_GATE);
    expect(r).toBeNull();
    expect(listDigestDays(db)).toHaveLength(0);
    // 配好凭证后当日仍可补发。
    const sent: string[] = [];
    const r2 = await maybeDailySignalDigest(
      db,
      async (h) => {
        sent.push(h);
      },
      DAY2 + AFTER_GATE + 100,
    );
    expect(r2?.sent).toBe(true);
    db.close();
  });
});

describe("参数指纹(#13)", () => {
  it("规则没动 → 两天同一个指纹(不加链的全部理由)", async () => {
    const db = openDb(":memory:");
    seedDelivered(db, { cid: "c1", emittedAt: YESTERDAY_NOON });
    const d1 = await maybeDailySignalDigest(db, async () => {}, DAY2 + AFTER_GATE);
    seedDelivered(db, { cid: "c2", emittedAt: YESTERDAY_NOON + 86_400 });
    const d2 = await maybeDailySignalDigest(
      db,
      async () => {},
      DAY2 + 86_400 + AFTER_GATE,
    );
    expect(d1?.paramsDigest).toBe(d2?.paramsDigest);
    expect(d1?.paramsChanged).toBeNull(); // 首次记录
    expect(d2?.paramsChanged).toBe(false);
    db.close();
  });

  it("改了投递开关 → 指纹变,且哪怕当天 0 信号也要发消息", async () => {
    const db = openDb(":memory:");
    const sent: string[] = [];
    const send = async (h: string) => {
      sent.push(h);
    };
    await maybeDailySignalDigest(db, send, DAY2 + AFTER_GATE);
    expect(sent).toHaveLength(0); // 第一天:0 信号、参数首记 → 静默
    // 运营者当天把一档放开对外投递 —— 这正是「阈值被悄悄挪过」要防的那类改动。
    db.prepare(
      "UPDATE follow_strategies SET push_enabled = 1 WHERE name = '巨鲸'",
    ).run();
    const d2 = await maybeDailySignalDigest(
      db,
      send,
      DAY2 + 86_400 + AFTER_GATE,
    );
    expect(d2?.paramsChanged).toBe(true);
    // 「今天没信号」可以沉默;「规则改了」不行 —— 沉默掉它等于没做这条。
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("参数指纹");
    expect(sent[0]).toContain("不同");
    db.close();
  });

  it("改了告警阈值(config_history 那套)同样进指纹", async () => {
    const db = openDb(":memory:");
    await maybeDailySignalDigest(db, async () => {}, DAY2 + AFTER_GATE);
    db.prepare(
      "INSERT INTO config_history (key, value, changed_at) VALUES ('alert_conditions', '{\"minUsd\":99999}', ?)",
    ).run(DAY2 + 3600);
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('alert_conditions', '{\"minUsd\":99999}')",
    ).run();
    const d2 = await maybeDailySignalDigest(
      db,
      async () => {},
      DAY2 + 86_400 + AFTER_GATE,
    );
    expect(d2?.paramsChanged).toBe(true);
    db.close();
  });
});
