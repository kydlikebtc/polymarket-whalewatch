import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import {
  defaultXParams,
  getXBroadcastParams,
  setXBroadcastParams,
  type XBroadcastParams,
} from "./xParams";
import { DAILY_CAP } from "./xQuota";
import { PREGAME_MIN_H, PREGAME_MAX_H } from "./xPregame";
import { WEEKLY_POST_UTC_HOUR } from "./xWeekly";
import { WHALE_SIREN_USD } from "./xComposer";

// env 派生的两个默认值(生产里来自 X_MONTHLY_BUDGET_USD / X_MIN_TRADE_USD)。
const ENV = { budgetUsd: 15, whaleMinTradeUsd: 50_000 };

function writeRaw(db: DB, value: string) {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    "x_broadcast_params",
    value,
  );
}

describe("defaultXParams", () => {
  it("出厂默认与各模块常量同源(数字只有一个家,这里不抄第二份)", () => {
    const d = defaultXParams(ENV);
    expect(d).toEqual({
      budgetUsd: 15,
      dailySpendCapUsd: null,
      weeklySpendCapUsd: null,
      whaleMinTradeUsd: 50_000,
      whaleDailyCap: DAILY_CAP.whale,
      whaleSirenUsd: WHALE_SIREN_USD,
      consensusDailyCap: null,
      pregameDailyCap: DAILY_CAP.pregame,
      pregameMinH: PREGAME_MIN_H,
      pregameMaxH: PREGAME_MAX_H,
      settledDailyCap: DAILY_CAP.settled,
      weeklyUtcHour: WEEKLY_POST_UTC_HOUR,
    });
  });

  it("budget/阈值默认跟随 env(没在后台保存过的部署行为不变)", () => {
    const d = defaultXParams({ budgetUsd: 30, whaleMinTradeUsd: 80_000 });
    expect(d.budgetUsd).toBe(30);
    expect(d.whaleMinTradeUsd).toBe(80_000);
  });
});

describe("getXBroadcastParams", () => {
  it("无配置行 → 全默认", () => {
    const db = openDb(":memory:");
    expect(getXBroadcastParams(db, ENV)).toEqual(defaultXParams(ENV));
  });

  it("set → get 完整往返(含 consensus 数字上限)", () => {
    const db = openDb(":memory:");
    const p: XBroadcastParams = {
      budgetUsd: 25,
      dailySpendCapUsd: 1,
      weeklySpendCapUsd: 6,
      whaleMinTradeUsd: 30_000,
      whaleDailyCap: 12,
      whaleSirenUsd: 300_000,
      consensusDailyCap: 4,
      pregameDailyCap: 5,
      pregameMinH: 0.5,
      pregameMaxH: 12,
      settledDailyCap: 8,
      weeklyUtcHour: 9,
    };
    setXBroadcastParams(db, p);
    expect(getXBroadcastParams(db, ENV)).toEqual(p);
  });

  it("consensusDailyCap = null 是合法存量(明确的「不限」),不被回落", () => {
    const db = openDb(":memory:");
    setXBroadcastParams(db, {
      ...defaultXParams(ENV),
      consensusDailyCap: null,
      whaleDailyCap: 7,
    });
    const got = getXBroadcastParams(db, ENV);
    expect(got.consensusDailyCap).toBeNull();
    expect(got.whaleDailyCap).toBe(7);
  });

  it("单键非法只回落该键,好键保留 —— 坏配置绝不能毒化预算熔断", () => {
    const db = openDb(":memory:");
    writeRaw(
      db,
      JSON.stringify({
        budgetUsd: -3, // 非法:负预算会让熔断永远闭合
        dailySpendCapUsd: -1, // 非法:负上限
        weeklySpendCapUsd: 4, // 合法
        whaleMinTradeUsd: "50000", // 非法:字符串
        whaleDailyCap: 2.5, // 非法:非整数
        whaleSirenUsd: "x", // 非法:字符串
        consensusDailyCap: 0, // 非法:cap 最小 1(0 用类型开关表达)
        pregameDailyCap: 6, // 合法
        settledDailyCap: 1, // 合法
        weeklyUtcHour: 24, // 非法:超出 0-23
      }),
    );
    const got = getXBroadcastParams(db, ENV);
    expect(got.budgetUsd).toBe(ENV.budgetUsd);
    expect(got.dailySpendCapUsd).toBeNull();
    expect(got.weeklySpendCapUsd).toBe(4);
    expect(got.whaleMinTradeUsd).toBe(ENV.whaleMinTradeUsd);
    expect(got.whaleDailyCap).toBe(DAILY_CAP.whale);
    expect(got.whaleSirenUsd).toBe(WHALE_SIREN_USD);
    expect(got.consensusDailyCap).toBeNull();
    expect(got.pregameDailyCap).toBe(6);
    expect(got.settledDailyCap).toBe(1);
    expect(got.weeklyUtcHour).toBe(WEEKLY_POST_UTC_HOUR);
  });

  it("赛前窗口倒挂 → 两端一起回落(空窗口会让赛前线静默消失)", () => {
    const db = openDb(":memory:");
    writeRaw(db, JSON.stringify({ pregameMinH: 8, pregameMaxH: 2 }));
    const got = getXBroadcastParams(db, ENV);
    expect(got.pregameMinH).toBe(PREGAME_MIN_H);
    expect(got.pregameMaxH).toBe(PREGAME_MAX_H);
  });

  it("单端合法但与另一端默认值倒挂 → 同样双双回落", () => {
    const db = openDb(":memory:");
    // minH=7 本身在 [0,168],但默认 maxH=6 → 7<6 不成立。
    writeRaw(db, JSON.stringify({ pregameMinH: 7 }));
    const got = getXBroadcastParams(db, ENV);
    expect(got.pregameMinH).toBe(PREGAME_MIN_H);
    expect(got.pregameMaxH).toBe(PREGAME_MAX_H);
  });

  it("坏 JSON / 非对象 → 全默认", () => {
    const db = openDb(":memory:");
    writeRaw(db, "{not json");
    expect(getXBroadcastParams(db, ENV)).toEqual(defaultXParams(ENV));
    writeRaw(db, JSON.stringify([1, 2]));
    // 数组 typeof 是 object 但没有任何合法键 → 逐键全回落,等价默认。
    expect(getXBroadcastParams(db, ENV)).toEqual(defaultXParams(ENV));
    writeRaw(db, JSON.stringify("x"));
    expect(getXBroadcastParams(db, ENV)).toEqual(defaultXParams(ENV));
  });

  it("旧行缺新键(升级场景)→ 缺的键用默认", () => {
    const db = openDb(":memory:");
    writeRaw(db, JSON.stringify({ whaleDailyCap: 30 }));
    const got = getXBroadcastParams(db, ENV);
    expect(got.whaleDailyCap).toBe(30);
    expect(got.pregameDailyCap).toBe(DAILY_CAP.pregame);
    expect(got.budgetUsd).toBe(ENV.budgetUsd);
  });
});

describe("setXBroadcastParams", () => {
  it("真实变更写 config_history,原值重写不写 —— 审计轨迹不掺噪音", () => {
    const db = openDb(":memory:");
    const p = { ...defaultXParams(ENV), whaleDailyCap: 10 };
    setXBroadcastParams(db, p);
    setXBroadcastParams(db, p); // 同值重写
    setXBroadcastParams(db, { ...p, whaleDailyCap: 11 }); // 真实变更
    const n = db
      .prepare(
        "SELECT COUNT(*) AS n FROM config_history WHERE key = 'x_broadcast_params'",
      )
      .get() as { n: number };
    expect(n.n).toBe(2);
  });
});
