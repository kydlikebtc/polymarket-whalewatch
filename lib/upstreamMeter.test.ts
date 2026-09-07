import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { openDb, type DB } from "./db";
import {
  BUCKET_SEC,
  MAX_PENDING,
  RETENTION_SEC,
  flushUpstreamMeter,
  maybeFlushUpstreamMeter,
  pendingUpstreamRows,
  readUpstreamStats,
  recordUpstreamCall,
  resetUpstreamFlushClock,
  resetUpstreamMeter,
} from "./upstreamMeter";

function memDb(): DB {
  // openDb 建表 + 迁移;":memory:" 让每个用例拿到干净的一份。
  return openDb(":memory:") as unknown as DB;
}

const T0 = 1_757_000_000; // 桶对齐由被测代码负责,这里给个任意时刻

describe("upstreamMeter 记录侧", () => {
  beforeEach(() => resetUpstreamMeter());
  afterEach(() => {
    resetUpstreamMeter();
    resetUpstreamFlushClock();
  });

  it("按 (分钟桶, 标签) 累加,同桶同标签合并成一行", () => {
    recordUpstreamCall({ label: "a", ms: 10, status: 200, transient: false, nowSec: T0 });
    recordUpstreamCall({ label: "a", ms: 20, status: 200, transient: false, nowSec: T0 + 5 });
    recordUpstreamCall({ label: "b", ms: 30, status: 200, transient: false, nowSec: T0 });
    expect(pendingUpstreamRows()).toBe(2);
  });

  it("跨分钟桶分行 —— 速率读数要看得出突发", () => {
    recordUpstreamCall({ label: "a", ms: 1, status: 200, transient: false, nowSec: T0 });
    recordUpstreamCall({
      label: "a",
      ms: 1,
      status: 200,
      transient: false,
      nowSec: T0 + BUCKET_SEC,
    });
    expect(pendingUpstreamRows()).toBe(2);
  });

  it("429 同时计入 rateLimited 与 transient,抛出计入 errors", () => {
    const db = memDb();
    recordUpstreamCall({ label: "x", ms: 5, status: 429, transient: true, nowSec: T0 });
    recordUpstreamCall({ label: "x", ms: 7, status: null, transient: true, nowSec: T0 });
    flushUpstreamMeter(db, T0);
    const s = readUpstreamStats(db, { nowSec: T0 });
    expect(s.window.calls).toBe(2);
    expect(s.window.rateLimited).toBe(1);
    expect(s.window.errors).toBe(1);
    expect(s.window.transient).toBe(2);
    expect(s.window.ms).toBe(12);
    db.close();
  });

  it("空标签落到 unlabeled,超长标签截断而不是丢弃", () => {
    const db = memDb();
    recordUpstreamCall({ label: "", ms: 1, status: 200, transient: false, nowSec: T0 });
    recordUpstreamCall({
      label: "x".repeat(200),
      ms: 1,
      status: 200,
      transient: false,
      nowSec: T0,
    });
    flushUpstreamMeter(db, T0);
    const labels = readUpstreamStats(db, { nowSec: T0 }).topLabels.map((l) => l.label);
    expect(labels).toContain("unlabeled");
    expect(labels.some((l) => l.startsWith("xxx") && l.length <= 40)).toBe(true);
    db.close();
  });

  it("内存有界:触顶后丢新键而不是无限增长(独立 Next 进程没人 flush 的情形)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < MAX_PENDING + 50; i++) {
      recordUpstreamCall({
        label: `l${i}`,
        ms: 1,
        status: 200,
        transient: false,
        nowSec: T0,
      });
    }
    expect(pendingUpstreamRows()).toBe(MAX_PENDING);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("记录函数永不抛 —— 计量不该弄坏被计量的请求", () => {
    expect(() =>
      recordUpstreamCall({
        label: "x",
        ms: Number.NaN,
        status: 200,
        transient: false,
        nowSec: T0,
      }),
    ).not.toThrow();
  });
});

describe("upstreamMeter 落盘侧", () => {
  beforeEach(() => {
    resetUpstreamMeter();
    resetUpstreamFlushClock();
  });
  afterEach(() => resetUpstreamMeter());

  it("flush 后内存清空,再 flush 是 no-op", () => {
    const db = memDb();
    recordUpstreamCall({ label: "a", ms: 1, status: 200, transient: false, nowSec: T0 });
    expect(flushUpstreamMeter(db, T0)).toBe(1);
    expect(pendingUpstreamRows()).toBe(0);
    expect(flushUpstreamMeter(db, T0)).toBe(0);
    db.close();
  });

  it("同一桶被 flush 两次是加法,不是覆盖 —— 两个进程同写也对", () => {
    const db = memDb();
    recordUpstreamCall({ label: "a", ms: 10, status: 200, transient: false, nowSec: T0 });
    flushUpstreamMeter(db, T0);
    recordUpstreamCall({ label: "a", ms: 10, status: 200, transient: false, nowSec: T0 + 1 });
    flushUpstreamMeter(db, T0 + 1);
    const s = readUpstreamStats(db, { nowSec: T0 });
    expect(s.window.calls).toBe(2);
    expect(s.window.ms).toBe(20);
    db.close();
  });

  it("落盘失败不抛,且不把读数重排回内存(否则写不进的库会把内存撑满)", () => {
    const broken = {
      prepare: () => {
        throw new Error("disk I/O error");
      },
      transaction: () => () => {},
    } as unknown as DB;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    recordUpstreamCall({ label: "a", ms: 1, status: 200, transient: false, nowSec: T0 });
    expect(flushUpstreamMeter(broken, T0)).toBe(0);
    expect(pendingUpstreamRows()).toBe(0);
    err.mockRestore();
  });

  it("maybeFlush 按 30s 节流", () => {
    const db = memDb();
    recordUpstreamCall({ label: "a", ms: 1, status: 200, transient: false, nowSec: T0 });
    expect(maybeFlushUpstreamMeter(db, T0)).toBe(1);
    recordUpstreamCall({ label: "a", ms: 1, status: 200, transient: false, nowSec: T0 + 5 });
    expect(maybeFlushUpstreamMeter(db, T0 + 5)).toBe(0);
    expect(pendingUpstreamRows()).toBe(1); // 还挂在内存里,没丢
    expect(maybeFlushUpstreamMeter(db, T0 + 40)).toBe(1);
    db.close();
  });

  it("保留期外的桶被清掉,每小时至多清一次", () => {
    const db = memDb();
    const raw = db as unknown as Database.Database;
    raw
      .prepare(
        "INSERT INTO upstream_calls (bucket, label, calls) VALUES (?, 'old', 5)",
      )
      .run(T0 - RETENTION_SEC - 3600);
    recordUpstreamCall({ label: "a", ms: 1, status: 200, transient: false, nowSec: T0 });
    flushUpstreamMeter(db, T0);
    const left = raw
      .prepare("SELECT COUNT(*) AS n FROM upstream_calls WHERE label = 'old'")
      .get() as { n: number };
    expect(left.n).toBe(0);
    db.close();
  });
});

describe("readUpstreamStats", () => {
  beforeEach(() => {
    resetUpstreamMeter();
    resetUpstreamFlushClock();
  });
  afterEach(() => resetUpstreamMeter());

  it("空表返回全零而不是抛 —— 引擎没跑过也要能渲染", () => {
    const db = memDb();
    const s = readUpstreamStats(db, { nowSec: T0 });
    expect(s.window.calls).toBe(0);
    expect(s.callsPerMin).toBe(0);
    expect(s.latestBucket).toBeNull();
    expect(s.topLabels).toEqual([]);
    db.close();
  });

  it("速率的分母是整个窗口,不是「有行的分钟数」", () => {
    const db = memDb();
    // 60 次调用全挤在一分钟里,窗口 60 分钟 → 1 次/分,而不是 60 次/分。
    for (let i = 0; i < 60; i++) {
      recordUpstreamCall({ label: "a", ms: 1, status: 200, transient: false, nowSec: T0 });
    }
    flushUpstreamMeter(db, T0);
    const s = readUpstreamStats(db, { nowSec: T0, windowMin: 60 });
    expect(s.window.calls).toBe(60);
    expect(s.callsPerMin).toBeCloseTo(1, 6);
    db.close();
  });

  it("窗口外的行不进窗口合计,但仍进 24h 合计", () => {
    const db = memDb();
    recordUpstreamCall({
      label: "old",
      ms: 1,
      status: 200,
      transient: false,
      nowSec: T0 - 3 * 3600,
    });
    recordUpstreamCall({ label: "new", ms: 1, status: 200, transient: false, nowSec: T0 });
    flushUpstreamMeter(db, T0);
    const s = readUpstreamStats(db, { nowSec: T0, windowMin: 60 });
    expect(s.window.calls).toBe(1);
    expect(s.day.calls).toBe(2);
    expect(s.topLabels.map((l) => l.label)).toEqual(["new"]);
    db.close();
  });

  it("topLabels 按调用数降序,最多 5 个", () => {
    const db = memDb();
    for (let i = 0; i < 8; i++) {
      for (let n = 0; n <= i; n++) {
        recordUpstreamCall({
          label: `l${i}`,
          ms: 1,
          status: 200,
          transient: false,
          nowSec: T0,
        });
      }
    }
    flushUpstreamMeter(db, T0);
    const s = readUpstreamStats(db, { nowSec: T0 });
    expect(s.topLabels).toHaveLength(5);
    expect(s.topLabels[0].label).toBe("l7");
    expect(s.topLabels[0].calls).toBe(8);
    db.close();
  });
});
