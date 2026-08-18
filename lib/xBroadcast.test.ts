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
    // 结构化布局:抬头 / 标的+方向 / 佐证 / 标签(见 lib/xComposer)。
    expect(client.posts[0]).toContain("🐳 WHALE BUY · $67K");
    expect(client.posts[0]).toContain("Chiefs win Super Bowl LX?");
    expect(client.posts[0]).toContain("└ YES @ 67¢");
    expect(client.posts[0]).toContain("📊 12% of 24h vol");
    // 赛道标签取自 marketCtx.category。
    expect(client.posts[0]).toContain("#Polymarket #Sports");
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
    expect(client.posts[0]).toMatch(/^🔥 SMART-MONEY CONSENSUS/);
    expect(client.posts[0]).toContain("#SmartMoney");
    expect(client.posts[1]).toMatch(/^🐳 WHALE BUY/);
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
    // 未富化 → 无佐证段、无赛道标签,但结构与根标签仍在。
    expect(client.posts[0]).toBe(
      "🐳 WHALE BUY · $67K\n\nChiefs win Super Bowl LX?\n└ YES @ 67¢\n\n#Polymarket",
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
    expect(client.posts[0]).toMatch(/^🔥 SMART-MONEY CONSENSUS/);
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

describe("runXBroadcastCycle —— extension 通道", () => {
  it("不发帖,只落 queued;client 一次都不该被碰", async () => {
    const db = openDb(":memory:");
    recordAlert(db, "large", "t1", whalePayload(), NOW - 60);
    const client = fakeClient();
    const posted = await runXBroadcastCycle(
      deps(db, client, { channel: "extension" }),
    );
    // 返回 0 是正确语义:本轮确实一条都没发出去(发帖动作在插件那头)。
    expect(posted).toBe(0);
    expect(client.posts).toHaveLength(0);
    const row = db
      .prepare(
        "SELECT status, channel, est_cost_usd, text, alert_id FROM x_posts",
      )
      .get() as {
      status: string;
      channel: string;
      est_cost_usd: number;
      text: string;
      alert_id: number;
    };
    expect(row.status).toBe("queued");
    expect(row.channel).toBe("extension");
    // 边际成本为零 —— 台账不能虚记开销,否则 api 通道的预算熔断会被误伤。
    expect(row.est_cost_usd).toBe(0);
    // 帖文在服务端就渲染好:插件是"哑"的,不含任何模板逻辑。
    expect(row.text).toContain("🐳 WHALE BUY · $67K");
  });

  it("第二轮不重复入队(与 api 通道共享同一个幂等键)", async () => {
    const db = openDb(":memory:");
    recordAlert(db, "large", "t1", whalePayload(), NOW - 60);
    const client = fakeClient();
    await runXBroadcastCycle(deps(db, client, { channel: "extension" }));
    await runXBroadcastCycle(deps(db, client, { channel: "extension" }));
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM x_posts").get() as { n: number }).n,
    ).toBe(1);
  });

  it("切通道不重发:api 发过的那条,切到 extension 后不会再入队", async () => {
    // 这是"两条通道共享 x_posts"的核心收益 —— 幂等键只有一份。
    const db = openDb(":memory:");
    recordAlert(db, "large", "t1", whalePayload(), NOW - 60);
    const client = fakeClient();
    expect(await runXBroadcastCycle(deps(db, client))).toBe(1);
    await runXBroadcastCycle(deps(db, client, { channel: "extension" }));
    const rows = db
      .prepare("SELECT status, channel FROM x_posts")
      .all() as { status: string; channel: string }[];
    expect(rows).toEqual([{ status: "posted", channel: "api" }]);
  });

  it("kinds 关掉的类型照样落 skipped 台账,不会每轮重扫", async () => {
    const db = openDb(":memory:");
    recordAlert(db, "large", "t1", whalePayload(), NOW - 60);
    const client = fakeClient();
    await runXBroadcastCycle(
      deps(db, client, {
        channel: "extension",
        kinds: { whale: false, consensus: true },
      }),
    );
    expect(
      (db.prepare("SELECT status FROM x_posts").get() as { status: string })
        .status,
    ).toBe("skipped");
  });

  it("caps 覆盖生效:日上限打满后落 skipped 而不是入队", async () => {
    const db = openDb(":memory:");
    // 先塞满 2 条已发,再把 cap 设成 2
    for (let i = 0; i < 2; i++) {
      db.prepare(
        `INSERT INTO x_posts (kind, dedup_key, text, has_link, est_cost_usd, status, channel, created_at)
         VALUES ('whale', ?, '', 0, 0, 'posted', 'extension', ?)`,
      ).run(`seed${i}`, NOW);
    }
    recordAlert(db, "large", "t1", whalePayload(), NOW - 60);
    const client = fakeClient();
    await runXBroadcastCycle(
      deps(db, client, {
        channel: "extension",
        caps: { whale: 2, pregame: 6 },
      }),
    );
    const row = db
      .prepare("SELECT status FROM x_posts WHERE dedup_key LIKE 'alert:%'")
      .get() as { status: string };
    expect(row.status).toBe("skipped");
  });
});
