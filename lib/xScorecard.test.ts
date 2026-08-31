import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import { recordAlert } from "./seen";
import { runScorecardCycle, SCORECARD_POST_UTC_HOUR } from "./xScorecard";
import type { XClient } from "./xPublisher";

// 8-31 14:00 UTC —— 到点后发「昨天(8-30)」那张卡。
const NOW = Math.floor(Date.UTC(2026, 7, 31, 14) / 1000);
const YDAY = Math.floor(Date.UTC(2026, 7, 30) / 1000);

function fakeClient(behavior?: (text: string) => void): XClient & {
  posts: string[];
  replies: string[];
} {
  const posts: string[] = [];
  const replies: string[] = [];
  return {
    posts,
    replies,
    async postText(text) {
      behavior?.(text);
      posts.push(text);
      return `x${posts.length}`;
    },
    async postWithPng() {
      throw new Error("not used");
    },
    async replyText(text) {
      replies.push(text);
      return "r1";
    },
  };
}

/** 造一条「已发过信号帖 + 已结算」的记录。 */
function seedSettled(
  db: DB,
  o: {
    key: string;
    won: boolean;
    checkedAt: number;
    price?: number;
    side?: "BUY" | "SELL";
    title?: string;
    kind?: "whale" | "consensus";
  },
): void {
  recordAlert(
    db,
    o.kind === "consensus" ? "consensus" : "large",
    o.key,
    JSON.stringify({
      conditionId: `0x${o.key}`,
      title: o.title ?? "Will Sunderland AFC win on 2026-08-30?",
      outcome: "Yes",
      eventSlug: "ev",
      side: o.side ?? "BUY",
      size: 200_000,
      price: o.price ?? 0.4,
      avgBuyPrice: o.price ?? 0.4,
    }),
    YDAY,
  );
  const id = (
    db.prepare("SELECT id FROM alerts WHERE dedup_key = ?").get(o.key) as {
      id: number;
    }
  ).id;
  db.prepare(
    `INSERT INTO x_posts (kind, dedup_key, alert_id, text, has_link, est_cost_usd, x_post_id, status, created_at)
     VALUES (?, ?, ?, 'orig', 0, 0.015, ?, 'posted', ?)`,
  ).run(o.kind ?? "whale", `alert:${id}`, id, `190000${id}`, YDAY);
  db.prepare(
    "INSERT INTO alert_outcomes (alert_id, resolved, won, checked_at) VALUES (?, 1, ?, ?)",
  ).run(id, o.won ? 1 : 0, o.checkedAt);
}

const deps = (db: DB, client: XClient, over: Record<string, unknown> = {}) => ({
  db,
  client,
  budgetUsd: 15,
  nowSec: NOW,
  ...over,
});

describe("runScorecardCycle", () => {
  it("到点后把昨日战果聚成一条主帖(postText,不是自回复)", async () => {
    const db = openDb(":memory:");
    seedSettled(db, { key: "a1", won: true, checkedAt: YDAY + 100 });
    seedSettled(db, {
      key: "a2",
      won: false,
      checkedAt: YDAY + 200,
      title: "Will SSC Napoli win on 2026-08-30?",
    });
    const client = fakeClient();
    expect(await runScorecardCycle(deps(db, client))).toBe(true);
    expect(client.replies).toHaveLength(0);
    expect(client.posts).toHaveLength(1);
    const t = client.posts[0];
    expect(t).toContain("📋 THE CARD — Aug 30 (UTC)");
    expect(t).toContain("2 settled · 1 hit · 50%");
    // 名义回报与 thread 里那条 self-reply 逐字同源(40¢ → $1.00 = +150%)。
    expect(t).toContain("✅ +150% Will Sunderland AFC win on 2026-08-30?");
    expect(t).toContain("❌ Will SSC Napoli win on 2026-08-30?");
    const row = db
      .prepare("SELECT kind, status, est_cost_usd FROM x_posts WHERE kind = ?")
      .get("scorecard") as {
      kind: string;
      status: string;
      est_cost_usd: number;
    };
    expect(row.status).toBe("posted");
    expect(row.est_cost_usd).toBeCloseTo(0.015, 10);
  });

  it("同一天只发一次(台账 dedup)", async () => {
    const db = openDb(":memory:");
    seedSettled(db, { key: "a1", won: true, checkedAt: YDAY + 100 });
    const client = fakeClient();
    expect(await runScorecardCycle(deps(db, client))).toBe(true);
    expect(await runScorecardCycle(deps(db, client))).toBe(false);
    expect(client.posts).toHaveLength(1);
  });

  it("未到设定时刻不发", async () => {
    const db = openDb(":memory:");
    seedSettled(db, { key: "a1", won: true, checkedAt: YDAY + 100 });
    const client = fakeClient();
    expect(
      await runScorecardCycle(
        deps(db, client, {
          nowSec: Math.floor(
            Date.UTC(2026, 7, 31, SCORECARD_POST_UTC_HOUR - 1) / 1000,
          ),
        }),
      ),
    ).toBe(false);
    expect(client.posts).toHaveLength(0);
  });

  it("昨天 0 结算 → 静默(「0 settled」的成绩单比沉默更伤可信度)", async () => {
    const db = openDb(":memory:");
    // 前天结算的,不进昨天这张卡。
    seedSettled(db, { key: "old", won: true, checkedAt: YDAY - 3600 });
    const client = fakeClient();
    expect(await runScorecardCycle(deps(db, client))).toBe(false);
    expect(client.posts).toHaveLength(0);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM x_posts WHERE kind='scorecard'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("SELL 赢单不编回报率(与 self-reply 同一条纪律)", async () => {
    const db = openDb(":memory:");
    seedSettled(db, {
      key: "s1",
      won: true,
      side: "SELL",
      price: 0.8,
      checkedAt: YDAY + 100,
    });
    const client = fakeClient();
    expect(await runScorecardCycle(deps(db, client))).toBe(true);
    expect(client.posts[0]).toContain("✅ Will Sunderland AFC win");
    expect(client.posts[0]).not.toMatch(/✅ \+\d+%/);
  });

  it("永久错误标 failed,不再重试", async () => {
    const db = openDb(":memory:");
    seedSettled(db, { key: "a1", won: true, checkedAt: YDAY + 100 });
    const client = fakeClient(() => {
      throw Object.assign(new Error("403"), { code: 403 });
    });
    expect(await runScorecardCycle(deps(db, client))).toBe(false);
    expect(
      db.prepare("SELECT status FROM x_posts WHERE kind='scorecard'").get(),
    ).toEqual({ status: "failed" });
  });

  it("预算耗尽时不发(fail-closed)", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO x_posts (kind, dedup_key, text, est_cost_usd, status, created_at) VALUES ('weekly','w','t',15,'posted',?)",
    ).run(NOW - 3600);
    seedSettled(db, { key: "a1", won: true, checkedAt: YDAY + 100 });
    const client = fakeClient();
    expect(await runScorecardCycle(deps(db, client))).toBe(false);
    expect(client.posts).toHaveLength(0);
  });
});
