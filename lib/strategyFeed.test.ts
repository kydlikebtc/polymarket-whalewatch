import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { recordStrategySignal } from "./strategySignals";
import {
  buildStrategyFeed,
  STRATEGY_ACTIVE_WINDOW_HOURS,
} from "./strategyFeed";

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
