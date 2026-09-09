import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "./db";
import {
  CONSENSUS_WINDOW_MODE_KEY,
  getConsensusWindowMode,
  listConsensusWindowModeHistory,
  setConsensusWindowMode,
} from "./engineSettings";

// consensus_window_mode 的读写语义。读取端(worker/embeddedEngine getMode)
// 和写入端(/api/admin/engine)共用这一份 —— 这里钉死的判读规则就是引擎
// 每轮实际执行的判读规则。

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

const rawValue = (): string | null | undefined =>
  (
    db
      .prepare("SELECT value FROM config WHERE key = ?")
      .get(CONSENSUS_WINDOW_MODE_KEY) as { value: string | null } | undefined
  )?.value;

describe("getConsensusWindowMode", () => {
  it("缺行 = 增量(出厂默认,config 表从没写过也能读)", () => {
    expect(getConsensusWindowMode(db)).toBe("incremental");
  });

  it("只有精确值 'full' 是全量 —— 大小写/空格/别字一律回增量,坏配置不改变引擎行为", () => {
    for (const v of ["FULL", " full", "full ", "fulll", "incremental", ""]) {
      db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
        CONSENSUS_WINDOW_MODE_KEY,
        v,
      );
      expect(getConsensusWindowMode(db), `value=${JSON.stringify(v)}`).toBe(
        "incremental",
      );
    }
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
      CONSENSUS_WINDOW_MODE_KEY,
      "full",
    );
    expect(getConsensusWindowMode(db)).toBe("full");
  });
});

describe("setConsensusWindowMode", () => {
  it("写 'full' 后读回全量,config_history 留痕一笔", () => {
    setConsensusWindowMode(db, "full");
    expect(getConsensusWindowMode(db)).toBe("full");
    expect(rawValue()).toBe("full");
    const hist = listConsensusWindowModeHistory(db);
    expect(hist).toHaveLength(1);
    expect(hist[0].value).toBe("full");
    expect(hist[0].changedAt).toBeGreaterThan(0);
  });

  it("幂等重写不刷历史 —— 留痕的是变更,不是每次点击", () => {
    setConsensusWindowMode(db, "full");
    setConsensusWindowMode(db, "full");
    setConsensusWindowMode(db, "full");
    expect(listConsensusWindowModeHistory(db)).toHaveLength(1);
    expect(getConsensusWindowMode(db)).toBe("full");
  });

  it("来回切换逐笔留痕,新在前", () => {
    setConsensusWindowMode(db, "full");
    setConsensusWindowMode(db, "incremental");
    setConsensusWindowMode(db, "full");
    const hist = listConsensusWindowModeHistory(db);
    expect(hist.map((h) => h.value)).toEqual(["full", "incremental", "full"]);
  });

  it("写 'incremental' 覆盖手写的野值并留痕(修复也是一次值得记录的变更)", () => {
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
      CONSENSUS_WINDOW_MODE_KEY,
      "garbage",
    );
    setConsensusWindowMode(db, "incremental");
    expect(rawValue()).toBe("incremental");
    expect(listConsensusWindowModeHistory(db)).toHaveLength(1);
  });

  it("limit 生效且不吃别的键的历史", () => {
    db.prepare(
      "INSERT INTO config_history (key, value, changed_at) VALUES (?, ?, ?)",
    ).run("other_key", "x", 1);
    for (let i = 0; i < 7; i++) {
      setConsensusWindowMode(db, i % 2 === 0 ? "full" : "incremental");
    }
    expect(listConsensusWindowModeHistory(db, 3)).toHaveLength(3);
    expect(listConsensusWindowModeHistory(db, 10)).toHaveLength(7);
  });
});
