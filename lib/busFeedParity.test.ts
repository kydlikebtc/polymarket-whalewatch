import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import { createBusDef } from "./busDefs";
import { recordAlert } from "./seen";
import {
  BusSignalSchema,
  BusWalletSchema,
  getBusSignals,
  projectBusSignals,
} from "./signalBus";
import type { Signal, SignalWallet } from "./signalFeed";

// bus[] ↔ active[] 的同形守卫。docs/api-access.md 承诺两个 feed「同名同义、
// 一套解析器吃两个」,但 bus[] 的投影层是字段白名单(拒绝原样 spread 是对的,
// 它挡住了 ConsensusWallet 的内部字段外泄),而白名单已经连续三批漏挑:
// 分类(2026-08-19)、wallets(73c3abd)、avgPrice(0edf02f)。每次都不红,
// 因为没有任何测试对照两边的字段集合 —— 本文件就是那条缺的锁。
//
// 两层,各防一类漏法:
//  1. 键集合奇偶校验:Signal 的键列成运行时数组(tsc 用 Record<Exclude<…>,
//     never> 保证列全),减去显式声明的差集后必须与 BusSignalSchema 完全相等。
//     防「schema 根本没这个字段」(分类那次)。
//  2. 富输入非空扫描:两类告警的载荷把能带的字段全带上,投影+读取后逐共享
//     字段断非空。防「schema 有但投影/读取漏搬」(avgPrice 那次 —— 字段在
//     schema 里,读取侧却只认 payload.price,consensus 恒 null)。
//
// 给 Signal 加字段时,这里的正确动作只有两种:补投影让两边都有,或把字段
// 加进 SIGNAL_ONLY 并写明为什么 bus[] 不该有 —— 静默漏挑不再是选项。

const NOW = Math.floor(Date.UTC(2026, 7, 27, 12) / 1000);

// ---- Signal 的键清单(运行时可见) --------------------------------------------
// satisfies 保证不多列/不拼错;下方的 Record<Exclude<…>, never> 保证不少列:
// Signal 新增字段而这里没跟上时,tsc 当场红 —— 这是整把锁的触发器。
const SIGNAL_KEYS = [
  "key",
  "kind",
  "conditionId",
  "title",
  "slug",
  "eventSlug",
  "category",
  "subcategory",
  "formationTs",
  "outcome",
  "outcomeIndex",
  "asset",
  "walletCount",
  "netUsd",
  "avgPrice",
  "wallets",
  "sides",
] as const satisfies readonly (keyof Signal)[];

type MissingFromSignalKeys = Exclude<
  keyof Signal,
  (typeof SIGNAL_KEYS)[number]
>;
// Signal 有而 SIGNAL_KEYS 没列的键会让这行编译失败(Record 要求该键存在)。
const _signalKeysExhaustive: Record<MissingFromSignalKeys, never> = {};
void _signalKeysExhaustive;

// ---- 允许的差集,每一项都要有理由 --------------------------------------------
// active[] 独有:折叠视图的产物,bus[] 是逐事件台账、不折叠。
const SIGNAL_ONLY: ReadonlySet<string> = new Set([
  // 客户端去重身份(conditionId|outcome);bus[] 有自己的 id + dedupKey。
  "key",
  // 折叠分类(consensus/split/heavy);bus[] 用 sourceType 表达来源,不做折叠。
  "kind",
  // 形成时刻语义(共识 firstTs);bus[] 行携带的是源事件时刻 emittedAt。
  "formationTs",
  // split 专属的双边明细,由折叠产生 —— bus[] 不折叠,天然没有。
  "sides",
]);

// bus[] 独有:台账身份与溯源,不是信号语义,active[] 不该有。
const BUS_ONLY: ReadonlySet<string> = new Set([
  "id", // 台账自增行号
  "sourceType", // 来源类型(large/consensus/discovery/…)
  "dedupKey", // 幂等键(alert:<id> / wallet:<addr>)
  "emittedAt", // 源事件入账时刻
  "payload", // 原始载荷,additive 兼容层
]);

const SHARED_KEYS = SIGNAL_KEYS.filter((k) => !SIGNAL_ONLY.has(k));

describe("bus[] ↔ active[] 键集合奇偶校验", () => {
  it("共享字段集合完全相等 —— 任一侧多出或缺失都点名报红", () => {
    const busKeys = Object.keys(BusSignalSchema.shape);
    const busShared = busKeys.filter((k) => !BUS_ONLY.has(k)).sort();
    // 两个方向一次断言:active[] 有而 bus[] 缺 → 左边少;bus[] 多出未声明
    // 字段 → 左边多。toEqual 的 diff 会直接点名是哪个键。
    expect(busShared).toEqual([...SHARED_KEYS].sort());
  });

  it("BUS_ONLY 清单不烂尾 —— 声明的差集必须真的存在于 schema", () => {
    const busKeys = new Set(Object.keys(BusSignalSchema.shape));
    for (const k of BUS_ONLY) {
      expect(busKeys.has(k), `BUS_ONLY 里的 ${k} 已不在 BusSignalSchema`).toBe(
        true,
      );
    }
  });

  it("钱包明细两侧同形:SignalWallet ↔ BusWalletSchema", () => {
    const WALLET_KEYS = [
      "wallet",
      "netUsd",
      "avgPrice",
    ] as const satisfies readonly (keyof SignalWallet)[];
    type MissingWalletKey = Exclude<
      keyof SignalWallet,
      (typeof WALLET_KEYS)[number]
    >;
    const _walletExhaustive: Record<MissingWalletKey, never> = {};
    void _walletExhaustive;
    expect(Object.keys(BusWalletSchema.shape).sort()).toEqual(
      [...WALLET_KEYS].sort(),
    );
  });
});

// ---- 富输入非空扫描 ----------------------------------------------------------
// 载荷把投影能带的字段全带上。这里的 fixture 一旦「省略」某字段,对应断言
// 就守不住 —— 所以形状照抄源侧真实写入(lib/alertEngine.ts 展开整个 Trade,
// lib/consensus.ts 平铺整个 ConsensusGroup)。

function seedRich(): DB {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO event_category (event_slug, category, subcategory, fetched_at) VALUES ('sb','Sports','NFL',?)",
  ).run(NOW);
  db.prepare(
    "INSERT INTO event_category (event_slug, category, subcategory, fetched_at) VALUES ('fed','Finance','Fed',?)",
  ).run(NOW);
  createBusDef(db, { sourceType: "large", label: "默认", threshold: 10_000 });
  createBusDef(db, { sourceType: "consensus", label: "默认", threshold: 2 });
  recordAlert(
    db,
    "large",
    "w1",
    JSON.stringify({
      proxyWallet: "0xa",
      conditionId: "0xc1",
      title: "Chiefs win?",
      outcome: "Yes",
      outcomeIndex: 0,
      asset: "11111",
      side: "BUY",
      size: 400_000,
      price: 0.5,
      slug: "chiefs",
      eventSlug: "sb",
    }),
    NOW - 60,
  );
  recordAlert(
    db,
    "consensus",
    "consensus:0xc2:Yes:3",
    JSON.stringify({
      conditionId: "0xc2",
      title: "Fed cut?",
      outcome: "Yes",
      outcomeIndex: 1,
      asset: "22222",
      walletCount: 3,
      totalNetUsd: 92_000,
      avgBuyPrice: 0.413,
      wallets: [
        { wallet: "0xbb", netUsd: 60_000, avgBuyPrice: 0.4, score: 91 },
        { wallet: "0xcc", netUsd: 32_000, avgBuyPrice: 0.44, score: 83 },
      ],
      slug: "fed-cut",
      eventSlug: "fed",
    }),
    NOW - 50,
  );
  projectBusSignals(db, NOW);
  return db;
}

describe("bus[] 富输入非空扫描 —— schema 有字段还不够,投影和读取都得真的搬", () => {
  for (const sourceType of ["large", "consensus"] as const) {
    it(`${sourceType}:载荷给全后,每个共享字段都必须非空`, () => {
      const db = seedRich();
      const row = getBusSignals(db, { nowSec: NOW }).find(
        (r) => r.sourceType === sourceType,
      )!;
      expect(row).toBeDefined();
      const bag = row as unknown as Record<string, unknown>;
      for (const k of SHARED_KEYS) {
        // 逐字段点名:整行 snapshot 挂了只会说「不相等」,这里直接说漏了谁。
        expect(
          bag[k],
          `${sourceType} 的 ${k} 为空 —— 投影或读取侧漏搬`,
        ).not.toBeNull();
        expect(bag[k], `${sourceType} 的 ${k} 未定义`).not.toBeUndefined();
      }
      db.close();
    });
  }

  it("读出的每一行都过 BusSignalSchema.parse —— schema 即契约,不是摆设", () => {
    const db = seedRich();
    const rows = getBusSignals(db, { nowSec: NOW });
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(() => BusSignalSchema.parse(row)).not.toThrow();
    }
    db.close();
  });
});
