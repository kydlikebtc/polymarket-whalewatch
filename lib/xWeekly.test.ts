import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import { buildWeeklyReport, maybeWeeklyPost } from "./xWeekly";
import type { XClient } from "./xPublisher";

// 2026-08-17 是周一;13:05 UTC 过了发帖闸。
const MONDAY_13 = Math.floor(Date.UTC(2026, 7, 17, 13, 5) / 1000);

function seedPosition(
  db: DB,
  strategyName: string,
  pnl: number,
  exitTs: number,
  sizeUsd = 500,
) {
  const s = db
    .prepare("SELECT id FROM follow_strategies WHERE name = ?")
    .get(strategyName) as { id: number } | undefined;
  if (!s) throw new Error(`no seed strategy ${strategyName}`);
  db.prepare(
    `INSERT INTO follow_positions (strategy_id, condition_id, outcome, entry_ts, entry_price, size_usd, shares, status, exit_ts, exit_price, realized_pnl)
     VALUES (?, ?, 'Yes', ?, 0.5, ?, ?, 'settled', ?, 1, ?)`,
  ).run(
    s.id,
    `0x${strategyName}-${exitTs}-${pnl}`,
    exitTs - 3600,
    sizeUsd,
    sizeUsd / 0.5,
    exitTs,
    pnl,
  );
}

function fakeClient(): XClient & {
  pngPosts: { text: string; bytes: number }[];
} {
  const pngPosts: { text: string; bytes: number }[] = [];
  return {
    pngPosts,
    async postText() {
      throw new Error("weekly must post with image");
    },
    async postWithPng(text, png) {
      pngPosts.push({ text, bytes: png.length });
      return `x${pngPosts.length}`;
    },
    async replyText() {
      throw new Error("replies not used in this cycle");
    },
  };
}

const okFetch = (async () =>
  new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch;

function deps(db: DB, client: XClient, over: Record<string, unknown> = {}) {
  return {
    db,
    client,
    ogOrigin: "http://127.0.0.1:3000",
    publicUrl: "https://whalewatch.wired.fund",
    budgetUsd: 15,
    nowSec: MONDAY_13,
    fetchImpl: okFetch,
    ...over,
  };
}

describe("buildWeeklyReport", () => {
  it("aggregates settled positions of the last 7 days per strategy", () => {
    const db = openDb(":memory:");
    seedPosition(db, "巨鲸", 100, MONDAY_13 - 86400);
    seedPosition(db, "巨鲸", -40, MONDAY_13 - 2 * 86400);
    seedPosition(db, "超级巨鲸", 250, MONDAY_13 - 3 * 86400);
    // 窗口外(8 天前)不计。
    seedPosition(db, "巨鲸", 999, MONDAY_13 - 8 * 86400);
    const r = buildWeeklyReport(db, MONDAY_13);
    expect(r.settled).toBe(3);
    expect(r.pnlUsd).toBeCloseTo(310, 6);
    expect(r.winRatePct).toBeCloseTo((2 / 3) * 100, 6);
    expect(r.rows[0]).toMatchObject({
      name: "超级巨鲸",
      nameEn: "Mega Whale",
      settled: 1,
    });
    expect(r.rows[0].roiPct).toBeCloseTo(50, 6);
    expect(r.weekLabel).toContain("Aug");
    // push(pnl=0)不进胜率分母。
    seedPosition(db, "巨鲸", 0, MONDAY_13 - 86400 + 1);
    expect(buildWeeklyReport(db, MONDAY_13).winRatePct).toBeCloseTo(
      (2 / 3) * 100,
      6,
    );
  });
});

describe("maybeWeeklyPost", () => {
  it("posts once on Monday ≥13:00 UTC with the PNG card and $0.20 ledger entry", async () => {
    const db = openDb(":memory:");
    seedPosition(db, "巨鲸", 100, MONDAY_13 - 86400);
    const client = fakeClient();
    expect(await maybeWeeklyPost(deps(db, client))).toBe(true);
    expect(client.pngPosts).toHaveLength(1);
    expect(client.pngPosts[0].text).toContain("📊 WEEKLY REPORT");
    expect(client.pngPosts[0].text).toContain("#Polymarket");
    expect(client.pngPosts[0].text).toContain(
      "https://whalewatch.wired.fund/follow?utm_source=x",
    );
    expect(client.pngPosts[0].bytes).toBe(3);
    const row = db
      .prepare("SELECT kind, status, has_link, est_cost_usd FROM x_posts")
      .get() as {
      kind: string;
      status: string;
      has_link: number;
      est_cost_usd: number;
    };
    expect(row).toMatchObject({
      kind: "weekly",
      status: "posted",
      has_link: 1,
    });
    expect(row.est_cost_usd).toBeCloseTo(0.2, 10);
    // 同周第二次:dedup 拦下。
    expect(await maybeWeeklyPost(deps(db, client))).toBe(false);
    expect(client.pngPosts).toHaveLength(1);
  });

  it("stays silent outside the Monday-13:00 gate", async () => {
    const db = openDb(":memory:");
    seedPosition(db, "巨鲸", 100, MONDAY_13 - 86400);
    const client = fakeClient();
    const sunday = MONDAY_13 - 86400;
    const mondayNoon = Math.floor(Date.UTC(2026, 7, 17, 12, 59) / 1000);
    expect(await maybeWeeklyPost(deps(db, client, { nowSec: sunday }))).toBe(
      false,
    );
    expect(
      await maybeWeeklyPost(deps(db, client, { nowSec: mondayNoon })),
    ).toBe(false);
    expect(client.pngPosts).toHaveLength(0);
  });

  it("card fetch failure leaves ZERO side effects (retries the rest of Monday)", async () => {
    const db = openDb(":memory:");
    seedPosition(db, "巨鲸", 100, MONDAY_13 - 86400);
    const client = fakeClient();
    const badFetch = (async () =>
      new Response("nope", { status: 500 })) as typeof fetch;
    expect(
      await maybeWeeklyPost(deps(db, client, { fetchImpl: badFetch })),
    ).toBe(false);
    expect(client.pngPosts).toHaveLength(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM x_posts").get() as { n: number })
        .n,
    ).toBe(0);
    // 修好后同一周仍能发出。
    expect(await maybeWeeklyPost(deps(db, client))).toBe(true);
  });

  it("skips an empty week (0 settled) — a hollow report hurts more than silence", async () => {
    const db = openDb(":memory:");
    const client = fakeClient();
    expect(await maybeWeeklyPost(deps(db, client))).toBe(false);
    expect(client.pngPosts).toHaveLength(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM x_posts").get() as { n: number })
        .n,
    ).toBe(0);
  });

  it("postUtcHour 覆盖(/manage 可配):周一 09:05 默认 13 点闸拦下,配成 8 点即放行", async () => {
    const db = openDb(":memory:");
    const monday9 = Math.floor(Date.UTC(2026, 7, 17, 9, 5) / 1000);
    seedPosition(db, "巨鲸", 100, monday9 - 86400);
    const client = fakeClient();
    expect(await maybeWeeklyPost(deps(db, client, { nowSec: monday9 }))).toBe(
      false,
    );
    expect(
      await maybeWeeklyPost(
        deps(db, client, { nowSec: monday9, postUtcHour: 8 }),
      ),
    ).toBe(true);
    expect(client.pngPosts).toHaveLength(1);
  });
});
