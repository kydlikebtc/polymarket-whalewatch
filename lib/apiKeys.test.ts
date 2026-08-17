import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import {
  issueApiKey,
  listApiKeys,
  revokeApiKey,
  verifyApiKey,
} from "./apiKeys";

// 对外信号批次 2:多租户只读密钥。明文只在签发瞬间存在(库里只有 sha256),
// 单 key 可吊销 —— 这正是放弃「env 单 token 管全部订户」的原因。

describe("apiKeys — 签发/校验/吊销", () => {
  it("签发返回明文一次,verify 往返成功并更新 last_used_at", () => {
    const db = openDb(":memory:");
    const issued = issueApiKey(db, { label: "订户A", tier: "realtime" }, 1000);
    expect(issued.key).toMatch(/^wlk_/);
    const info = verifyApiKey(db, issued.key, 2000);
    expect(info).toEqual({ id: issued.id, label: "订户A", tier: "realtime" });
    const row = db
      .prepare("SELECT last_used_at, key_hash FROM api_keys WHERE id = ?")
      .get(issued.id) as { last_used_at: number; key_hash: string };
    expect(row.last_used_at).toBe(2000);
    // 库里绝无明文。
    expect(row.key_hash).not.toContain(issued.key);
    expect(row.key_hash).toHaveLength(64); // sha256 hex
    db.close();
  });

  it("错 token / 空 token → null;两次签发的 key 互不相同", () => {
    const db = openDb(":memory:");
    const a = issueApiKey(db, { label: "a", tier: "delayed" }, 1000);
    const b = issueApiKey(db, { label: "b", tier: "delayed" }, 1000);
    expect(a.key).not.toBe(b.key);
    expect(verifyApiKey(db, "wlk_不存在", 2000)).toBeNull();
    expect(verifyApiKey(db, "", 2000)).toBeNull();
    db.close();
  });

  it("吊销即失效;重复吊销/未知 id 返回 false", () => {
    const db = openDb(":memory:");
    const issued = issueApiKey(db, { label: "a", tier: "delayed" }, 1000);
    expect(verifyApiKey(db, issued.key, 1500)).not.toBeNull();
    expect(revokeApiKey(db, issued.id, 2000)).toBe(true);
    expect(verifyApiKey(db, issued.key, 2500)).toBeNull();
    expect(revokeApiKey(db, issued.id, 3000)).toBe(false);
    expect(revokeApiKey(db, 999, 3000)).toBe(false);
    db.close();
  });

  it("未知 tier 值按 delayed 兜底(宁降级不越权)", () => {
    const db = openDb(":memory:");
    const issued = issueApiKey(db, { label: "a", tier: "realtime" }, 1000);
    db.prepare("UPDATE api_keys SET tier = 'vip???' WHERE id = ?").run(
      issued.id,
    );
    expect(verifyApiKey(db, issued.key, 2000)?.tier).toBe("delayed");
    db.close();
  });

  it("listApiKeys:无明文无 hash,含 tier/吊销态/使用时间", () => {
    const db = openDb(":memory:");
    const a = issueApiKey(db, { label: "a", tier: "realtime" }, 1000);
    issueApiKey(db, { label: "b", tier: "delayed" }, 1100);
    revokeApiKey(db, a.id, 1200);
    const rows = listApiKeys(db);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(JSON.stringify(r)).not.toContain("wlk_");
      expect(
        Object.keys(r as unknown as Record<string, unknown>),
      ).not.toContain("key_hash");
    }
    const ra = rows.find((r) => r.label === "a");
    expect(ra?.revokedAt).toBe(1200);
    db.close();
  });
});
