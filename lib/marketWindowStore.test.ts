import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import {
  loadPersistedWindow,
  persistWindow,
  prunePersistedWindows,
  PERSIST_INTERVAL_SEC,
} from "./marketWindowStore";
import type { Trade } from "./types";

const NOW = 1_700_000_000;
const CID = "0xc1";

const trade = (ts: number, hash: string): Trade => ({
  proxyWallet: "0xa",
  side: "BUY",
  asset: "1",
  conditionId: CID,
  size: 100,
  price: 0.5,
  timestamp: ts,
  title: "t",
  slug: "s",
  eventSlug: "e",
  outcome: "Yes",
  outcomeIndex: 0,
  transactionHash: hash,
});

const entry = (builtAt: number) => ({
  trades: [trade(builtAt - 10, "0xa")],
  truncated: false,
  newestTs: builtAt - 10,
  builtAt,
});

describe("marketWindowStore", () => {
  it("落库后能读回,内容一致", () => {
    const db = openDb(":memory:");
    persistWindow(db, CID, entry(NOW), NOW);
    const got = loadPersistedWindow(db, CID, NOW);
    expect(got?.newestTs).toBe(NOW - 10);
    expect(got?.trades).toHaveLength(1);
    db.close();
  });

  it("节流:间隔内的第二次写入被跳过 —— 热门市场每 30 秒落一次盘会把写放大", () => {
    const db = openDb(":memory:");
    persistWindow(db, CID, entry(NOW), NOW);
    // 第二次内容更新,但离上次落盘不足间隔。
    persistWindow(db, CID, entry(NOW + 30), NOW + 30);
    const got = loadPersistedWindow(db, CID, NOW + 30);
    expect(got?.builtAt).toBe(NOW);
    db.close();
  });

  it("超过间隔就落盘", () => {
    const db = openDb(":memory:");
    persistWindow(db, CID, entry(NOW), NOW);
    const later = NOW + PERSIST_INTERVAL_SEC;
    persistWindow(db, CID, entry(later), later);
    expect(loadPersistedWindow(db, CID, later)?.builtAt).toBe(later);
    db.close();
  });

  it("超过 24h 的存档读不出来 —— 整个窗口都已滚出下界,留着是骗人", () => {
    const db = openDb(":memory:");
    persistWindow(db, CID, entry(NOW), NOW);
    expect(loadPersistedWindow(db, CID, NOW + 25 * 3600)).toBeNull();
    db.close();
  });

  it("prune 删掉过期存档", () => {
    const db = openDb(":memory:");
    persistWindow(db, CID, entry(NOW), NOW);
    const removed = prunePersistedWindows(db, NOW + 25 * 3600);
    expect(removed).toBe(1);
    db.close();
  });

  it("合法的空窗口能读回 —— 写进去却拒绝读回来是自相矛盾", () => {
    const db = openDb(":memory:");
    // 这个市场 24h 内确实没有 $500+ 成交:空窗口是事实,不是损坏。
    // 拒绝读回它会白丢 newestTs 锚点,每次重启都退回冷启。
    persistWindow(
      db,
      CID,
      { trades: [], truncated: false, newestTs: NOW - 5, builtAt: NOW },
      NOW,
    );
    const got = loadPersistedWindow(db, CID, NOW);
    expect(got).not.toBeNull();
    expect(got?.trades).toEqual([]);
    expect(got?.newestTs).toBe(NOW - 5);
    db.close();
  });

  it("原本有行但全部解析失败 = 损坏,读成 null", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO market_window_cache (condition_id, trades_json, newest_ts, built_at, persisted_at) VALUES (?,?,?,?,?)",
    ).run(CID, JSON.stringify([{ garbage: 1 }, { junk: 2 }]), NOW, NOW, NOW);
    expect(loadPersistedWindow(db, CID, NOW)).toBeNull();
    db.close();
  });

  it("坏 JSON 读成 null,不炸 —— 一行坏存档不该让端点挂掉", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO market_window_cache (condition_id, trades_json, newest_ts, built_at, persisted_at) VALUES (?,?,?,?,?)",
    ).run(CID, "{not json", NOW, NOW, NOW);
    expect(loadPersistedWindow(db, CID, NOW)).toBeNull();
    db.close();
  });
});
