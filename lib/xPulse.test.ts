import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import type { XClient } from "./xPublisher";
import {
  composeDivergencePost,
  composePulsePost,
  weightedLength,
  X_POST_MAX_CHARS,
} from "./xComposer";
import { PULSE_POST_UTC_HOUR, runPulseCycle } from "./xPulse";

// 市场脉搏日帖:composer 两帖 + 消费循环。循环的失败语义(claim/settle/
// unclaim)照抄 xWeekly,这里钉的是脉搏特有的三道闸:时刻闸、数据就绪闸
// (只发昨天,旧闻永不补发)、以及「无分歧的日子静默」。

const DAY = 86_400;
// 2026-08-27 15:00 UTC —— 过了出厂 14:00 发帖时刻。
const NOW = Math.floor(Date.UTC(2026, 7, 27, 15) / 1000);
const YESTERDAY = "2026-08-26";

function put(
  db: DB,
  day: string,
  cid: string,
  over: Record<string, unknown> = {},
) {
  const base: Record<string, unknown> = {
    title: `Market ${cid}`,
    slug: `s-${cid}`,
    event_slug: `e-${cid}`,
    category: "Sports",
    subcategory: "NBA",
    trades: 30,
    volume_usd: 120_000,
    wallet_count: 12,
    top_outcome: "Yes",
    one_sided: 0.7,
    small_usd: 20_000,
    small_net_usd: 0,
    small_top_outcome: null,
    whale_usd: 60_000,
    whale_net_usd: 0,
    whale_top_outcome: null,
    price_first: 0.4,
    price_last: 0.62,
    covered_from_sec: 0,
    truncated: 0,
    ...over,
  };
  db.prepare(
    `INSERT OR REPLACE INTO market_daily
       (day, condition_id, title, slug, event_slug, category, subcategory,
        trades, volume_usd, wallet_count, top_outcome, one_sided,
        small_usd, small_net_usd, small_top_outcome,
        whale_usd, whale_net_usd, whale_top_outcome,
        price_first, price_last, covered_from_sec, truncated)
     VALUES (@day, @cid, @title, @slug, @event_slug, @category, @subcategory,
        @trades, @volume_usd, @wallet_count, @top_outcome, @one_sided,
        @small_usd, @small_net_usd, @small_top_outcome,
        @whale_usd, @whale_net_usd, @whale_top_outcome,
        @price_first, @price_last, @covered_from_sec, @truncated)`,
  ).run({ day, cid, ...base });
}

function seedDivergence(db: DB, day = YESTERDAY) {
  put(db, day, "0xdiv", {
    title: "Real Madrid O/U 3.5",
    small_top_outcome: "Under",
    small_net_usd: 33_700,
    whale_top_outcome: "Over",
    whale_net_usd: 473_000,
  });
}

function fakeClient(): { calls: string[]; client: XClient; fail?: unknown } {
  const calls: string[] = [];
  const client = {
    postText: async (t: string) => {
      calls.push(t);
      return `tid${calls.length}`;
    },
    postWithPng: async () => "unused",
    replyText: async () => "unused",
  } as unknown as XClient;
  return { calls, client };
}

function deps(
  db: DB,
  client: XClient,
  over: Partial<Parameters<typeof runPulseCycle>[0]> = {},
) {
  return {
    db,
    client,
    budgetUsd: 15,
    kinds: { pulse: true, divergence: true },
    nowSec: NOW,
    ...over,
  };
}

const ledger = (db: DB) =>
  db
    .prepare("SELECT kind, dedup_key, status FROM x_posts ORDER BY id")
    .all() as { kind: string; dedup_key: string; status: string }[];

describe("composePulsePost", () => {
  const input = {
    day: YESTERDAY,
    title: "Will the Lakers beat the Celtics tonight?",
    score: 84,
    volRatio: 10.7,
    oneSidedPct: 70,
    whaleSharePct: 56,
    runners: [
      { title: "Fed cuts in September?", score: 45 },
      { title: "US Open WTA qualifier match winner", score: 41 },
    ],
    category: "Sports",
    subcategory: "NBA",
  };

  it("富梯级:抬头日期/总分/三段拆解/次名/标签全在,≤280 加权", () => {
    const t = composePulsePost(input);
    expect(t).toContain("📊 MARKET PULSE — Aug 26 (UTC)");
    expect(t).toContain("84/100");
    expect(t).toContain("10.7× its volume baseline");
    expect(t).toContain("70% one-sided");
    expect(t).toContain("whales 56% of flow");
    expect(t).toContain("#2 Fed cuts in September? (45)");
    expect(t).toContain("#Polymarket");
    expect(weightedLength(t)).toBeLessThanOrEqual(X_POST_MAX_CHARS);
  });

  it("基线不足(volRatio null)整段省略,不渲染 0×", () => {
    const t = composePulsePost({ ...input, volRatio: null });
    expect(t).not.toContain("×");
    expect(t).toContain("70% one-sided");
  });

  it("超长标题:输出仍 ≤280 且带截断省略号 —— 最简梯级底座留足了位", () => {
    const t = composePulsePost({ ...input, title: "眼".repeat(400) });
    expect(weightedLength(t)).toBeLessThanOrEqual(X_POST_MAX_CHARS);
    expect(t).toContain("…");
  });

  it("模板路径:合法模板生效;渲染出 URL 回退内置", () => {
    const custom = composePulsePost({
      ...input,
      template: "PULSE {day} · {title} · {score} pts\n{tags}",
    });
    expect(custom).toContain("PULSE Aug 26 (UTC)");
    expect(custom).toContain("84 pts");
    const evil = composePulsePost({
      ...input,
      template: "{title} https://spam.example {score}",
    });
    expect(evil).toContain("📊 MARKET PULSE");
    expect(evil).not.toContain("spam.example");
  });
});

describe("composeDivergencePost", () => {
  const input = {
    title: "Real Madrid CF vs. Real Sociedad: O/U 3.5 goals",
    smallOutcome: "Under",
    smallNetUsd: 33_700,
    whaleOutcome: "Over",
    whaleNetUsd: 473_000,
    category: "Sports",
    subcategory: "LaLiga",
  };

  it("富梯级:双向各一行 + kicker + 标签,金额走 usdCompact", () => {
    const t = composeDivergencePost(input);
    expect(t).toContain("⚔️ SPLIT TAPE");
    expect(t).toContain("small orders buying Under (+$33.7K)");
    expect(t).toContain("whales buying Over (+$473K)");
    expect(t).toContain("One side is wrong.");
    expect(weightedLength(t)).toBeLessThanOrEqual(X_POST_MAX_CHARS);
  });

  it("超长标题:仍 ≤280 —— 单行坍缩梯级兜底", () => {
    const t = composeDivergencePost({ ...input, title: "长".repeat(400) });
    expect(weightedLength(t)).toBeLessThanOrEqual(X_POST_MAX_CHARS);
    expect(t).toContain("…");
  });
});

describe("runPulseCycle — 三道闸", () => {
  it("两类全关:零查询零帖(默认態就是这个)", async () => {
    const db = openDb(":memory:");
    seedDivergence(db);
    const { calls, client } = fakeClient();
    const n = await runPulseCycle(
      deps(db, client, { kinds: { pulse: false, divergence: false } }),
    );
    expect(n).toBe(0);
    expect(calls).toEqual([]);
    expect(ledger(db)).toEqual([]);
    db.close();
  });

  it("时刻闸:未到设定 UTC 时刻不发", async () => {
    const db = openDb(":memory:");
    seedDivergence(db);
    const { calls, client } = fakeClient();
    const before = Math.floor(
      Date.UTC(2026, 7, 27, PULSE_POST_UTC_HOUR - 1) / 1000,
    );
    expect(await runPulseCycle(deps(db, client, { nowSec: before }))).toBe(0);
    expect(calls).toEqual([]);
    db.close();
  });

  it("数据就绪闸:latestDay 不是昨天(聚合迟到/漏天)不发,旧闻永不补发", async () => {
    const db = openDb(":memory:");
    seedDivergence(db, "2026-08-24"); // 前天的数据
    const { calls, client } = fakeClient();
    expect(await runPulseCycle(deps(db, client))).toBe(0);
    expect(calls).toEqual([]);
    db.close();
  });

  it("happy path:日榜 + 分歧各一帖,台账落 posted,第二轮 dedup 静默", async () => {
    const db = openDb(":memory:");
    seedDivergence(db);
    const { calls, client } = fakeClient();
    expect(await runPulseCycle(deps(db, client))).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("MARKET PULSE");
    expect(calls[1]).toContain("SPLIT TAPE");
    expect(ledger(db)).toEqual([
      { kind: "pulse", dedup_key: `pulse:${YESTERDAY}`, status: "posted" },
      {
        kind: "divergence",
        dedup_key: `divergence:${YESTERDAY}`,
        status: "posted",
      },
    ]);
    expect(await runPulseCycle(deps(db, client))).toBe(0);
    expect(calls).toHaveLength(2);
    db.close();
  });

  it("无分歧的日子:分歧线静默,日榜照发", async () => {
    const db = openDb(":memory:");
    put(db, YESTERDAY, "0xplain"); // 无分歧字段
    const { calls, client } = fakeClient();
    expect(await runPulseCycle(deps(db, client))).toBe(1);
    expect(calls[0]).toContain("MARKET PULSE");
    expect(ledger(db).map((r) => r.kind)).toEqual(["pulse"]);
    db.close();
  });

  it("配额拒绝(预算烧穿):不 claim 不发,台账无行", async () => {
    const db = openDb(":memory:");
    seedDivergence(db);
    const { calls, client } = fakeClient();
    expect(await runPulseCycle(deps(db, client, { budgetUsd: 0.001 }))).toBe(0);
    expect(calls).toEqual([]);
    expect(ledger(db)).toEqual([]);
    db.close();
  });

  it("瞬态发帖错误:unclaim + rethrow,下一轮重试成功", async () => {
    const db = openDb(":memory:");
    seedDivergence(db);
    let failOnce = true;
    const calls: string[] = [];
    const client = {
      postText: async (t: string) => {
        if (failOnce) {
          failOnce = false;
          const e = new Error("503") as Error & { status?: number };
          e.status = 503;
          throw e;
        }
        calls.push(t);
        return "tid";
      },
    } as unknown as XClient;
    await expect(runPulseCycle(deps(db, client))).rejects.toThrow("503");
    // claim 已回滚 —— 台账不能留 claimed 孤儿挡住重试。
    expect(ledger(db)).toEqual([]);
    expect(await runPulseCycle(deps(db, client))).toBe(2);
    db.close();
  });

  it("模板透传:/manage 配的自定义文案真的用上了", async () => {
    const db = openDb(":memory:");
    put(db, YESTERDAY, "0xplain");
    const { calls, client } = fakeClient();
    await runPulseCycle(
      deps(db, client, {
        kinds: { pulse: true, divergence: false },
        templates: { pulse: "CUSTOM {title} scores {score}\n{tags}" },
      }),
    );
    expect(calls[0]).toContain("CUSTOM Market 0xplain scores");
    db.close();
  });
});
