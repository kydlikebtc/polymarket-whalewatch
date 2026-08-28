import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import type { Trade } from "./types";
import {
  detectCohorts,
  formatCohortAlert,
  runCohortCycle,
  DEFAULT_COHORT,
} from "./cohortBirth";

// 同批出生检测(第一梯队五件套):N 个几乎同时出生的新钱包进同一市场同一
// 结果方向 = 协同指纹。零新增上游:成交 = consensus 循环已抓的深窗口,
// 年龄 = wallet_age 缓存裸读(查不到就是不知道,绝不现场抓)。
// 会计口径镜像 consensus 的两个坑:①净额按成本敞口(净股数×买入均价),
// 等股买卖不同价的「USD 假净买」不合格;②同市场双边净买的对冲钱包整体剔除。

function trade(over: Partial<Trade> = {}): Trade {
  return {
    proxyWallet: "0xW1",
    side: "BUY",
    asset: "tok1",
    conditionId: "c1",
    size: 4000,
    price: 0.5, // $2000 名义
    timestamp: 1_000_000,
    title: "Test market",
    slug: "test-market",
    eventSlug: "test-event",
    outcome: "Yes",
    outcomeIndex: 0,
    transactionHash: `h${Math.random()}`,
    ...over,
  };
}

const DAY = 86_400;
const NOW = 1_000_000 + 3600;

/** 三个新钱包(出生于 now−2/3/4 天,跨度 2 天 = 48h)各净买 $4k。 */
function freshTrio(): { trades: Trade[]; ages: Record<string, number> } {
  const trades = [
    trade({ proxyWallet: "0xA", transactionHash: "a1", size: 8000 }), // $4k
    trade({ proxyWallet: "0xB", transactionHash: "b1", size: 8000 }),
    trade({ proxyWallet: "0xC", transactionHash: "c1", size: 8000 }),
  ];
  const ages = {
    "0xa": NOW - 2 * DAY,
    "0xb": NOW - 3 * DAY,
    "0xc": NOW - 4 * DAY,
  };
  return { trades, ages };
}

describe("detectCohorts — 结构与年龄判定", () => {
  it("3 个 48h 同批新钱包各净买 ≥$2k、合计 ≥$10k → 一个 cohort,字段完整", () => {
    const { trades, ages } = freshTrio();
    const out = detectCohorts(trades, ages, DEFAULT_COHORT, NOW);
    expect(out.length).toBe(1);
    const g = out[0];
    expect(g.conditionId).toBe("c1");
    expect(g.outcome).toBe("Yes");
    expect(g.walletCount).toBe(3);
    expect(g.totalNetUsd).toBeCloseTo(12_000);
    expect(g.avgBuyPrice).toBeCloseTo(0.5);
    expect(g.asset).toBe("tok1");
    expect(g.outcomeIndex).toBe(0);
    expect(g.lastTs).toBe(1_000_000);
    expect(g.groupSize).toBe(3);
    expect(g.ageKnown).toBe(3);
    expect(g.birthSpanHours).toBeCloseTo(48);
    expect(g.youngestAgeDays).toBeCloseTo(2, 1);
    // 钱包明细按净额降序,带出生与年龄(dossier 链接与人工核查用)
    expect(g.wallets.length).toBe(3);
    expect(g.wallets[0].netUsd).toBeCloseTo(4000);
  });

  it("年龄未知的钱包不计入同批(缓存没有 = 不知道,绝不当新钱包)", () => {
    const { trades, ages } = freshTrio();
    delete (ages as Record<string, number>)["0xc"];
    const out = detectCohorts(trades, ages, DEFAULT_COHORT, NOW);
    expect(out).toEqual([]);
  });

  it("老钱包(> maxAgeDays)不计入同批", () => {
    const { trades, ages } = freshTrio();
    ages["0xc"] = NOW - 30 * DAY;
    expect(detectCohorts(trades, ages, DEFAULT_COHORT, NOW)).toEqual([]);
  });

  it("出生跨度超 48h 时取滑窗内最大子集:4 钱包中 3 个同批 → cohort 只含那 3 个", () => {
    const { trades, ages } = freshTrio();
    trades.push(
      trade({ proxyWallet: "0xD", transactionHash: "d1", size: 8000 }),
    );
    ages["0xd"] = NOW - 6.5 * DAY; // 仍是新钱包(≤7天),但与 2-4 天那三个不同批
    const out = detectCohorts(trades, ages, DEFAULT_COHORT, NOW);
    expect(out.length).toBe(1);
    expect(out[0].walletCount).toBe(3);
    expect(out[0].wallets.map((w) => w.wallet)).not.toContain("0xd");
    // groupSize/ageKnown 说的是结构组全量(4 个都过了净额线且年龄已知)
    expect(out[0].groupSize).toBe(4);
    expect(out[0].ageKnown).toBe(4);
  });

  it("成本敞口口径:买入后等股卖出的钱包敞口归零,不合格", () => {
    const { trades, ages } = freshTrio();
    trades.push(
      trade({
        proxyWallet: "0xC",
        transactionHash: "c2",
        side: "SELL",
        size: 8000,
        price: 0.6, // 等股高价卖出 —— 现金流口径会留下假净买
      }),
    );
    expect(detectCohorts(trades, ages, DEFAULT_COHORT, NOW)).toEqual([]);
  });

  it("同市场双边净买的对冲钱包整体剔除(镜像 consensus 假对立防线)", () => {
    const { trades, ages } = freshTrio();
    trades.push(
      trade({
        proxyWallet: "0xC",
        transactionHash: "c3",
        outcome: "No",
        outcomeIndex: 1,
        asset: "tok2",
        size: 8000,
      }),
    );
    expect(detectCohorts(trades, ages, DEFAULT_COHORT, NOW)).toEqual([]);
  });

  it("重复行去重(分页边界重发):同一笔成交只记一次", () => {
    const { trades, ages } = freshTrio();
    trades.push({ ...trades[0] }); // 同 transactionHash → 同 dedupKey
    const out = detectCohorts(trades, ages, DEFAULT_COHORT, NOW);
    expect(out[0].totalNetUsd).toBeCloseTo(12_000);
  });

  it("合计不过 minTotalUsd → 不成组(3×$2.5k=$7.5k < $10k)", () => {
    const trades = ["0xA", "0xB", "0xC"].map((w, i) =>
      trade({ proxyWallet: w, transactionHash: `t${i}`, size: 5000 }),
    ); // 各 $2.5k
    const ages = { "0xa": NOW - DAY, "0xb": NOW - DAY, "0xc": NOW - DAY };
    expect(detectCohorts(trades, ages, DEFAULT_COHORT, NOW)).toEqual([]);
  });
});

describe("formatCohortAlert", () => {
  it("含标题/方向/合计/同批规模/年龄覆盖声明,标题转义 HTML", () => {
    const { trades, ages } = freshTrio();
    trades.forEach((t) => (t.title = "<b>危险标题</b>"));
    const g = detectCohorts(trades, ages, DEFAULT_COHORT, NOW)[0];
    const html = formatCohortAlert(g);
    expect(html).toContain("同批新钱包");
    expect(html).toContain("&lt;b&gt;危险标题&lt;/b&gt;");
    expect(html).toContain("Yes");
    expect(html).toContain("$12,000");
    expect(html).toContain("年龄已知 3/3");
  });
});

describe("runCohortCycle — claim-then-send 与升级语义", () => {
  function seedAges(
    db: ReturnType<typeof openDb>,
    ages: Record<string, number>,
  ) {
    const ins = db.prepare(
      "INSERT OR REPLACE INTO wallet_age (wallet, first_ts, fetched_at) VALUES (?, ?, ?)",
    );
    for (const [w, ts] of Object.entries(ages)) ins.run(w, ts, NOW);
  }

  it("形成 → 落一条 type='cohort' 告警并推送;同窗口重跑不重复", async () => {
    const db = openDb(":memory:");
    const { trades, ages } = freshTrio();
    seedAges(db, ages);
    const send = vi.fn().mockResolvedValue(undefined);
    const n1 = await runCohortCycle({ db, trades, send, nowSec: NOW });
    expect(n1).toBe(1);
    const row = db
      .prepare("SELECT type, dedup_key, payload FROM alerts")
      .get() as { type: string; dedup_key: string; payload: string };
    expect(row.type).toBe("cohort");
    expect(row.dedup_key).toBe("cohort:c1:Yes:3");
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    // 验证回填 trackable 五要素必须齐(镜像 consensus 分支的要求)
    expect(p.asset).toBe("tok1");
    expect(p.avgBuyPrice).toBeCloseTo(0.5);
    expect(p.lastTs).toBe(1_000_000);
    expect(p.outcomeIndex).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    // 同窗口第二轮:INSERT OR IGNORE 命中 → 静默
    const n2 = await runCohortCycle({ db, trades, send, nowSec: NOW + 60 });
    expect(n2).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("第 4 个钱包加入 → 新 dedup key,升级再报一次", async () => {
    const db = openDb(":memory:");
    const { trades, ages } = freshTrio();
    ages["0xd"] = NOW - 3 * DAY;
    seedAges(db, ages);
    const send = vi.fn().mockResolvedValue(undefined);
    await runCohortCycle({ db, trades, send, nowSec: NOW });
    trades.push(
      trade({ proxyWallet: "0xD", transactionHash: "d9", size: 8000 }),
    );
    const n = await runCohortCycle({ db, trades, send, nowSec: NOW + 60 });
    expect(n).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    const keys = (
      db.prepare("SELECT dedup_key FROM alerts ORDER BY id").all() as {
        dedup_key: string;
      }[]
    ).map((r) => r.dedup_key);
    expect(keys).toEqual(["cohort:c1:Yes:3", "cohort:c1:Yes:4"]);
  });

  it("瞬态推送失败 → 回滚 claim 并上抛(下轮至少一次重试)", async () => {
    const db = openDb(":memory:");
    const { trades, ages } = freshTrio();
    seedAges(db, ages);
    const send = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      runCohortCycle({ db, trades, send, nowSec: NOW }),
    ).rejects.toThrow("ECONNRESET");
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM alerts").get() as { n: number }).n,
    ).toBe(0);
  });

  it("年龄严格来自 wallet_age 缓存:缓存空 → 零检测零上游(没有任何抓取路径)", async () => {
    const db = openDb(":memory:");
    const { trades } = freshTrio();
    const send = vi.fn();
    const n = await runCohortCycle({ db, trades, send, nowSec: NOW });
    expect(n).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
