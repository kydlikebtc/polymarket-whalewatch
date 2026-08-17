import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import {
  PENDING_TTL_SEC,
  activateAccount,
  consumePending,
  deleteAccount,
  listAccounts,
  markPosted,
  resolveXCreds,
  savePending,
  upsertAccount,
} from "./xAccounts";

const NOW = Math.floor(Date.UTC(2026, 7, 17, 12) / 1000);

function seed(db: DB, over: Partial<Parameters<typeof upsertAccount>[1]> = {}) {
  return upsertAccount(db, {
    userId: "111",
    screenName: "PolyWhaleWatch",
    accessToken: "tok1",
    accessSecret: "sec1",
    nowSec: NOW,
    ...over,
  });
}

describe("upsertAccount", () => {
  it("首个账号自动设为使用中(否则授权完还要多点一步才会发帖)", () => {
    const db = openDb(":memory:");
    seed(db);
    const rows = listAccounts(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      screenName: "PolyWhaleWatch",
      isActive: true,
    });
  });

  it("同一 user_id 重复授权=换 token,不新增行,也不改 active 归属", () => {
    const db = openDb(":memory:");
    seed(db);
    seed(db, {
      userId: "222",
      screenName: "Second",
      accessToken: "tok2",
      accessSecret: "sec2",
    });
    // 二号授权时一号已是 active → 二号不抢 active
    expect(listAccounts(db).find((a) => a.userId === "222")?.isActive).toBe(
      false,
    );
    // 一号重新授权(token 轮换)
    seed(db, {
      accessToken: "tok1b",
      accessSecret: "sec1b",
      screenName: "RenamedHandle",
    });
    const rows = listAccounts(db);
    expect(rows).toHaveLength(2);
    const first = rows.find((a) => a.userId === "111")!;
    expect(first.screenName).toBe("RenamedHandle"); // 改名后刷新
    expect(first.isActive).toBe(true);
    expect(resolveXCreds(db, {})).toMatchObject({
      accessToken: "tok1b",
      accessSecret: "sec1b",
      source: "db",
    });
  });
});

describe("activateAccount", () => {
  it("切换是排他的:全表至多一个 active", () => {
    const db = openDb(":memory:");
    seed(db);
    seed(db, {
      userId: "222",
      screenName: "Second",
      accessToken: "tok2",
      accessSecret: "sec2",
    });
    const second = listAccounts(db).find((a) => a.userId === "222")!;
    expect(activateAccount(db, second.id)).toBe(true);
    const rows = listAccounts(db);
    expect(rows.filter((a) => a.isActive).map((a) => a.userId)).toEqual([
      "222",
    ]);
    expect(activateAccount(db, 9999)).toBe(false);
  });
});

describe("deleteAccount", () => {
  it("删掉使用中的账号后,剩余账号自动顶上(不留无 active 的空窗)", () => {
    const db = openDb(":memory:");
    seed(db);
    seed(db, {
      userId: "222",
      screenName: "Second",
      accessToken: "tok2",
      accessSecret: "sec2",
    });
    const active = listAccounts(db).find((a) => a.isActive)!;
    expect(deleteAccount(db, active.id)).toBe(true);
    const rows = listAccounts(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].isActive).toBe(true);
  });
  it("删掉最后一个账号:表空,凭据回退 env", () => {
    const db = openDb(":memory:");
    seed(db);
    deleteAccount(db, listAccounts(db)[0].id);
    expect(listAccounts(db)).toEqual([]);
    expect(
      resolveXCreds(db, { xAccessToken: "envTok", xAccessSecret: "envSec" }),
    ).toMatchObject({ accessToken: "envTok", source: "env" });
  });
});

describe("pending(3-legged 中途态)", () => {
  it("一次性消费:第二次取同一个 oauth_token 必然失败(防重放)", () => {
    const db = openDb(":memory:");
    savePending(db, "reqTok", "reqSec", NOW);
    expect(consumePending(db, "reqTok", NOW)).toBe("reqSec");
    expect(consumePending(db, "reqTok", NOW)).toBeNull();
  });
  it("未知 oauth_token 一律拒绝(伪造回调无法落库)", () => {
    const db = openDb(":memory:");
    expect(consumePending(db, "neverIssued", NOW)).toBeNull();
  });
  it("超过 TTL 的 pending 视为过期", () => {
    const db = openDb(":memory:");
    savePending(db, "old", "sec", NOW);
    expect(consumePending(db, "old", NOW + PENDING_TTL_SEC + 1)).toBeNull();
  });
});

describe("resolveXCreds", () => {
  it("优先级 db active > env > null(fail-closed)", () => {
    const db = openDb(":memory:");
    expect(resolveXCreds(db, {})).toBeNull();
    expect(
      resolveXCreds(db, { xAccessToken: "e1", xAccessSecret: "e2" })?.source,
    ).toBe("env");
    seed(db);
    expect(
      resolveXCreds(db, { xAccessToken: "e1", xAccessSecret: "e2" }),
    ).toMatchObject({
      accessToken: "tok1",
      source: "db",
      screenName: "PolyWhaleWatch",
    });
  });
  it("env 只配了一半 = 没配(半套凭据发不出帖)", () => {
    const db = openDb(":memory:");
    expect(resolveXCreds(db, { xAccessToken: "e1" })).toBeNull();
  });
});

describe("markPosted", () => {
  it("记录最近发帖时刻(运营页看账号是否还在工作)", () => {
    const db = openDb(":memory:");
    seed(db);
    markPosted(db, "111", NOW + 60);
    expect(listAccounts(db)[0].lastPostAt).toBe(NOW + 60);
  });
});
