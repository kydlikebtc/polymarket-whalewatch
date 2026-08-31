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

  it("enforces per-kind daily caps — consensus included (uncapped only when the operator says so)", () => {
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
    // consensus 出厂也有上限(首版「天然稀有 ⇒ 不限」已被线上数据证伪)。
    for (let i = 0; i < DAILY_CAP.consensus; i++) {
      insert(db, {
        kind: "consensus",
        dedup: `c${i}`,
        status: "posted",
        cost: COST_TEXT_USD,
        ts: NOW,
      });
    }
    const consensus = quotaDecision(db, {
      kind: "consensus",
      hasLink: false,
      budgetUsd: 15,
      nowSec: NOW,
    });
    expect(consensus.ok).toBe(false);
    if (!consensus.ok) expect(consensus.reason).toContain("daily cap");
    // 「不限」仍然表达得出来 —— 运营者显式传 null 即可(/manage 的空输入)。
    expect(
      quotaDecision(db, {
        kind: "consensus",
        hasLink: false,
        budgetUsd: 15,
        nowSec: NOW,
        dailyCap: null,
      }).ok,
    ).toBe(true);
  });

  // 线上实测(2026-08-31 @PolyWhaleFeedHQ):共识出厂「不限」是每天约 96 条
  // 帖的主要来源(14 小时里 22 条共识),而每帖只有约 11 次浏览、0 点赞。
  // 出厂默认必须自带天花板 —— 「稀有」是对信号的假设,不是对发帖量的保证。
  it("每一类都有出厂日上限,四类合计 ≤ 25 条/天", () => {
    for (const kind of ["whale", "consensus", "pregame", "settled"]) {
      expect(DAILY_CAP[kind]).toBeGreaterThanOrEqual(1);
    }
    const total =
      DAILY_CAP.whale +
      DAILY_CAP.consensus +
      DAILY_CAP.pregame +
      DAILY_CAP.settled;
    expect(total).toBeLessThanOrEqual(25);
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

describe("quotaDecision dailyCap 覆盖(/manage 可配,lib/xParams)", () => {
  const base = { kind: "whale", hasLink: false, budgetUsd: 15, nowSec: NOW };

  it("显式数字覆盖出厂 cap:whale 出厂 20,覆盖为 1 后第二条即拒", () => {
    const db = openDb(":memory:");
    insert(db, {
      kind: "whale",
      dedup: "a",
      status: "posted",
      cost: 0.015,
      ts: NOW,
    });
    expect(quotaDecision(db, base).ok).toBe(true); // 出厂 20 远未到
    const r = quotaDecision(db, { ...base, dailyCap: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("daily cap");
  });

  it("null = 明确不限:whale 已发 25 条(超出厂 20)仍放行", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 25; i++) {
      insert(db, {
        kind: "whale",
        dedup: `d${i}`,
        status: "posted",
        cost: 0.015,
        ts: NOW,
      });
    }
    expect(quotaDecision(db, base).ok).toBe(false); // 出厂 cap 拦下
    expect(quotaDecision(db, { ...base, dailyCap: null }).ok).toBe(true);
  });

  it("consensus 出厂不限(undefined 保持既有行为),覆盖为数字后受限", () => {
    const db = openDb(":memory:");
    insert(db, {
      kind: "consensus",
      dedup: "c1",
      status: "posted",
      cost: 0.015,
      ts: NOW,
    });
    const cBase = { ...base, kind: "consensus" };
    expect(quotaDecision(db, cBase).ok).toBe(true);
    expect(quotaDecision(db, { ...cBase, dailyCap: 1 }).ok).toBe(false);
  });
});

describe("日/周花费上限(dailySpendCapUsd/weeklySpendCapUsd,/manage 可配)", () => {
  const base = { kind: "whale", hasLink: false, budgetUsd: 15, nowSec: NOW };

  it("日花费:今天已花 $0.03,cap $0.04 → 再发一条 $0.015 被拒;昨天的不计", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 2; i++) {
      insert(db, {
        kind: "whale",
        dedup: `t${i}`,
        status: "posted",
        cost: 0.015,
        ts: NOW - i * 60,
      });
    }
    // 昨天花了 $10:月预算里算,日 cap 不算。
    insert(db, {
      kind: "weekly",
      dedup: "y",
      status: "posted",
      cost: 10,
      ts: NOW - 86400,
    });
    const r = quotaDecision(db, { ...base, dailySpendCapUsd: 0.04 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("daily spend cap");
    // cap 提到 $0.05(0.03+0.015 ≤ 0.05)→ 放行:昨天的 $10 确实没进日窗。
    expect(quotaDecision(db, { ...base, dailySpendCapUsd: 0.05 }).ok).toBe(
      true,
    );
    // null/省略 = 不限。
    expect(quotaDecision(db, { ...base, dailySpendCapUsd: null }).ok).toBe(
      true,
    );
    expect(quotaDecision(db, base).ok).toBe(true);
  });

  it("周花费:UTC 周一为界 —— 上周日的花费不进本周窗", () => {
    const db = openDb(":memory:");
    // NOW = 2026-08-15(周六);本周一 = 08-10。上周日 08-09 花 $1。
    const sunday = Math.floor(Date.UTC(2026, 7, 9, 12) / 1000);
    insert(db, {
      kind: "whale",
      dedup: "lastweek",
      status: "posted",
      cost: 1,
      ts: sunday,
    });
    // 本周三 08-12 花 $0.03。
    insert(db, {
      kind: "whale",
      dedup: "wed",
      status: "posted",
      cost: 0.03,
      ts: Math.floor(Date.UTC(2026, 7, 12, 8) / 1000),
    });
    const r = quotaDecision(db, { ...base, weeklySpendCapUsd: 0.04 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("weekly spend cap");
    // 若上周日的 $1 被错算进本周,0.05 的 cap 也拦;实际应放行。
    expect(quotaDecision(db, { ...base, weeklySpendCapUsd: 0.05 }).ok).toBe(
      true,
    );
  });
});
