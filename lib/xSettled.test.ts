import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import { recordAlert } from "./seen";
import { runSettledCycle, SETTLED_MAX_AGE_SEC } from "./xSettled";
import type { XClient } from "./xPublisher";

const NOW = Math.floor(Date.UTC(2026, 7, 18, 12) / 1000);

function fakeClient(
  behavior?: (text: string, replyTo: string) => void,
): XClient & {
  replies: { text: string; replyTo: string }[];
  posts: string[];
} {
  const replies: { text: string; replyTo: string }[] = [];
  const posts: string[] = [];
  return {
    replies,
    posts,
    async postText(text) {
      posts.push(text);
      return `p${posts.length}`;
    },
    async postWithPng() {
      throw new Error("not used");
    },
    async replyText(text, replyTo) {
      behavior?.(text, replyTo);
      replies.push({ text, replyTo });
      return `r${replies.length}`;
    },
  };
}

/** 造一条「已发过帖 + 已结算」的信号。 */
function seedSignal(
  db: DB,
  opts: {
    alertKey: string;
    xPostId: string;
    won: boolean;
    price?: number;
    postedAt?: number;
    kind?: "whale" | "consensus";
    type?: string;
    payload?: Record<string, unknown>;
  },
): number {
  const type = opts.type ?? "large";
  recordAlert(
    db,
    type,
    opts.alertKey,
    JSON.stringify(
      opts.payload ?? {
        conditionId: "0xc1",
        title: "Baltimore Orioles vs. Tampa Bay Rays",
        outcome: "Baltimore Orioles",
        eventSlug: "mlb-ev",
        side: "BUY",
        size: 300_000,
        price: opts.price ?? 0.4,
      },
    ),
    NOW - 3600,
  );
  const id = (
    db
      .prepare("SELECT id FROM alerts WHERE dedup_key = ?")
      .get(opts.alertKey) as {
      id: number;
    }
  ).id;
  db.prepare(
    `INSERT INTO x_posts (kind, dedup_key, alert_id, text, has_link, est_cost_usd, x_post_id, status, created_at)
     VALUES (?, ?, ?, 'orig', 0, 0.015, ?, 'posted', ?)`,
  ).run(
    opts.kind ?? "whale",
    `alert:${id}`,
    id,
    opts.xPostId,
    opts.postedAt ?? NOW - 3600,
  );
  db.prepare(
    "INSERT INTO alert_outcomes (alert_id, resolved, won, checked_at) VALUES (?, 1, ?, ?)",
  ).run(id, opts.won ? 1 : 0, NOW);
  return id;
}

const deps = (db: DB, client: XClient, over: Record<string, unknown> = {}) => ({
  db,
  client,
  budgetUsd: 15,
  nowSec: NOW,
  ...over,
});

describe("runSettledCycle", () => {
  it("回复自己那条原帖,带上结果与名义回报", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO event_category (event_slug, category, subcategory, fetched_at) VALUES ('mlb-ev','Sports','MLB',100)",
    ).run();
    seedSignal(db, { alertKey: "t1", xPostId: "1900000001", won: true });
    const client = fakeClient();
    expect(await runSettledCycle(deps(db, client))).toBe(1);
    // in_reply_to 必须是我们自己发过的那条 —— 这是红线,绝不回复他人。
    expect(client.replies[0].replyTo).toBe("1900000001");
    // 调用点尚未传 signalKind/postedAgoSec(Task 10)→ └ 行是退化形态。
    expect(client.replies[0].text).toBe(
      "✅ CALLED IT · 40¢ → $1.00 (+150%)\n\n" +
        "Baltimore Orioles vs. Tampa Bay Rays\n" +
        "└ Signal on Baltimore Orioles\n\n" +
        "#Polymarket #MLB",
    );
  });

  it("输单照发 —— 只发赢的会让「just the record」当场破产", async () => {
    const db = openDb(":memory:");
    seedSignal(db, { alertKey: "t1", xPostId: "1900000002", won: false });
    const client = fakeClient();
    expect(await runSettledCycle(deps(db, client))).toBe(1);
    expect(client.replies[0].text).toContain("❌ MISSED · 40¢ → $0");
    expect(client.replies[0].text).toContain(
      "We post every result, wins and losses.",
    );
  });

  it("同一条信号只回一次(台账去重)", async () => {
    const db = openDb(":memory:");
    seedSignal(db, { alertKey: "t1", xPostId: "1900000003", won: true });
    const client = fakeClient();
    expect(await runSettledCycle(deps(db, client))).toBe(1);
    expect(await runSettledCycle(deps(db, client))).toBe(0);
    expect(client.replies).toHaveLength(1);
  });

  it("未结算的信号不发", async () => {
    const db = openDb(":memory:");
    const id = seedSignal(db, {
      alertKey: "t1",
      xPostId: "1900000004",
      won: true,
    });
    db.prepare(
      "UPDATE alert_outcomes SET resolved = 0, won = NULL WHERE alert_id = ?",
    ).run(id);
    const client = fakeClient();
    expect(await runSettledCycle(deps(db, client))).toBe(0);
  });

  it("原帖没成功发出去(status≠posted / 无 post id)时不回", async () => {
    const db = openDb(":memory:");
    const id = seedSignal(db, {
      alertKey: "t1",
      xPostId: "1900000005",
      won: true,
    });
    db.prepare("UPDATE x_posts SET status='failed' WHERE alert_id = ?").run(id);
    const client = fakeClient();
    expect(await runSettledCycle(deps(db, client))).toBe(0);
  });

  it("超出时效窗口的老帖不再补 —— 读者早刷过去了,别浪费预算", async () => {
    const db = openDb(":memory:");
    seedSignal(db, {
      alertKey: "t1",
      xPostId: "1900000006",
      won: true,
      postedAt: NOW - SETTLED_MAX_AGE_SEC - 3600,
    });
    const client = fakeClient();
    expect(await runSettledCycle(deps(db, client))).toBe(0);
  });

  it("共识帖的入场价取聚钱均价,与原帖公布的那个数一致", async () => {
    const db = openDb(":memory:");
    seedSignal(db, {
      alertKey: "c1",
      xPostId: "1900000007",
      won: true,
      kind: "consensus",
      type: "consensus",
      payload: {
        conditionId: "0xc9",
        title: "Fed cut rates in September?",
        outcome: "Yes",
        walletCount: 2,
        totalNetUsd: 18_400,
        avgBuyPrice: 0.58,
      },
    });
    const client = fakeClient();
    await runSettledCycle(deps(db, client));
    // 58¢ → $1 = +72%
    expect(client.replies[0].text).toContain("58¢ → $1.00 (+72%)");
    expect(client.replies[0].text).toContain("└ Signal on YES");
  });

  it("预算耗尽时不发,也不落 skipped(配额是全局闸,明天还该补)", async () => {
    const db = openDb(":memory:");
    seedSignal(db, { alertKey: "t1", xPostId: "1900000008", won: true });
    const client = fakeClient();
    expect(await runSettledCycle(deps(db, client, { budgetUsd: 0 }))).toBe(0);
    // 预算恢复后仍能补发。
    expect(await runSettledCycle(deps(db, client))).toBe(1);
  });

  it("永久错误(原帖被删)标 failed 不重试;瞬态错误回滚 claim 并抛出", async () => {
    const db = openDb(":memory:");
    seedSignal(db, { alertKey: "t1", xPostId: "1900000009", won: true });
    const permanent = fakeClient(() => {
      throw Object.assign(new Error("gone"), { code: 404 });
    });
    expect(await runSettledCycle(deps(db, permanent))).toBe(0);
    const row = db
      .prepare("SELECT status FROM x_posts WHERE kind='settled'")
      .get() as { status: string };
    expect(row.status).toBe("failed");

    const db2 = openDb(":memory:");
    seedSignal(db2, { alertKey: "t2", xPostId: "1900000010", won: true });
    const transient = fakeClient(() => {
      throw Object.assign(new Error("rate limited"), { code: 429 });
    });
    await expect(runSettledCycle(deps(db2, transient))).rejects.toThrow();
    // claim 已回滚 → 下轮可重试。
    expect(
      db2
        .prepare("SELECT COUNT(*) AS n FROM x_posts WHERE kind='settled'")
        .get(),
    ).toEqual({ n: 0 });
  });
});

describe("卖单方向不被写反", () => {
  it("SELL 信号的战报按空头口径写,不套买入公式", async () => {
    const db = openDb(":memory:");
    seedSignal(db, {
      alertKey: "s1",
      xPostId: "1900000011",
      won: true,
      payload: {
        conditionId: "0xc7",
        title: "The Hundred, Women: Welsh Fire vs London Spirit",
        outcome: "Welsh Fire",
        eventSlug: "cricket-ev",
        side: "SELL",
        size: 60_000,
        price: 0.9,
      },
    });
    const client = fakeClient();
    await runSettledCycle(deps(db, client));
    expect(client.replies[0].text).toContain("sold 90¢ → $0.00");
    expect(client.replies[0].text).not.toContain("%");
  });
});
