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
    async replyText() {
      throw new Error("replies not used in this cycle");
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
  it("posts an in-window market once with both sides' money, and dedups within the UTC day", async () => {
    const db = openDb(":memory:");
    // 赛道标签取自 event_category(告警 payload 的 eventSlug='e'),
    // 而不是 meta.category —— 后者在 gamma 上实测恒为空。
    db.prepare(
      "INSERT INTO event_category (event_slug, category, subcategory, fetched_at) VALUES ('e', 'Sports', 'NBA', 100)",
    ).run();
    // 小额边(No)先插:buyUsdByOutcome 是 Map,迭代序=插入序 —— 大额先插
    // 会让「忘写 sort」的突变存活;小额先插时删掉排序,sides[0] 就是 No,
    // 下面的 2-to-1 on YES 断言必红。
    whaleAlert(db, "a1", "0xc1", 30_000, "No", NOW - 7200);
    whaleAlert(db, "a2", "0xc1", 60_000, "Yes", NOW - 3600);
    const client = fakeClient();
    const d = deps(db, client, { "0xc1": meta("0xc1", 3) });
    expect(await runPregameCycle(d)).toBe(1);
    // 60K/30K 恰好压在 2.0 比例边界上 → 走 X-to-1(≥2 含边界),不是
    // SPLIT;比例经 floor(不夸大),2.0 取整仍是 2-to-1。
    expect(client.posts[0]).toBe(
      "⏰ SETTLES IN 3H — smart money is 2-to-1 on YES\n\n" +
        "Market 0xc1\n" +
        "└ YES @ 61¢\n\n" +
        "📡 2 signals in 24h · $60K on YES vs $30K on NO\n\n" +
        "#Polymarket #NBA",
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

  it("SELL alerts count toward the signal count but never toward sides money", async () => {
    const db = openDb(":memory:");
    whaleAlert(db, "b1", "0xc1", 20_000, "Yes", NOW - 600, "BUY");
    whaleAlert(db, "b2", "0xc1", 80_000, "No", NOW - 700, "SELL");
    const client = fakeClient();
    await runPregameCycle(deps(db, client, { "0xc1": meta("0xc1", 2) }));
    // SELL 是离场:计入热度(2 signals),但它的 $80K 不进资金行,也不给
    // No 制造一个假想的对立面 —— 对面 BUY 为 0 就走 every-signal 局面。
    expect(client.posts[0]).toContain("— every signal is on YES");
    expect(client.posts[0]).toContain("└ YES @ 61¢");
    expect(client.posts[0]).toContain(
      "📡 2 signals in 24h · all $20K on one side",
    );
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

describe("窗口与日上限覆盖(minH/maxH/dailyCap,/manage 可配)", () => {
  it("默认窗口外(T-10h)不发;maxH=12 后进窗", async () => {
    const db = openDb(":memory:");
    whaleAlert(db, "a1", "0xc1", 60_000, "Yes", NOW - 600);
    const client = fakeClient();
    const metas = { "0xc1": meta("0xc1", 10) };
    expect(await runPregameCycle(deps(db, client, metas))).toBe(0);
    expect(
      await runPregameCycle({ ...deps(db, client, metas), maxH: 12 }),
    ).toBe(1);
    expect(client.posts).toHaveLength(1);
  });

  it("默认下限内(T-0.5h)不发;minH=0 允许贴近结算", async () => {
    const db = openDb(":memory:");
    whaleAlert(db, "a1", "0xc1", 60_000, "Yes", NOW - 600);
    const client = fakeClient();
    const metas = { "0xc1": meta("0xc1", 0.5) };
    expect(await runPregameCycle(deps(db, client, metas))).toBe(0);
    expect(await runPregameCycle({ ...deps(db, client, metas), minH: 0 })).toBe(
      1,
    );
  });

  it("dailyCap=1:两个进窗市场只发热度第一的,被拦的不落台账(下轮再试)", async () => {
    const db = openDb(":memory:");
    whaleAlert(db, "a1", "0xc1", 90_000, "Yes", NOW - 600);
    whaleAlert(db, "a2", "0xc1", 80_000, "Yes", NOW - 500);
    whaleAlert(db, "b1", "0xc2", 60_000, "Yes", NOW - 400);
    const client = fakeClient();
    const metas = { "0xc1": meta("0xc1", 3), "0xc2": meta("0xc2", 4) };
    expect(
      await runPregameCycle({ ...deps(db, client, metas), dailyCap: 1 }),
    ).toBe(1);
    expect(client.posts).toHaveLength(1);
    // 只有发出的那条有台账行;被 cap 拦的市场没有行,明天还有机会。
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM x_posts").get() as { n: number })
        .n,
    ).toBe(1);
  });
});
