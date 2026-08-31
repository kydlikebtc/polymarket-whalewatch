import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { recordStrategySignal } from "./strategySignals";
import {
  buildStrategyFeed,
  STRATEGY_ACTIVE_WINDOW_HOURS,
} from "./strategyFeed";
import { SignalEventV1Schema } from "./webhookDelivery";

// 对外信号批次 2:/api/signals 的 strategies 段。全部字段来自已持久化状态
// (strategy_signals + follow_strategies + event_category),零上游调用 ——
// 与 buildSignalFeed 同一契约纪律。nowSec 全参数化:延迟视图 = 传入
// nowSec - delaySec,整段数据就是「30 分钟前的世界」。

const NOW = 1_000_000;

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

const seed = (
  db: ReturnType<typeof openDb>,
  o: {
    strategyId: number;
    cid?: string;
    emittedAt?: number;
    eventSlug?: string;
    settled?: { ts: number; exit: number; pnl: number };
  },
) => {
  const id = recordStrategySignal(db, {
    strategyId: o.strategyId,
    positionId: null,
    conditionId: o.cid ?? "c1",
    outcome: "Yes",
    outcomeIndex: 0,
    asset: "tok",
    title: "T",
    slug: "s",
    eventSlug: o.eventSlug ?? "e1",
    formationTs: (o.emittedAt ?? NOW) - 60,
    referencePrice: 0.6,
    walletCount: 1,
    totalNetUsd: 52_000,
    entryPrice: 0.63,
    sizeUsd: 500,
    emittedAt: o.emittedAt ?? NOW,
  });
  if (id != null && o.settled) {
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

describe("buildStrategyFeed", () => {
  it("active:只含 push_enabled 档的未结算信号,带策略名/source/分类 join", () => {
    const db = openDb(":memory:");
    const whale = enablePush(db, "巨鲸");
    const off = idOf(db, "保守"); // push_enabled=0
    db.prepare(
      "INSERT INTO event_category (event_slug, category, subcategory, fetched_at) VALUES ('e1','Sports','NBA',1)",
    ).run();
    seed(db, { strategyId: whale, cid: "c1" });
    seed(db, { strategyId: off, cid: "c2" });
    const feed = buildStrategyFeed(db, { nowSec: NOW + 100 });
    expect(feed.active).toHaveLength(1);
    const s = feed.active[0];
    expect(s.strategy.name).toBe("巨鲸");
    expect(s.strategy.source).toBe("heavy");
    expect(s.category).toBe("Sports");
    expect(s.subcategory).toBe("NBA");
    expect(s.entryPrice).toBe(0.63);
    expect(s.referencePrice).toBe(0.6);
    db.close();
  });

  it("active 窗口:超过 48h 的未结算信号不再出现在 active(旧信号不是行动项)", () => {
    const db = openDb(":memory:");
    const whale = enablePush(db, "巨鲸");
    seed(db, {
      strategyId: whale,
      cid: "old",
      emittedAt: NOW - STRATEGY_ACTIVE_WINDOW_HOURS * 3600 - 10,
    });
    seed(db, { strategyId: whale, cid: "fresh", emittedAt: NOW - 100 });
    const feed = buildStrategyFeed(db, { nowSec: NOW });
    expect(feed.active.map((s) => s.conditionId)).toEqual(["fresh"]);
    db.close();
  });

  it("settled:近 3 天、新在前、最多 20 条", () => {
    const db = openDb(":memory:");
    const whale = enablePush(db, "巨鲸");
    seed(db, {
      strategyId: whale,
      cid: "s1",
      emittedAt: NOW - 4000,
      settled: { ts: NOW - 3000, exit: 1, pnl: 293.7 },
    });
    seed(db, {
      strategyId: whale,
      cid: "s2",
      emittedAt: NOW - 5000,
      settled: { ts: NOW - 1000, exit: 0, pnl: -500 },
    });
    seed(db, {
      strategyId: whale,
      cid: "s3",
      emittedAt: NOW - 4 * 86_400,
      settled: { ts: NOW - 3.5 * 86_400, exit: 1, pnl: 1 },
    });
    const feed = buildStrategyFeed(db, { nowSec: NOW });
    expect(feed.settled.map((s) => s.conditionId)).toEqual(["s2", "s1"]);
    expect(feed.settled[0].won).toBe(false);
    expect(feed.settled[1].won).toBe(true);
    db.close();
  });

  it("recordByStrategy:push_enabled 档的 30d 战绩(来自 follow_positions)", () => {
    const db = openDb(":memory:");
    const whale = enablePush(db, "巨鲸");
    db.prepare(
      `INSERT INTO follow_positions (strategy_id, condition_id, outcome, asset, outcome_index, title, event_slug, entry_ts, entry_price, smart_avg_price, size_usd, shares, status, realized_pnl)
       VALUES (?, 'p1', 'Yes', 'tok', 0, 'T', 'e', ?, 0.6, 0.58, 500, 833, 'settled', 100)`,
    ).run(whale, NOW - 86_400);
    const feed = buildStrategyFeed(db, { nowSec: NOW });
    const rec = feed.recordByStrategy[String(whale)];
    expect(rec).toBeTruthy();
    expect(rec.name).toBe("巨鲸");
    expect(rec.record.settled).toBe(1);
    expect(rec.record.wins).toBe(1);
    // push_enabled=0 的档不出现。
    expect(
      Object.keys(feed.recordByStrategy).map(
        (k) =>
          (
            db
              .prepare(
                "SELECT push_enabled FROM follow_strategies WHERE id = ?",
              )
              .get(Number(k)) as { push_enabled: number }
          ).push_enabled,
      ),
    ).toEqual([1]);
    db.close();
  });

  it("时移语义:nowSec 前移即得历史视图(延迟分层的实现基础)", () => {
    const db = openDb(":memory:");
    const whale = enablePush(db, "巨鲸");
    seed(db, { strategyId: whale, cid: "new", emittedAt: NOW - 100 });
    // 30 分钟前的世界:这条信号还不存在。
    const delayed = buildStrategyFeed(db, { nowSec: NOW - 1800 });
    expect(delayed.active).toHaveLength(0);
    const live = buildStrategyFeed(db, { nowSec: NOW });
    expect(live.active).toHaveLength(1);
    db.close();
  });

  // 档位码是订阅方唯一该硬编码的标识(id 部署本地、name 中文、source 不唯一,
  // 见 lib/strategyCodes)。三个出口都得带上它 —— 漏一个,那条路径的消费方
  // 就被迫退回去认 id 或中文名。
  it("三个出口(active / settled / recordByStrategy)都带 code", () => {
    const db = openDb(":memory:");
    const sid = enablePush(db, "超级巨鲸");
    seed(db, { strategyId: sid, cid: "a1" });
    seed(db, {
      strategyId: sid,
      cid: "s1",
      settled: { ts: NOW - 100, exit: 1, pnl: 100 },
    });
    const feed = buildStrategyFeed(db, { nowSec: NOW });

    expect(feed.active[0].strategy.code).toBe("mega_whale");
    expect(feed.settled[0].strategyCode).toBe("mega_whale");
    expect(feed.recordByStrategy[String(sid)].code).toBe("mega_whale");
    // id 仍在(同一次响应内的分组键),只是不再是唯一可用的标识。
    expect(feed.active[0].strategy.id).toBe(sid);
    db.close();
  });

  it("未登记档位码的档(运营手工建的)取 null,不回退成档名", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO follow_strategies (name, enabled, push_enabled, params_json, created_at) VALUES (?,1,1,?,?)",
    ).run("运营手工档", JSON.stringify({ source: "heavy" }), NOW);
    const sid = idOf(db, "运营手工档");
    seed(db, { strategyId: sid, cid: "m1" });
    const feed = buildStrategyFeed(db, { nowSec: NOW });
    expect(feed.active[0].strategy.code).toBeNull();
    expect(feed.active[0].strategy.name).toBe("运营手工档");
    db.close();
  });
});

// 动作流(2026-08-31):买入与兑现是一等对称事件。此前拉取侧只有买入 ——
// active[] 在结算后把行撤走(轮询方视角是「买入被撤走」而非「收到兑现」),
// settled[] 是 3d/LIMIT 20 的战绩视图。events[] 是 webhook SignalEventV1 的
// 拉取镜像:同一 buildSignalEvent 构造,同 (id, event) 幂等键。
describe("events[] 动作流:兑现与买入同为一等事件", () => {
  it("结算后的信号出两条事件(entry+settle),entry 不因结算消失;逐条过 SignalEventV1Schema", () => {
    const db = openDb(":memory:");
    const whale = enablePush(db, "巨鲸");
    seed(db, {
      strategyId: whale,
      cid: "done",
      emittedAt: NOW - 4000,
      settled: { ts: NOW - 1000, exit: 1, pnl: 293.7 },
    });
    const feed = buildStrategyFeed(db, { nowSec: NOW });
    // 状态视图 vs 动作流的分野:active[] 里这行已消失,events[] 里买入仍在。
    expect(feed.active).toHaveLength(0);
    expect(feed.events.map((e) => e.event)).toEqual(["settle", "entry"]);
    for (const e of feed.events) {
      expect(SignalEventV1Schema.parse(e)).toBeTruthy();
    }
    const settle = feed.events[0];
    const entry = feed.events[1];
    // 同一台账行、同一幂等键前半 —— (id, event) 与 webhook 完全一致。
    expect(settle.id).toBe(entry.id);
    expect(settle.settle).toEqual({
      settledTs: NOW - 1000,
      exitPrice: 1,
      won: true,
      realizedPnl: 293.7,
    });
    expect(entry.settle).toBeNull();
    expect(entry.paper.entryPrice).toBe(0.63);
    // record 与 recordByStrategy 同源(投递时 webhook 也带同一份 30d 战绩)。
    expect(settle.record).toEqual(feed.recordByStrategy[String(whale)].record);
    db.close();
  });

  it("窗口:entry 按 emitted_at、settle 按 settled_ts 各 48h —— 老买入的新结算只出 settle 事件", () => {
    const db = openDb(":memory:");
    const whale = enablePush(db, "巨鲸");
    db.prepare(
      "INSERT INTO event_category (event_slug, category, subcategory, fetched_at) VALUES ('e1','Sports','NBA',1)",
    ).run();
    // 买入在 3 天前(出窗),结算 1h 前(在窗)—— 兑现动作必须可见,
    // 且分类 join 对「只出现在 settle 行」的 slug 也生效。
    seed(db, {
      strategyId: whale,
      cid: "oldbuy",
      emittedAt: NOW - 3 * 86_400,
      settled: { ts: NOW - 3600, exit: 0, pnl: -500 },
    });
    // 结算超 48h(出窗),买入更早:两条都不出。
    seed(db, {
      strategyId: whale,
      cid: "ancient",
      emittedAt: NOW - 6 * 86_400,
      settled: { ts: NOW - 3 * 86_400, exit: 1, pnl: 1 },
    });
    const feed = buildStrategyFeed(db, { nowSec: NOW });
    expect(feed.events.map((e) => [e.market.conditionId, e.event])).toEqual([
      ["oldbuy", "settle"],
    ]);
    expect(feed.events[0].market.category).toBe("Sports");
    db.close();
  });

  it("排序:事件自身时刻倒序,同刻 settle 在 entry 前(操作历史「同刻兑现在上」)", () => {
    const db = openDb(":memory:");
    const whale = enablePush(db, "巨鲸");
    // b 买入较早、同刻结算;a 在两者之间买入。时间线(倒序):
    // settle(b)@NOW-50 → entry(a)@NOW-50(同刻,settle 在前)→ entry(b)@NOW-200。
    seed(db, {
      strategyId: whale,
      cid: "b",
      emittedAt: NOW - 200,
      settled: { ts: NOW - 50, exit: 1, pnl: 100 },
    });
    seed(db, { strategyId: whale, cid: "a", emittedAt: NOW - 50 });
    const feed = buildStrategyFeed(db, { nowSec: NOW });
    expect(feed.events.map((e) => [e.market.conditionId, e.event])).toEqual([
      ["b", "settle"],
      ["a", "entry"],
      ["b", "entry"],
    ]);
    db.close();
  });

  it("时移:delayed 视图里「尚未发生」的结算不出现,买入照常 —— 与 active 的口径互洽", () => {
    const db = openDb(":memory:");
    const whale = enablePush(db, "巨鲸");
    seed(db, {
      strategyId: whale,
      cid: "c1",
      emittedAt: NOW - 4000,
      settled: { ts: NOW - 600, exit: 1, pnl: 100 },
    });
    // 30 分钟前的世界:结算(NOW-600)还没发生 —— events 只有 entry,
    // 且该信号在 active[] 里仍是行动项。
    const delayed = buildStrategyFeed(db, { nowSec: NOW - 1800 });
    expect(delayed.events.map((e) => e.event)).toEqual(["entry"]);
    expect(delayed.active).toHaveLength(1);
    const live = buildStrategyFeed(db, { nowSec: NOW });
    expect(live.events.map((e) => e.event)).toEqual(["settle", "entry"]);
    db.close();
  });

  it("push_enabled=0 的档不进动作流(对外只谈已放开推送的档)", () => {
    const db = openDb(":memory:");
    enablePush(db, "巨鲸");
    const off = idOf(db, "保守");
    seed(db, {
      strategyId: off,
      cid: "hidden",
      settled: { ts: NOW - 100, exit: 1, pnl: 100 },
    });
    const feed = buildStrategyFeed(db, { nowSec: NOW });
    expect(feed.events).toEqual([]);
    db.close();
  });
});

describe("wallets_json 惰性守卫(向前落库批次)", () => {
  it("台账行带 wallets_json,feed 输出零泄漏 —— 对外开放是另一个批次的产品决定", () => {
    const db = openDb(":memory:");
    const whale = enablePush(db, "巨鲸");
    seed(db, { strategyId: whale, cid: "c1" });
    db.prepare("UPDATE strategy_signals SET wallets_json = ?").run(
      '[{"wallet":"0xleakcheck","netUsd":52000,"score":88}]',
    );
    const feed = buildStrategyFeed(db, { nowSec: NOW + 100 });
    expect(feed.active).toHaveLength(1);
    const dumped = JSON.stringify(feed);
    // 哨兵地址与字段名双查:SELECT * 取回来的列若被 spread 式重构漏出,
    // 任一断言当场红。walletCount(无 s)不误伤。
    expect(dumped).not.toContain("0xleakcheck");
    expect(dumped).not.toContain("wallets");
  });
});
