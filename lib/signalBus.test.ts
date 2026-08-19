import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import { createBusDef } from "./busDefs";
import { recordAlert } from "./seen";
import {
  BUS_TYPES,
  DEFAULT_BUS_SETTINGS,
  getBusSettings,
  getBusSignals,
  projectBusSignals,
  setBusSettings,
  type BusSettings,
} from "./signalBus";

const NOW = Math.floor(Date.UTC(2026, 7, 17, 12) / 1000);

function whaleAlert(
  db: DB,
  key: string,
  usd: number,
  ts: number,
  type = "large",
) {
  recordAlert(
    db,
    type,
    key,
    JSON.stringify({
      proxyWallet: "0xa",
      conditionId: "0xc1",
      title: "Chiefs win?",
      outcome: "Yes",
      side: "BUY",
      size: usd,
      price: 1,
      slug: "chiefs",
      eventSlug: "sb",
    }),
    ts,
  );
}

function consensusAlert(db: DB, n: number, ts: number) {
  recordAlert(
    db,
    "consensus",
    `consensus:0xc2:Yes:${n}`,
    JSON.stringify({
      conditionId: "0xc2",
      title: "Fed cut?",
      outcome: "Yes",
      walletCount: n,
      totalNetUsd: 92000,
    }),
    ts,
  );
}

describe("BUS_TYPES", () => {
  it("注册表与默认设置一一对应(漏一个=该类型永远开不了)", () => {
    expect(BUS_TYPES.map((t) => t.type).sort()).toEqual(
      Object.keys(DEFAULT_BUS_SETTINGS).sort(),
    );
    for (const t of BUS_TYPES) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.hint.length).toBeGreaterThan(0);
    }
  });
  it("已实现的类型标 available,未落库的标为待接入(UI 据此禁用开关)", () => {
    const impl = BUS_TYPES.filter((t) => t.available).map((t) => t.type);
    expect(impl.sort()).toEqual(["consensus", "discovery", "large"]);
  });
});

describe("getBusSettings / setBusSettings", () => {
  it("默认全关 —— 新能力不该在运营者不知情时就往订阅方推数据", () => {
    expect(getBusSettings(openDb(":memory:"))).toEqual(DEFAULT_BUS_SETTINGS);
    for (const v of Object.values(DEFAULT_BUS_SETTINGS)) {
      expect(v.enabled).toBe(false);
    }
  });
  it("往返读写,坏 JSON 回落默认", () => {
    const db = openDb(":memory:");
    const next: BusSettings = {
      ...DEFAULT_BUS_SETTINGS,
      large: { enabled: true, minUsd: 100_000 },
    };
    setBusSettings(db, next);
    expect(getBusSettings(db).large).toEqual({
      enabled: true,
      minUsd: 100_000,
    });
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('bus_signal_settings','oops{')",
    ).run();
    expect(getBusSettings(db)).toEqual(DEFAULT_BUS_SETTINGS);
  });
  it("真实变更才写 config_history", () => {
    const db = openDb(":memory:");
    const n = () =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM config_history WHERE key='bus_signal_settings'",
          )
          .get() as { n: number }
      ).n;
    const s: BusSettings = {
      ...DEFAULT_BUS_SETTINGS,
      large: { enabled: true, minUsd: 50_000 },
    };
    setBusSettings(db, s);
    expect(n()).toBe(1);
    setBusSettings(db, s);
    expect(n()).toBe(1);
  });
});

describe("projectBusSignals", () => {
  it("无启用信号定义的类型不写入总线(省表也省投递配额)", () => {
    const db = openDb(":memory:");
    whaleAlert(db, "a", 200_000, NOW - 60);
    expect(projectBusSignals(db, NOW).written).toBe(0);
    expect(getBusSignals(db, { nowSec: NOW }).length).toBe(0);
  });

  it("大单:按各自阈值投影,低于阈值的不进总线", () => {
    const db = openDb(":memory:");
    createBusDef(db, { sourceType: "large", label: "默认", threshold: 100_000 });
    whaleAlert(db, "big", 200_000, NOW - 60);
    whaleAlert(db, "small", 20_000, NOW - 50);
    expect(projectBusSignals(db, NOW).written).toBe(1);
    const rows = getBusSignals(db, { nowSec: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceType: "large",
      title: "Chiefs win?",
    });
    expect(rows[0].payload).toMatchObject({ usd: 200_000, outcome: "Yes" });
  });

  it("幂等:同一告警投影两次只留一行", () => {
    const db = openDb(":memory:");
    createBusDef(db, { sourceType: "large", label: "默认", threshold: 10_000 });
    whaleAlert(db, "a", 50_000, NOW - 60);
    expect(projectBusSignals(db, NOW).written).toBe(1);
    expect(projectBusSignals(db, NOW).written).toBe(0);
    expect(getBusSignals(db, { nowSec: NOW })).toHaveLength(1);
  });

  it("共识:按最少钱包数阈值过滤", () => {
    const db = openDb(":memory:");
    createBusDef(db, { sourceType: "consensus", label: "默认", threshold: 3 });
    consensusAlert(db, 2, NOW - 100);
    consensusAlert(db, 4, NOW - 50);
    expect(projectBusSignals(db, NOW).written).toBe(1);
    expect(getBusSignals(db, { nowSec: NOW })[0].payload).toMatchObject({
      walletCount: 4,
    });
  });

  it("发现:新入池的白名单成员进总线", () => {
    const db = openDb(":memory:");
    createBusDef(db, { sourceType: "discovery", label: "默认", threshold: 60 });
    db.prepare(
      "INSERT INTO smart_wallets (address, score, is_whitelist, source, updated_at) VALUES (?,?,?,?,?)",
    ).run("0xnew", 88, 1, "discovered:splitter", NOW - 100);
    db.prepare(
      "INSERT INTO smart_wallets (address, score, is_whitelist, source, updated_at) VALUES (?,?,?,?,?)",
    ).run("0xweak", 40, 1, "discovered:echo", NOW - 90);
    expect(projectBusSignals(db, NOW).written).toBe(1);
    expect(getBusSignals(db, { nowSec: NOW })[0].payload).toMatchObject({
      address: "0xnew",
      score: 88,
    });
  });

  it("只投影窗口内的新事件(不把历史一次性灌进总线)", () => {
    const db = openDb(":memory:");
    createBusDef(db, { sourceType: "large", label: "默认", threshold: 10_000 });
    whaleAlert(db, "ancient", 99_000, NOW - 30 * 86400);
    whaleAlert(db, "fresh", 99_000, NOW - 60);
    expect(projectBusSignals(db, NOW).written).toBe(1);
    // 进总线的是窗口内那条(按 emittedAt 判定;dedupKey 是 alert:<id>)。
    expect(getBusSignals(db, { nowSec: NOW })[0].emittedAt).toBe(NOW - 60);
  });

  it("只读本地表 —— 投影期间不得有任何上游请求", () => {
    const db = openDb(":memory:");
    createBusDef(db, { sourceType: "large", label: "默认", threshold: 10_000 });
    whaleAlert(db, "a", 50_000, NOW - 60);
    const origFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (() => {
      called++;
      throw new Error("投影层不该发起网络请求");
    }) as typeof fetch;
    try {
      projectBusSignals(db, NOW);
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(called).toBe(0);
  });
});
