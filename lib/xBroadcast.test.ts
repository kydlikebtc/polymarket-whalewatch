import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import { recordAlert } from "./seen";
import { runXBroadcastCycle, X_POST_MAX_AGE_SEC } from "./xBroadcast";
import { SETTLE_PROMISE_LINE } from "./xComposer";
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
    async replyText() {
      throw new Error("replies not used in this cycle");
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
    // 结构化布局:断言抬头(含标的+方向+价格)/ 标题 / 佐证 / 标签
    // (见 lib/xComposer composeWhalePost v2)。
    expect(client.posts[0]).toContain("🐳 WHALE: $67K says YES @ 67¢");
    expect(client.posts[0]).toContain("Chiefs win Super Bowl LX?");
    expect(client.posts[0]).toContain("📊 12% of 24h vol");
    // 赛道标签取自 event_category 表(未缓存 ⇒ 只出根标签,且不去抓)。
    expect(client.posts[0]).toContain("#Polymarket");
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
    expect(client.posts[0]).not.toContain("#SmartMoney");
    expect(client.posts[1]).toMatch(/^🐳 WHALE: /);
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

  it("un-enriched smart payload (no marketCtx, wallet out of pool) still posts the first line", async () => {
    const db = openDb(":memory:");
    const p = JSON.parse(whalePayload()) as Record<string, unknown>;
    delete p.marketCtx;
    recordAlert(db, "smart", "t1", JSON.stringify(p), NOW - 60);
    const client = fakeClient();
    expect(await runXBroadcastCycle(deps(db, client))).toBe(1);
    // 未富化 → 无佐证段、无赛道标签;钱包不在池 → 无凭证行。但 type='smart'
    // 的 🏆 抬头、结构与根标签仍在 —— 双重降级也不丢首行。
    expect(client.posts[0]).toBe(
      // 赛道标签缺失(无 event_category 行),但标题命中实体白名单。
      "🏆 SMART MONEY: $67K says YES @ 67¢\n\nChiefs win Super Bowl LX?\n\n#Polymarket #SuperBowl",
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

describe("话题标签与共识均价的接线", () => {
  // 背景(2026-08-18 实测):赛道标签功能从上线起就没生效过。buildTags 设计
  // 为「二级优先」,但数据取自 marketCtx.category —— 而 gamma /markets 的
  // category 字段在本地 745 个市场里 100% 为空。真正有分类的是
  // event_category 表(291 条一级 / 127 条二级)。于是账号上每条帖子的标签
  // 都只有 #Polymarket,精准赛道流量一次都没吃到。
  it("大单帖的赛道标签取自 event_category(二级优先)", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO event_category (event_slug, category, subcategory, fetched_at) VALUES ('sb', 'Sports', 'NFL', 100)",
    ).run();
    recordAlert(db, "large", "t1", whalePayload(), NOW - 60);
    const client = fakeClient();
    await runXBroadcastCycle(deps(db, client));
    expect(client.posts[0]).toContain("#Polymarket #NFL");
  });

  it("没有二级时退到一级", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO event_category (event_slug, category, subcategory, fetched_at) VALUES ('sb', 'Politics', '', 100)",
    ).run();
    recordAlert(db, "large", "t1", whalePayload(), NOW - 60);
    const client = fakeClient();
    await runXBroadcastCycle(deps(db, client));
    expect(client.posts[0]).toContain("#Polymarket #Politics");
  });

  it("分类未缓存时只出根标签 —— 绝不为一个标签去打 gamma", async () => {
    // 红线:播报跑在引擎循环里,标签是锦上添花,不值得占用监控主链路的
    // 上游请求预算。readEventCategories 是纯本地读。
    const db = openDb(":memory:");
    recordAlert(db, "large", "t1", whalePayload(), NOW - 60);
    const client = fakeClient();
    await runXBroadcastCycle(deps(db, client));
    // 赛道标签一个都不该出现(那需要 event_category 命中);实体标签
    // 来自标题匹配,是纯函数,不涉及任何查询。
    expect(client.posts[0]).toContain("#Polymarket");
    expect(client.posts[0]).not.toContain("#Sports");
    expect(client.posts[0]).not.toContain("#NFL");
  });

  it("共识帖带聚钱均价与赛道标签", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO event_category (event_slug, category, subcategory, fetched_at) VALUES ('mlb-ev', 'Sports', 'MLB', 100)",
    ).run();
    recordAlert(
      db,
      "consensus",
      "consensus:0xc9:Braves:2",
      JSON.stringify({
        conditionId: "0xc9",
        title: "Atlanta Braves vs. Minnesota Twins",
        outcome: "Atlanta Braves",
        eventSlug: "mlb-ev",
        walletCount: 2,
        totalNetUsd: 18_400,
        avgBuyPrice: 0.58,
        params: {},
      }),
      NOW - 30,
    );
    const client = fakeClient();
    await runXBroadcastCycle(deps(db, client));
    // 均价是读者判断「现在还跟不跟得上」的唯一依据。
    expect(client.posts[0]).toContain(
      "└ 2 top-PnL wallets → Atlanta Braves @ 58¢ · $18.4K combined",
    );
    expect(client.posts[0]).toContain("#Polymarket #MLB");
  });

  it("老共识行没有 avgBuyPrice 时优雅降级,不出 0¢", async () => {
    const db = openDb(":memory:");
    recordAlert(
      db,
      "consensus",
      "consensus:0xc8:Yes:3",
      JSON.stringify({
        conditionId: "0xc8",
        title: "Fed cut in Sept?",
        outcome: "Yes",
        walletCount: 3,
        totalNetUsd: 92_000,
        params: {},
      }),
      NOW - 30,
    );
    const client = fakeClient();
    await runXBroadcastCycle(deps(db, client));
    expect(client.posts[0]).toContain("→ YES · $92K combined");
    expect(client.posts[0]).not.toContain("0¢");
  });
});

describe("smart/large 凭证行与承诺行双闸门", () => {
  // 背景:parseCandidate 曾把 large(匿名大户)与 smart(白名单聪明钱)合并成
  // 同一个 kind:'whale',凭证信息全丢 —— 🏆 帖与 🐳 帖长得一模一样。
  it("type='smart' 且钱包在池 → 🏆 抬头 + Track record 凭证行(地址大小写归一)", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO smart_wallets (address, win_rate, realized_pnl) VALUES ('0xabc', 0.74, 1200000)",
    ).run();
    // payload 里的地址故意混大小写 —— 钉住实现按小写归一去查。
    recordAlert(
      db,
      "smart",
      "t1",
      whalePayload({ proxyWallet: "0xAbC" }),
      NOW - 60,
    );
    const client = fakeClient();
    expect(await runXBroadcastCycle(deps(db, client))).toBe(1);
    expect(client.posts[0]).toMatch(/^🏆 SMART MONEY: /);
    expect(client.posts[0]).toContain(
      "Track record: 74% win rate · +$1.2M PnL",
    );
  });

  it("type='large' 即便同钱包在池也不回头查 → 🐳 抬头、无凭证行", async () => {
    // 当初没被判定为聪明钱(可能是入池前的成交),此刻回头查会前后不一致。
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO smart_wallets (address, win_rate, realized_pnl) VALUES ('0xabc', 0.74, 1200000)",
    ).run();
    recordAlert(db, "large", "t1", whalePayload(), NOW - 60);
    const client = fakeClient();
    expect(await runXBroadcastCycle(deps(db, client))).toBe(1);
    expect(client.posts[0]).toMatch(/^🐳 WHALE: /);
    expect(client.posts[0]).not.toContain("Track record");
  });

  it("type='smart' 但钱包已出池 → 🏆 抬头保留、凭证行省略", async () => {
    // 「告警时刻是白名单钱包」是既成事实,🏆 不回滚;凭证数字已无来源,不编。
    const db = openDb(":memory:");
    recordAlert(db, "smart", "t1", whalePayload(), NOW - 60);
    const client = fakeClient();
    expect(await runXBroadcastCycle(deps(db, client))).toBe(1);
    expect(client.posts[0]).toMatch(/^🏆 SMART MONEY: /);
    expect(client.posts[0]).not.toContain("Track record");
  });

  it("承诺行双闸门四象限:仅 settled 开 × 结算 ≤144h 才印", async () => {
    const quadrants = [
      { settled: true, hoursToEnd: 30, expectLine: true },
      { settled: true, hoursToEnd: 200, expectLine: false },
      { settled: false, hoursToEnd: 30, expectLine: false },
      { settled: false, hoursToEnd: 200, expectLine: false },
    ];
    for (const q of quadrants) {
      const db = openDb(":memory:");
      const p = JSON.parse(whalePayload()) as {
        marketCtx: { hoursToEnd: number };
      };
      p.marketCtx.hoursToEnd = q.hoursToEnd;
      recordAlert(db, "large", "t1", JSON.stringify(p), NOW - 60);
      const client = fakeClient();
      await runXBroadcastCycle(
        deps(db, client, {
          kinds: { whale: true, consensus: true, settled: q.settled },
        }),
      );
      const label = `settled=${q.settled} hoursToEnd=${q.hoursToEnd}`;
      expect(client.posts, label).toHaveLength(1);
      if (q.expectLine) {
        expect(client.posts[0], label).toContain(SETTLE_PROMISE_LINE);
      } else {
        expect(client.posts[0], label).not.toContain(SETTLE_PROMISE_LINE);
      }
    }
  });
});
