import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { dailyDensity, recordConsensusCycle } from "./cycleMetrics";

const DAY0 = 1_700_000_000; // 2023-11-14 UTC
const DAY = 86_400;

const m = (over: Record<string, number> = {}) => ({
  ts: DAY0,
  windowTrades: 500,
  windowUsd: 2_000_000,
  rawGroups: 3,
  contestedDropped: 1,
  fired: 2,
  ...over,
});

describe("recordConsensusCycle + dailyDensity", () => {
  it("按 UTC 日聚合:轮数、平均窗口量、告警合计、密度(条/$1M 窗口量)", () => {
    const db = openDb(":memory:");
    recordConsensusCycle(db, m({ ts: DAY0, windowUsd: 1_000_000, fired: 1 }));
    recordConsensusCycle(
      db,
      m({ ts: DAY0 + 300, windowUsd: 3_000_000, fired: 2 }),
    );
    recordConsensusCycle(
      db,
      m({ ts: DAY0 + DAY, windowUsd: 500_000, fired: 0 }),
    );
    const days = dailyDensity(db, { days: 14, nowSec: DAY0 + DAY + 100 });
    expect(days).toHaveLength(2);
    // 最新的日在前(看板从今天往回读)。
    const [today, yesterday] = days;
    expect(yesterday.cycles).toBe(2);
    expect(yesterday.avgWindowUsd).toBe(2_000_000); // (1M+3M)/2
    expect(yesterday.fired).toBe(3);
    // 密度 = 日告警 ÷ 平均窗口量(单位 $1M):3 ÷ 2 = 1.5 条/$1M —— 窗口滚动
    // 重叠不能求和,平均窗口量是当日市场热度的无偏代理。
    expect(yesterday.perM).toBeCloseTo(1.5);
    expect(today.cycles).toBe(1);
    expect(today.fired).toBe(0);
    expect(today.perM).toBe(0);
  });

  it("窗口量为 0 的日子密度为 0(不除零)", () => {
    const db = openDb(":memory:");
    recordConsensusCycle(db, m({ windowUsd: 0, windowTrades: 0, fired: 0 }));
    const [d] = dailyDensity(db, { days: 14, nowSec: DAY0 + 100 });
    expect(d.perM).toBe(0);
  });

  it("超出天数窗口的旧行不参与聚合", () => {
    const db = openDb(":memory:");
    recordConsensusCycle(db, m({ ts: DAY0 - 20 * DAY }));
    recordConsensusCycle(db, m({ ts: DAY0 }));
    expect(dailyDensity(db, { days: 14, nowSec: DAY0 + 100 })).toHaveLength(1);
  });

  it("发现渠道日产出并入(wallet_candidates.created_at 零新增采集)", () => {
    const db = openDb(":memory:");
    recordConsensusCycle(db, m({ ts: DAY0 }));
    recordConsensusCycle(db, m({ ts: DAY0 + DAY }));
    const ins = db.prepare(
      `INSERT INTO wallet_candidates (address, channel, condition_id, evidence_ts, created_at)
       VALUES (?, 'echo', ?, ?, ?)`,
    );
    ins.run("0xa", "0xc1", DAY0, DAY0 + 100);
    ins.run("0xb", "0xc2", DAY0, DAY0 + 200);
    ins.run("0xc", "0xc3", DAY0, DAY0 + DAY + 100); // 次日
    const [today, yesterday] = dailyDensity(db, {
      days: 14,
      nowSec: DAY0 + DAY + 300,
    });
    expect(yesterday.evidenceNew).toBe(2);
    expect(today.evidenceNew).toBe(1);
  });

  it("互斥剔除数与原始组数按日合计(阈值重校的证据列)", () => {
    const db = openDb(":memory:");
    recordConsensusCycle(db, m({ rawGroups: 4, contestedDropped: 2 }));
    recordConsensusCycle(
      db,
      m({ ts: DAY0 + 300, rawGroups: 1, contestedDropped: 0 }),
    );
    const [d] = dailyDensity(db, { days: 14, nowSec: DAY0 + 400 });
    expect(d.rawGroups).toBe(5);
    expect(d.contestedDropped).toBe(2);
  });
});
