import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import { recordAlert } from "./seen";
import { runXBroadcastCycle, X_POST_MAX_AGE_SEC } from "./xBroadcast";
import type { XClient } from "./xPublisher";

const NOW = Math.floor(Date.UTC(2026, 7, 15, 12) / 1000);

function fakeClient(behavior?: (text: string) => void): XClient & {
  posts: string[];
} {
  const posts: string[] = [];
  return {
    posts,
    async postText(text) {
      behavior?.(text);
      posts.push(text);
      return `x${posts.length}`;
    },
    async postWithPng() {
      throw new Error("not used in broadcast");
    },
  };
}

// Trade payload 与 alertEngine 落库形状一致({...Trade, marketCtx?, params})。
function whalePayload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    proxyWallet: "0xabc",
    side: "BUY",
    asset: "tok1",
    conditionId: "0xc1",
    size: 100_000,
    price: 0.67,
    timestamp: NOW - 60,
    title: "Chiefs win Super Bowl LX?",
    slug: "chiefs",
    eventSlug: "sb",
    outcome: "Yes",
    outcomeIndex: 0,
    transactionHash: "0xt",
    marketCtx: {
      impact24h: 0.12,
      liquidityShare: 0.1,
      liquidity: 229_000,
      volume24hr: 500_000,
      hoursToEnd: 5,
      category: "Sports",
    },
    params: { minUsd: 10000 },
    ...over,
  });
}

function deps(db: DB, client: XClient, over: Record<string, unknown> = {}) {
  return {
    db,
    client,
    budgetUsd: 15,
    minTradeUsd: 50_000,
    nowSec: NOW,
    ...over,
  };
}

describe("runXBroadcastCycle", () => {
  it("posts a fresh whale alert once and never again (x_posts ledger)", async () => {
    const db = openDb(":memory:");
    recordAlert(db, "large", "t1", whalePayload(), NOW - 60);
    const client = fakeClient();
    expect(await runXBroadcastCycle(deps(db, client))).toBe(1);
    expect(client.posts[0]).toContain(
      '🐳 $67K YES on "Chiefs win Super Bowl LX?" @ 67¢',
    );
    expect(client.posts[0]).toContain("12% of 24h vol");
    const row = db
      .prepare("SELECT status, x_post_id, est_cost_usd, alert_id FROM x_posts")
      .get() as {
      status: string;
      x_post_id: string;
      est_cost_usd: number;
      alert_id: number;
    };
    expect(row.status).toBe("posted");
    expect(row.x_post_id).toBe("x1");
    expect(row.est_cost_usd).toBeCloseTo(0.015, 10);
    // 第二轮:同一告警不再发。
    expect(await runXBroadcastCycle(deps(db, client))).toBe(0);
    expect(client.posts).toHaveLength(1);
  });

  it("skips whales below X_MIN_TRADE_USD with a ledger row (no repeat scans)", async () => {
    const db = openDb(":memory:");
    recordAlert(
      db,
      "large",
      "small",
      whalePayload({ size: 20_000, price: 1 }),
      NOW - 60,
    );
    const client = fakeClient();
    expect(
      await runXBroadcastCycle(deps(db, client, { minTradeUsd: 50_000 })),
    ).toBe(0);
    expect(client.posts).toHaveLength(0);
    const row = db.prepare("SELECT status FROM x_posts").get() as {
      status: string;
    };
    expect(row.status).toBe("skipped");
  });

  it("posts consensus alerts BEFORE whales (priority) using the consensus template", async () => {
    const db = openDb(":memory:");
    recordAlert(db, "large", "t1", whalePayload(), NOW - 120);
    recordAlert(
      db,
      "consensus",
      "consensus:0xc2:Yes:3",
      JSON.stringify({
        conditionId: "0xc2",
        title: "Fed cut in Sept?",
        outcome: "Yes",
        walletCount: 3,
        totalNetUsd: 92_000,
        params: {},
      }),
      NOW - 30,
    );
    const client = fakeClient();
    expect(await runXBroadcastCycle(deps(db, client))).toBe(2);
    expect(client.posts[0]).toMatch(/^🔥 CONSENSUS: 3 top-PnL wallets/);
    expect(client.posts[1]).toMatch(/^🐳/);
  });

  it("stops posting when the monthly budget is exhausted (fail-closed)", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO x_posts (kind, dedup_key, text, est_cost_usd, status, created_at) VALUES ('weekly','w','t',15,'posted',?)",
    ).run(NOW - 3600);
    recordAlert(db, "large", "t1", whalePayload(), NOW - 60);
    const client = fakeClient();
    expect(await runXBroadcastCycle(deps(db, client))).toBe(0);
    expect(client.posts).toHaveLength(0);
    const row = db
      .prepare("SELECT status FROM x_posts WHERE kind='whale'")
      .get() as { status: string };
    expect(row.status).toBe("skipped");
  });

  it("transient send failure rolls the claim back, rethrows, and retries next cycle", async () => {
    const db = openDb(":memory:");
    recordAlert(db, "large", "t1", whalePayload(), NOW - 60);
    let fail = true;
    const client = fakeClient(() => {
      if (fail) throw Object.assign(new Error("503"), { code: 503 });
    });
    await expect(runXBroadcastCycle(deps(db, client))).rejects.toThrow("503");
    // claim 已回滚 —— 台账无残留,预算不被幽灵行占用。
    expect(db.prepare("SELECT COUNT(*) AS n FROM x_posts").get()).toEqual({
      n: 0,
    });
    fail = false;
    expect(await runXBroadcastCycle(deps(db, client))).toBe(1);
    expect(client.posts).toHaveLength(1);
  });

  it("permanent failure keeps the claim as failed (poison post cannot jam the queue)", async () => {
    const db = openDb(":memory:");
    recordAlert(db, "large", "bad", whalePayload(), NOW - 90);
    recordAlert(
      db,
      "large",
      "good",
      whalePayload({ title: "Second market" }),
      NOW - 60,
    );
    let first = true;
    const client = fakeClient(() => {
      if (first) {
        first = false;
        throw Object.assign(new Error("403"), { code: 403 });
      }
    });
    // 毒帖不中断本轮 —— 第二条照发。
    expect(await runXBroadcastCycle(deps(db, client))).toBe(1);
    const statuses = db
      .prepare("SELECT status FROM x_posts ORDER BY id")
      .all() as { status: string }[];
    expect(statuses.map((r) => r.status).sort()).toEqual(["failed", "posted"]);
    // 下一轮不再碰 failed 行。
    expect(await runXBroadcastCycle(deps(db, client))).toBe(0);
  });

  it("ignores alerts older than the freshness window (no backlog storm after downtime)", async () => {
    const db = openDb(":memory:");
    recordAlert(
      db,
      "large",
      "old",
      whalePayload(),
      NOW - X_POST_MAX_AGE_SEC - 10,
    );
    const client = fakeClient();
    expect(await runXBroadcastCycle(deps(db, client))).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM x_posts").get()).toEqual({
      n: 0,
    });
  });

  it("marks unparseable payloads skipped instead of crashing the cycle", async () => {
    const db = openDb(":memory:");
    recordAlert(db, "large", "junk", "not-json{", NOW - 60);
    recordAlert(db, "large", "good", whalePayload(), NOW - 50);
    const client = fakeClient();
    expect(await runXBroadcastCycle(deps(db, client))).toBe(1);
    const statuses = db
      .prepare("SELECT status FROM x_posts ORDER BY id")
      .all() as { status: string }[];
    expect(statuses.map((r) => r.status).sort()).toEqual(["posted", "skipped"]);
  });

  it("un-enriched whale payload (no marketCtx) still posts the first line", async () => {
    const db = openDb(":memory:");
    const p = JSON.parse(whalePayload()) as Record<string, unknown>;
    delete p.marketCtx;
    recordAlert(db, "smart", "t1", JSON.stringify(p), NOW - 60);
    const client = fakeClient();
    expect(await runXBroadcastCycle(deps(db, client))).toBe(1);
    expect(client.posts[0]).toBe(
      '🐳 $67K YES on "Chiefs win Super Bowl LX?" @ 67¢',
    );
  });

  it("类型开关关掉的那类不发,并落 skipped 台账(不重扫、不在重开时补发旧内容)", async () => {
    const db = openDb(":memory:");
    recordAlert(db, "large", "w1", whalePayload(), NOW - 120);
    recordAlert(
      db,
      "consensus",
      "consensus:0xc2:Yes:3",
      JSON.stringify({
        conditionId: "0xc2",
        title: "Fed cut in Sept?",
        outcome: "Yes",
        walletCount: 3,
        totalNetUsd: 92_000,
        params: {},
      }),
      NOW - 30,
    );
    const client = fakeClient();
    // 只关大单:共识照发。
    expect(
      await runXBroadcastCycle(
        deps(db, client, { kinds: { whale: false, consensus: true } }),
      ),
    ).toBe(1);
    expect(client.posts[0]).toMatch(/^🔥 CONSENSUS/);
    const rows = db
      .prepare("SELECT kind, status FROM x_posts ORDER BY kind")
      .all() as { kind: string; status: string }[];
    expect(rows).toEqual([
      { kind: "consensus", status: "posted" },
      { kind: "whale", status: "skipped" },
    ]);
    // 重新开启后不补发那条旧大单(台账行已在)。
    expect(
      await runXBroadcastCycle(db && deps(db, client, { kinds: undefined })),
    ).toBe(0);
    expect(client.posts).toHaveLength(1);
  });
});
