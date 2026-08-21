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

// 源告警的载荷是 `JSON.stringify({...g, params})`(lib/consensus.ts)——
// 整个 ConsensusGroup 平铺进去,`wallets` 一直都在。这里照着它的真实形状造,
// 包括 `avgBuyPrice` 这个只在源侧存在的历史字段名。
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
      wallets: [
        { wallet: "0xbb", netUsd: 60000, avgBuyPrice: 0.4, score: 91 },
        { wallet: "0xcc", netUsd: 32000, avgBuyPrice: 0.44, score: 83 },
      ],
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
    createBusDef(db, {
      sourceType: "large",
      label: "默认",
      threshold: 100_000,
    });
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

// --- bus[] 的字段丰富度对齐 active[](2026-08-19)-----------------------------
//
// 此前 bus[] 只有 6 个顶层字段 + 一个 `payload: Record<string, unknown>` 黑盒,
// 而 payload 的形状随 sourceType 变:同一个「这笔多少钱」在 large 里叫 `usd`、
// 在 consensus 里叫 `totalNetUsd`,消费方必须先 switch 类型才知道读哪个键;
// 分类(category/subcategory)则完全没有,想按赛道过滤根本做不到。
//
// 现在归一后的字段提升到顶层、与 active[] 同名同义,payload 原样保留 ——
// additive,老消费方零改动。

function seedAllTypes() {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO event_category (event_slug, category, subcategory, fetched_at) VALUES ('sb','Sports','NFL',?)",
  ).run(NOW);
  createBusDef(db, { sourceType: "large", label: "默认", threshold: 10_000 });
  createBusDef(db, { sourceType: "consensus", label: "默认", threshold: 2 });
  createBusDef(db, { sourceType: "discovery", label: "默认", threshold: 60 });
  whaleAlert(db, "w1", 200_000, NOW - 60);
  consensusAlert(db, 3, NOW - 50);
  db.prepare(
    "INSERT INTO smart_wallets (address, score, source, is_whitelist, updated_at) VALUES ('0xdead', 88, 'leaderboard', 1, ?)",
  ).run(NOW - 40);
  projectBusSignals(db, NOW);
  return db;
}

const pick = (db: DB, t: string) =>
  getBusSignals(db, { nowSec: NOW }).find((r) => r.sourceType === t)!;

describe("bus[] 顶层字段与 active[] 同名同义", () => {
  it("large:usd→netUsd、price→avgPrice、单笔的 walletCount 恒为 1", () => {
    const db = seedAllTypes();
    const r = pick(db, "large");
    expect(r.netUsd).toBe(200_000);
    expect(r.avgPrice).toBe(1);
    // 一笔成交就是一个钱包 —— 给出 1 而非 null,消费方不必为 large 写特例。
    expect(r.walletCount).toBe(1);
    expect(r.outcome).toBe("Yes");
    expect(r.slug).toBe("chiefs");
    expect(r.eventSlug).toBe("sb");
    db.close();
  });

  it("consensus:totalNetUsd→netUsd,walletCount 原样透传", () => {
    const db = seedAllTypes();
    const r = pick(db, "consensus");
    // 同一个语义在两个类型里必须叫同一个名字 —— 这正是要消灭的东西。
    expect(r.netUsd).toBe(92_000);
    expect(r.walletCount).toBe(3);
    expect(r.outcome).toBe("Yes");
    db.close();
  });

  it("discovery 没有市场:市场字段一律 null,结构不变形", () => {
    const db = seedAllTypes();
    const r = pick(db, "discovery");
    // 结构统一 = 消费方一套解析走到底,不必按类型分支判断字段在不在。
    expect(r.conditionId).toBeNull();
    expect(r.slug).toBeNull();
    expect(r.eventSlug).toBeNull();
    expect(r.category).toBeNull();
    expect(r.outcome).toBeNull();
    expect(r.netUsd).toBeNull();
    // 但它自己的信息仍在 payload 里,一个不少。
    expect(r.payload.address).toBe("0xdead");
    expect(r.payload.score).toBe(88);
    db.close();
  });

  it("分类由 eventSlug join event_category 补上 —— 此前 bus[] 完全没有", () => {
    const db = seedAllTypes();
    const r = pick(db, "large");
    expect(r.category).toBe("Sports");
    expect(r.subcategory).toBe("NFL");
    db.close();
  });

  it("查不到分类的事件给 null,不炸也不留空串", () => {
    const db = seedAllTypes();
    // consensus 的 eventSlug 在载荷里就没有 → 无从 join。
    const r = pick(db, "consensus");
    expect(r.category).toBeNull();
    expect(r.subcategory).toBeNull();
    db.close();
  });

  it("payload 原样保留 —— 读 payload.usd 的老消费方零改动", () => {
    const db = seedAllTypes();
    const r = pick(db, "large");
    expect(r.payload.usd).toBe(200_000);
    expect(r.payload.price).toBe(1);
    expect(r.payload.slug).toBe("chiefs");
    db.close();
  });
});

// --- wallets:钱包明细补齐(2026-08-21)---------------------------------------
//
// 上一批把身份/方向/金额三组字段对齐了 active[],停在了「谁买的」前面:视图
// (§9.1)早有 `wallets`,bus[] 却只给一个 walletCount 数字 —— 消费方想知道
// 是哪几个钱包、各自成本多少,只能回头再查一次。
//
// 而数据一直都在:large 的 `payload.wallet` 从批次 A 起就写着(历史行全有),
// consensus 的源告警载荷平铺了整个 ConsensusGroup(含 wallets[])—— 只是投影
// 时那把白名单钥匙没带上它。

describe("bus[] 的 wallets —— 与 active[] 的钱包明细同名同义", () => {
  it("large:一笔成交合成单元素明细,与 active[] 的 heavy 同一形状", () => {
    const db = seedAllTypes();
    const r = pick(db, "large");
    // walletCount 恒 1 的那条纪律在这里长出对应的明细:数字与列表不能打架。
    expect(r.wallets).toEqual([
      { wallet: "0xa", netUsd: 200_000, avgPrice: 1 },
    ]);
    db.close();
  });

  it("consensus:源告警的 wallets[] 全量透出,avgBuyPrice 归一为 avgPrice", () => {
    const db = seedAllTypes();
    const r = pick(db, "consensus");
    // 同一个「他的成本」在源侧叫 avgBuyPrice、在 active[] 里叫 avgPrice ——
    // 归一到 active[] 那个名字,一套解析器才吃得下两个 feed。
    expect(r.wallets).toEqual([
      { wallet: "0xbb", netUsd: 60_000, avgPrice: 0.4 },
      { wallet: "0xcc", netUsd: 32_000, avgPrice: 0.44 },
    ]);
    // 顺序即信息:源侧已按净买降序,透出时不得重排。
    expect(r.wallets![0].netUsd).toBeGreaterThan(r.wallets![1].netUsd);
    db.close();
  });

  it("discovery 没有仓位:wallets 为 null,不拿地址合成假条目", () => {
    const db = seedAllTypes();
    const r = pick(db, "discovery");
    // 它只有「谁进池了」,没有净买没有均价 —— 合成一条两字段恒 null 的明细
    // 是在编造语义。地址仍在 payload.address 里,一个不少。
    expect(r.wallets).toBeNull();
    expect(r.payload.address).toBe("0xdead");
    db.close();
  });

  it("投影只带走三个字段 —— 源侧 ConsensusWallet 的其余字段不进载荷", () => {
    const db = seedAllTypes();
    const r = pick(db, "consensus");
    // 投影层是白名单挑选而非原样 spread:内部类型加字段不该静默变成 API 变化
    // (这正是当初 wallets 被漏掉的那把锁,补的时候不能把锁拆了)。
    const raw = (r.payload.wallets as Record<string, unknown>[])[0];
    expect(Object.keys(raw).sort()).toEqual([
      "avgBuyPrice",
      "netUsd",
      "wallet",
    ]);
    expect(raw.score).toBeUndefined();
    db.close();
  });

  it("载荷里没有钱包信息的老事件给 null —— 空数组会谎称「零个钱包」", () => {
    const db = openDb(":memory:");
    createBusDef(db, { sourceType: "consensus", label: "默认", threshold: 2 });
    // 2026-08-21 之前投影入账的 consensus 行:载荷里没有 wallets。
    recordAlert(
      db,
      "consensus",
      "consensus:0xold:Yes:2",
      JSON.stringify({
        conditionId: "0xold",
        title: "老事件",
        outcome: "Yes",
        walletCount: 2,
        totalNetUsd: 50_000,
      }),
      NOW - 30,
    );
    projectBusSignals(db, NOW);
    const r = pick(db, "consensus");
    expect(r.walletCount).toBe(2);
    expect(r.wallets).toBeNull();
    db.close();
  });
});
