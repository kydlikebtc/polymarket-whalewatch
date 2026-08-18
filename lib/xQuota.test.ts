import { describe, it, expect } from "vitest";
import { openDb, type DB } from "./db";
import {
  COST_TEXT_USD,
  COST_LINK_USD,
  DAILY_CAP,
  costOf,
  spentUsdInUtcMonth,
  postedTodayCount,
  quotaDecision,
} from "./xQuota";

// 2026-08-15T12:00:00Z —— 测试全用固定时钟,月界/日界可控。
const NOW = Math.floor(Date.UTC(2026, 7, 15, 12) / 1000);

function insert(
  db: DB,
  row: {
    kind: string;
    dedup: string;
    status: string;
    cost: number;
    ts: number;
  },
) {
  db.prepare(
    "INSERT INTO x_posts (kind, dedup_key, text, est_cost_usd, status, created_at) VALUES (?,?,?,?,?,?)",
  ).run(row.kind, row.dedup, "t", row.cost, row.status, row.ts);
}

describe("costOf", () => {
  it("text $0.015, link $0.20", () => {
    expect(costOf(false)).toBe(COST_TEXT_USD);
    expect(costOf(true)).toBe(COST_LINK_USD);
  });
});

describe("spentUsdInUtcMonth", () => {
  it("sums claimed+posted in the UTC month; skipped/failed and other months excluded", () => {
    const db = openDb(":memory:");
    insert(db, {
      kind: "whale",
      dedup: "a",
      status: "posted",
      cost: 0.015,
      ts: NOW,
    });
    // claimed 计入 —— 崩溃残留的 claim 宁可占预算也不能让熔断放水。
    insert(db, {
      kind: "whale",
      dedup: "b",
      status: "claimed",
      cost: 0.015,
      ts: NOW,
    });
    insert(db, {
      kind: "whale",
      dedup: "c",
      status: "skipped",
      cost: 0.015,
      ts: NOW,
    });
    insert(db, {
      kind: "whale",
      dedup: "d",
      status: "failed",
      cost: 0.015,
      ts: NOW,
    });
    // 上一 UTC 月最后一秒:不计入。
    const julyLast = Math.floor(Date.UTC(2026, 7, 1) / 1000) - 1;
    insert(db, {
      kind: "whale",
      dedup: "e",
      status: "posted",
      cost: 5,
      ts: julyLast,
    });
    expect(spentUsdInUtcMonth(db, NOW)).toBeCloseTo(0.03, 10);
  });
});

describe("postedTodayCount", () => {
  it("counts claimed+posted for the kind within the UTC day only", () => {
    const db = openDb(":memory:");
    const dayStart = Math.floor(NOW / 86400) * 86400;
    insert(db, {
      kind: "whale",
      dedup: "a",
      status: "posted",
      cost: 0.015,
      ts: dayStart,
    });
    insert(db, {
      kind: "whale",
      dedup: "b",
      status: "claimed",
      cost: 0.015,
      ts: NOW,
    });
    insert(db, {
      kind: "whale",
      dedup: "y",
      status: "posted",
      cost: 0.015,
      ts: dayStart - 1,
    });
    insert(db, {
      kind: "pregame",
      dedup: "p",
      status: "posted",
      cost: 0.015,
      ts: NOW,
    });
    insert(db, {
      kind: "whale",
      dedup: "s",
      status: "skipped",
      cost: 0,
      ts: NOW,
    });
    expect(postedTodayCount(db, "whale", NOW)).toBe(2);
    expect(postedTodayCount(db, "pregame", NOW)).toBe(1);
  });
});

describe("quotaDecision", () => {
  it("rejects when monthly spend + this post would exceed the budget (fail-closed)", () => {
    const db = openDb(":memory:");
    insert(db, {
      kind: "weekly",
      dedup: "w",
      status: "posted",
      cost: 14.98,
      ts: NOW,
    });
    const link = quotaDecision(db, {
      kind: "weekly",
      hasLink: true,
      budgetUsd: 15,
      nowSec: NOW,
    });
    expect(link.ok).toBe(false);
    if (!link.ok) expect(link.reason).toContain("budget");
    // 同一余额下无链接帖 ($0.015) 仍放行 —— 拒绝的是超支,不是接近上限。
    expect(
      quotaDecision(db, {
        kind: "consensus",
        hasLink: false,
        budgetUsd: 15,
        nowSec: NOW,
      }).ok,
    ).toBe(true);
  });

  it("enforces per-kind daily caps (whale 20 / pregame 3), consensus uncapped", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < DAILY_CAP.whale; i++) {
      insert(db, {
        kind: "whale",
        dedup: `w${i}`,
        status: "posted",
        cost: COST_TEXT_USD,
        ts: NOW,
      });
    }
    const whale = quotaDecision(db, {
      kind: "whale",
      hasLink: false,
      budgetUsd: 15,
      nowSec: NOW,
    });
    expect(whale.ok).toBe(false);
    if (!whale.ok) expect(whale.reason).toContain("daily cap");
    // whale 满额不影响其他 kind。
    expect(
      quotaDecision(db, {
        kind: "pregame",
        hasLink: false,
        budgetUsd: 15,
        nowSec: NOW,
      }).ok,
    ).toBe(true);
    // consensus 无日上限(天然稀有),只受预算约束。
    for (let i = 0; i < 40; i++) {
      insert(db, {
        kind: "consensus",
        dedup: `c${i}`,
        status: "posted",
        cost: COST_TEXT_USD,
        ts: NOW,
      });
    }
    expect(
      quotaDecision(db, {
        kind: "consensus",
        hasLink: false,
        budgetUsd: 15,
        nowSec: NOW,
      }).ok,
    ).toBe(true);
  });

  it("a new UTC month resets the ledger", () => {
    const db = openDb(":memory:");
    const julyLast = Math.floor(Date.UTC(2026, 7, 1) / 1000) - 1;
    insert(db, {
      kind: "whale",
      dedup: "old",
      status: "posted",
      cost: 15,
      ts: julyLast,
    });
    expect(
      quotaDecision(db, {
        kind: "whale",
        hasLink: false,
        budgetUsd: 15,
        nowSec: NOW,
      }).ok,
    ).toBe(true);
  });
});

describe("插件通道(零成本 + 可覆盖日上限)", () => {
  const NOW = Math.floor(Date.UTC(2026, 7, 18, 12) / 1000);

  function seedPosted(db: DB, kind: string, n: number, cost: number) {
    for (let i = 0; i < n; i++) {
      db.prepare(
        `INSERT INTO x_posts (kind, dedup_key, text, has_link, est_cost_usd, status, created_at)
         VALUES (?, ?, '', 0, ?, 'posted', ?)`,
      ).run(kind, `${kind}-${cost}-${i}`, cost, NOW);
    }
  }

  it("caps 覆盖生效:常量 20 拒的,覆盖到 100 就放行", () => {
    const db = openDb(":memory:");
    seedPosted(db, "whale", 25, 0);
    expect(
      quotaDecision(db, {
        kind: "whale",
        hasLink: false,
        budgetUsd: 15,
        nowSec: NOW,
      }).ok,
    ).toBe(false);
    expect(
      quotaDecision(db, {
        kind: "whale",
        hasLink: false,
        budgetUsd: 15,
        nowSec: NOW,
        caps: { whale: 100, pregame: 6 },
      }).ok,
    ).toBe(true);
  });

  it("覆盖后的上限本身仍然生效(不是把 cap 关掉)", () => {
    const db = openDb(":memory:");
    seedPosted(db, "whale", 100, 0);
    const d = quotaDecision(db, {
      kind: "whale",
      hasLink: false,
      budgetUsd: 15,
      nowSec: NOW,
      caps: { whale: 100, pregame: 6 },
    });
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toContain("daily cap");
  });

  it("零成本帖不受月预算熔断影响 —— 否则「换插件继续发」整个失效", () => {
    // 本月 API 通道已把预算花超(0.015 × 1100 = $16.5 > $15)。插件通道的帖
    // 边际成本为零,却会被 `spent + 0 > budget` 拒掉 —— 那正好废掉切换通道
    // 的全部意义(用户切过来就是因为预算顶不住了)。
    const db = openDb(":memory:");
    seedPosted(db, "consensus", 1100, 0.015);
    expect(spentUsdInUtcMonth(db, NOW)).toBeGreaterThan(15);
    const d = quotaDecision(db, {
      kind: "consensus",
      hasLink: false,
      budgetUsd: 15,
      nowSec: NOW,
      caps: { whale: 100, pregame: 6 },
      costUsd: 0,
    });
    expect(d.ok).toBe(true);
  });
});
