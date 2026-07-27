import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import { beat, getHeartbeats, maybeDailySelfCheck } from "./heartbeat";

const DAY0 = 1_700_000_000; // 2023-11-14T22:13:20Z
const utcDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

describe("beat", () => {
  it("记录每轮心跳:同日累计轮数并跟踪最长间隔", () => {
    const db = openDb(":memory:");
    beat(db, "alert", DAY0);
    beat(db, "alert", DAY0 + 4);
    beat(db, "alert", DAY0 + 604); // 10 分钟断档
    const [h] = getHeartbeats(db);
    expect(h.loop).toBe("alert");
    expect(h.lastTs).toBe(DAY0 + 604);
    expect(h.cycles).toBe(3);
    expect(h.maxGapSec).toBe(600);
    expect(h.day).toBe(utcDay(DAY0));
  });

  it("跨 UTC 日重置轮数与最长间隔(隔夜间隔不计入新的一天)", () => {
    const db = openDb(":memory:");
    beat(db, "consensus", DAY0);
    const nextDay = DAY0 + 86_400;
    beat(db, "consensus", nextDay);
    const [h] = getHeartbeats(db);
    expect(h.cycles).toBe(1);
    expect(h.maxGapSec).toBe(0);
    expect(h.day).toBe(utcDay(nextDay));
  });

  it("多循环各自独立计数", () => {
    const db = openDb(":memory:");
    beat(db, "alert", DAY0);
    beat(db, "alert", DAY0 + 4);
    beat(db, "outcome_backfill", DAY0);
    const map = new Map(getHeartbeats(db).map((h) => [h.loop, h]));
    expect(map.get("alert")?.cycles).toBe(2);
    expect(map.get("outcome_backfill")?.cycles).toBe(1);
  });
});

describe("maybeDailySelfCheck", () => {
  it("每 UTC 日推送一次自检消息(循环轮数/告警数/最长间隔),同日不重复", async () => {
    const db = openDb(":memory:");
    beat(db, "alert", DAY0);
    beat(db, "alert", DAY0 + 700); // 最长间隔 700s ≈ 12 分钟
    db.prepare(
      "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES ('large', 'k1', '{}', ?)",
    ).run(DAY0);
    const send = vi.fn().mockResolvedValue(undefined);
    await maybeDailySelfCheck(db, send, DAY0 + 800);
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as string;
    expect(msg).toContain("自检");
    expect(msg).toContain("alert 2 轮"); // 循环轮数
    expect(msg).toContain("告警 1 条");
    expect(msg).toContain("12 分钟"); // 最长间隔取整分钟
    // 同一 UTC 日再调 → 静默。
    await maybeDailySelfCheck(db, send, DAY0 + 900);
    expect(send).toHaveBeenCalledTimes(1);
    // 次日 → 再推。
    await maybeDailySelfCheck(db, send, DAY0 + 86_400 + 100);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("无 send(Telegram 未配置)→ 不标记不推送,配置后当天仍能补推", async () => {
    const db = openDb(":memory:");
    beat(db, "alert", DAY0);
    await maybeDailySelfCheck(db, undefined, DAY0 + 100);
    const send = vi.fn().mockResolvedValue(undefined);
    await maybeDailySelfCheck(db, send, DAY0 + 200);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
