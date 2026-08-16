import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import { recordAlert } from "./seen";
import { runPregameCycle } from "./xPregame";
import type { XClient } from "./xPublisher";
import type { MarketMeta } from "./gamma";

const NOW = Math.floor(Date.UTC(2026, 7, 15, 12) / 1000);

function fakeClient(): XClient & { posts: string[] } {
  const posts: string[] = [];
  return {
    posts,
    async postText(text) {
      posts.push(text);
      return `x${posts.length}`;
    },
    async postWithPng() {
      throw new Error("unused");
    },
  };
}

function meta(
  cid: string,
  hoursToEnd: number,
  over: Partial<MarketMeta> = {},
): MarketMeta {
  return {
    conditionId: cid,
    volume24hr: 500_000,
    liquidity: 100_000,
    endDate: new Date((NOW + hoursToEnd * 3600) * 1000).toISOString(),
    closed: false,
    category: "Sports",
    outcomes: ["Yes", "No"],
    outcomePrices: [0.61, 0.39],
    clobTokenIds: ["t1", "t2"],
    feesEnabled: false,
    feeType: null,
    ...over,
  } as MarketMeta;
}

function whaleAlert(
  db: DB,
  key: string,
  cid: string,
  usd: number,
  outcome: string,
  ts: number,
  side = "BUY",
) {
  recordAlert(
    db,
    "large",
    key,
    JSON.stringify({
      proxyWallet: "0xa",
      side,
      asset: "t",
      conditionId: cid,
      size: usd,
      price: 1,
      timestamp: ts,
      title: `Market ${cid}`,
      slug: "s",
      eventSlug: "e",
      outcome,
      outcomeIndex: 0,
      transactionHash: key,
    }),
    ts,
  );
}

function deps(db: DB, client: XClient, metas: Record<string, MarketMeta>) {
  return {
    db,
    client,
    getMeta: async (cids: string[]) =>
      Object.fromEntries(
        cids.filter((c) => metas[c]).map((c) => [c, metas[c]]),
      ),
    budgetUsd: 15,
    nowSec: NOW,
  };
}

describe("runPregameCycle", () => {
  it("posts an in-window market once with leaning side, and dedups within the UTC day", async () => {
    const db = openDb(":memory:");
    whaleAlert(db, "a1", "0xc1", 60_000, "Yes", NOW - 3600);
    whaleAlert(db, "a2", "0xc1", 30_000, "No", NOW - 7200);
    const client = fakeClient();
    const d = deps(db, client, { "0xc1": meta("0xc1", 3) });
    expect(await runPregameCycle(d)).toBe(1);
    expect(client.posts[0]).toBe(
      '⏰ Settles in 3h: "Market 0xc1"\nSmart money fired 2 alerts totaling $90K in the last 24h · leaning YES @ 61¢',
    );
    const row = db
      .prepare("SELECT kind, status, has_link, est_cost_usd FROM x_posts")
      .get() as {
      kind: string;
      status: string;
      has_link: number;
      est_cost_usd: number;
    };
    expect(row).toMatchObject({
      kind: "pregame",
      status: "posted",
      has_link: 0,
    });
    // 同一 UTC 日不重发。
    expect(await runPregameCycle(d)).toBe(0);
    expect(client.posts).toHaveLength(1);
  });

  it("ignores markets outside the 1–6h window and closed markets", async () => {
    const db = openDb(":memory:");
    whaleAlert(db, "a1", "0xfar", 60_000, "Yes", NOW - 600);
    whaleAlert(db, "a2", "0xsoon", 60_000, "Yes", NOW - 600);
    whaleAlert(db, "a3", "0xclosed", 60_000, "Yes", NOW - 600);
    const client = fakeClient();
    const d = deps(db, client, {
      "0xfar": meta("0xfar", 12),
      "0xsoon": meta("0xsoon", 0.5),
      "0xclosed": meta("0xclosed", 3, { closed: true }),
    });
    expect(await runPregameCycle(d)).toBe(0);
    expect(client.posts).toHaveLength(0);
  });

  it("SELL alerts count toward totals but not toward the leaning side", async () => {
    const db = openDb(":memory:");
    whaleAlert(db, "b1", "0xc1", 20_000, "Yes", NOW - 600, "BUY");
    whaleAlert(db, "b2", "0xc1", 80_000, "No", NOW - 700, "SELL");
    const client = fakeClient();
    await runPregameCycle(deps(db, client, { "0xc1": meta("0xc1", 2) }));
    expect(client.posts[0]).toContain("2 alerts totaling $100K");
    expect(client.posts[0]).toContain("leaning YES");
  });

  it("caps at 3 markets per cycle, ranked by alert count then usd", async () => {
    const db = openDb(":memory:");
    const metas: Record<string, MarketMeta> = {};
    for (let i = 0; i < 4; i++) {
      const cid = `0xm${i}`;
      metas[cid] = meta(cid, 2 + i * 0.5);
      // m0 有 1 条,m1 有 2 条,m2 有 3 条,m3 有 4 条 → m3/m2/m1 入选。
      for (let j = 0; j <= i; j++) {
        whaleAlert(
          db,
          `k${i}-${j}`,
          cid,
          10_000 * (j + 1),
          "Yes",
          NOW - 600 - j,
        );
      }
    }
    const client = fakeClient();
    expect(await runPregameCycle(deps(db, client, metas))).toBe(3);
    expect(client.posts.join("\n")).not.toContain("0xm0");
  });

  it("quota rejection (daily cap) writes NO ledger row — cheap retry, no dedup poisoning", async () => {
    const db = openDb(":memory:");
    const day = Math.floor(NOW / 86400) * 86400;
    for (let i = 0; i < 3; i++) {
      db.prepare(
        "INSERT INTO x_posts (kind, dedup_key, text, est_cost_usd, status, created_at) VALUES ('pregame', ?, 't', 0.015, 'posted', ?)",
      ).run(`old${i}`, day + i);
    }
    whaleAlert(db, "a1", "0xc1", 60_000, "Yes", NOW - 600);
    const client = fakeClient();
    expect(
      await runPregameCycle(deps(db, client, { "0xc1": meta("0xc1", 3) })),
    ).toBe(0);
    expect(client.posts).toHaveLength(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM x_posts").get() as { n: number })
        .n,
    ).toBe(3);
  });
});
