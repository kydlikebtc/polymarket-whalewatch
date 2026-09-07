import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import {
  TG_CONTENT_POST_UTC_HOUR,
  composePulseMessage,
  composeScorecardMessage,
  composeWeeklyMessage,
  pickTgScorecardRows,
  runTgContentCycle,
} from "./tgContent";

const PUBLIC_URL = "https://example.test";
// 第 200 天 00:00 UTC 起算;+14h 过内容帖时刻闸。
const DAY0 = 200 * 86_400;
const AT_HOUR = TG_CONTENT_POST_UTC_HOUR * 3600 + 60;
const utcDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

function seedMarketDay(
  db: ReturnType<typeof openDb>,
  day: string,
  over: Record<string, unknown> = {},
): void {
  const row = {
    day,
    condition_id: "0xcid1",
    title: "谁会赢",
    slug: "s",
    event_slug: "e",
    category: "体育",
    subcategory: "NBA",
    trades: 100,
    volume_usd: 500_000,
    wallet_count: 40,
    top_outcome: "Yes",
    one_sided: 0.8,
    small_usd: 20_000,
    small_net_usd: 8_000,
    small_top_outcome: "Yes",
    whale_usd: 200_000,
    whale_net_usd: -120_000,
    whale_top_outcome: "No",
    price_first: 0.4,
    price_last: 0.6,
    covered_from_sec: Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000),
    truncated: 0,
    wash_usd: 0,
    max_fill_usd: 80_000,
    ...over,
  };
  db.prepare(
    `INSERT OR REPLACE INTO market_daily
       (day, condition_id, title, slug, event_slug, category, subcategory,
        trades, volume_usd, wallet_count, top_outcome, one_sided,
        small_usd, small_net_usd, small_top_outcome,
        whale_usd, whale_net_usd, whale_top_outcome,
        price_first, price_last, covered_from_sec, truncated, wash_usd, max_fill_usd)
     VALUES (@day,@condition_id,@title,@slug,@event_slug,@category,@subcategory,
             @trades,@volume_usd,@wallet_count,@top_outcome,@one_sided,
             @small_usd,@small_net_usd,@small_top_outcome,
             @whale_usd,@whale_net_usd,@whale_top_outcome,
             @price_first,@price_last,@covered_from_sec,@truncated,@wash_usd,@max_fill_usd)`,
  ).run(row);
}

function seedSettledAlert(
  db: ReturnType<typeof openDb>,
  o: { id: number; title: string; won: boolean; checkedAt: number; price?: number },
): void {
  db.prepare(
    "INSERT INTO alerts (id, type, dedup_key, payload, created_at) VALUES (?, 'smart', ?, ?, ?)",
  ).run(
    o.id,
    `k${o.id}`,
    JSON.stringify({ title: o.title, price: o.price ?? 0.5, side: "BUY" }),
    o.checkedAt - 3600,
  );
  db.prepare(
    "INSERT INTO alert_outcomes (alert_id, resolved, won, checked_at) VALUES (?, 1, ?, ?)",
  ).run(o.id, o.won ? 1 : 0, o.checkedAt);
}

describe("composePulseMessage", () => {
  it("日榜 + 分歧合成一条,带可点链接与口径行", () => {
    const html = composePulseMessage({
      day: "2026-09-06",
      top: [
        {
          conditionId: "0xabc",
          title: "谁会赢",
          score: 87.4,
          volumeUsd: 512_345,
          volRatio: 3.2,
          oneSidedPct: 81.2,
        },
      ],
      divergences: [
        {
          conditionId: "0xdef",
          title: "另一场",
          smallTopOutcome: "Yes",
          smallNetUsd: 12_000,
          whaleTopOutcome: "No",
          whaleNetUsd: -80_000,
        },
      ],
      publicUrl: PUBLIC_URL,
    });
    expect(html).toContain("市场脉搏 2026-09-06");
    expect(html).toContain(`${PUBLIC_URL}/market/0xabc`);
    expect(html).toContain("量能 ×3.2");
    expect(html).toContain("小单 vs 鲸鱼分歧");
    // 口径必须随卡出:这是市场汇总,不是本站信号。
    expect(html).toContain("不是信号");
  });

  it("没有分歧的日子不出那一节(分歧线天然稀疏,不是故障)", () => {
    const html = composePulseMessage({
      day: "2026-09-06",
      top: [
        {
          conditionId: "0xabc",
          title: "T",
          score: 50,
          volumeUsd: 10_000,
          volRatio: null,
          oneSidedPct: 10,
        },
      ],
      divergences: [],
      publicUrl: PUBLIC_URL,
    });
    expect(html).not.toContain("小单 vs 鲸鱼分歧");
  });

  it("HTML 特殊字符转义 —— 一条脏标题不该毒死整条消息", () => {
    const html = composePulseMessage({
      day: "2026-09-06",
      top: [
        {
          conditionId: "0xabc",
          title: "A & B <script>",
          score: 1,
          volumeUsd: 1,
          volRatio: null,
          oneSidedPct: 0,
        },
      ],
      divergences: [],
      publicUrl: PUBLIC_URL,
    });
    expect(html).toContain("A &amp; B &lt;script&gt;");
  });
});

describe("pickTgScorecardRows", () => {
  it("赢输交替取 —— 有输单时卡上一定看得见", () => {
    const rows = [
      { title: "w1", won: true, entryPrice: 0.5 },
      { title: "w2", won: true, entryPrice: 0.5 },
      { title: "w3", won: true, entryPrice: 0.5 },
      { title: "l1", won: false, entryPrice: 0.5 },
    ];
    const picked = pickTgScorecardRows(rows, 3);
    expect(picked.map((r) => r.title)).toEqual(["w1", "l1", "w2"]);
  });

  it("全赢的日子照常返回,不硬凑输单", () => {
    const rows = [
      { title: "w1", won: true, entryPrice: 0.5 },
      { title: "w2", won: true, entryPrice: 0.5 },
    ];
    expect(pickTgScorecardRows(rows).map((r) => r.title)).toEqual(["w1", "w2"]);
  });
});

describe("composeScorecardMessage", () => {
  it("把分母写进消息 —— 与 X 版口径不同,混着读会得出错的结论", () => {
    const html = composeScorecardMessage({
      day: "2026-09-06",
      settled: 12,
      wins: 8,
      rows: [{ title: "T", won: true, entryPrice: 0.42 }],
    });
    expect(html).toContain("12 条结算 · 8 条命中 · 67%");
    expect(html).toContain("告警台账");
    expect(html).toContain("@ 42¢");
  });
});

describe("composeWeeklyMessage", () => {
  it("纸面口径与两条入口链接都在", () => {
    const html = composeWeeklyMessage({
      weekLabel: "Sep 1–Sep 8",
      settled: 30,
      wins: 12,
      losses: 18,
      winRatePct: 40,
      pnlUsd: -1234,
      rows: [{ name: "巨鲸", settled: 10, pnlUsd: -500, roiPct: -12.3 }],
      publicUrl: PUBLIC_URL,
    });
    expect(html).toContain("胜率 40%");
    expect(html).toContain("纸面模拟,零真实资金");
    expect(html).toContain(`${PUBLIC_URL}/follow`);
    expect(html).toContain("−12.3%");
  });
});

describe("runTgContentCycle", () => {
  it("到点后发日榜,同日第二次不再发(claim-first 日门)", async () => {
    const db = openDb(":memory:");
    seedMarketDay(db, utcDay(DAY0 - 86_400));
    const sent: string[] = [];
    const deps = {
      db,
      senders: {
        pulse: async (h: string) => {
          sent.push(h);
        },
      },
      publicUrl: PUBLIC_URL,
      nowSec: DAY0 + AT_HOUR,
    };
    expect(await runTgContentCycle(deps)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await runTgContentCycle({ ...deps, nowSec: DAY0 + AT_HOUR + 600 })).toBe(0);
    db.close();
  });

  it("时刻闸未到不发,也不消耗当日", async () => {
    const db = openDb(":memory:");
    seedMarketDay(db, utcDay(DAY0 - 86_400));
    const sent: string[] = [];
    const senders = {
      pulse: async (h: string) => {
        sent.push(h);
      },
    };
    expect(
      await runTgContentCycle({
        db,
        senders,
        publicUrl: PUBLIC_URL,
        nowSec: DAY0 + 3600,
      }),
    ).toBe(0);
    expect(
      await runTgContentCycle({
        db,
        senders,
        publicUrl: PUBLIC_URL,
        nowSec: DAY0 + AT_HOUR,
      }),
    ).toBe(1);
    db.close();
  });

  it("聚合还停在前天 → 不发(永不补发旧闻)", async () => {
    const db = openDb(":memory:");
    // 最新的一天是前天,不是昨天。
    seedMarketDay(db, utcDay(DAY0 - 2 * 86_400));
    const sent: string[] = [];
    const n = await runTgContentCycle({
      db,
      senders: {
        pulse: async (h: string) => {
          sent.push(h);
        },
      },
      publicUrl: PUBLIC_URL,
      nowSec: DAY0 + AT_HOUR,
    });
    expect(n).toBe(0);
    expect(sent).toHaveLength(0);
    db.close();
  });

  it("无人订阅该类 → 整段跳过(sender 为 undefined)", async () => {
    const db = openDb(":memory:");
    seedMarketDay(db, utcDay(DAY0 - 86_400));
    expect(
      await runTgContentCycle({
        db,
        senders: {},
        publicUrl: PUBLIC_URL,
        nowSec: DAY0 + AT_HOUR,
      }),
    ).toBe(0);
    db.close();
  });

  it("战报:昨日有结算就发,口径是告警台账", async () => {
    const db = openDb(":memory:");
    const yStart = DAY0 - 86_400;
    seedSettledAlert(db, {
      id: 1,
      title: "赢的那条",
      won: true,
      checkedAt: yStart + 100,
      price: 0.42,
    });
    seedSettledAlert(db, {
      id: 2,
      title: "输的那条",
      won: false,
      checkedAt: yStart + 200,
    });
    const sent: string[] = [];
    const n = await runTgContentCycle({
      db,
      senders: {
        scorecard: async (h: string) => {
          sent.push(h);
        },
      },
      publicUrl: PUBLIC_URL,
      nowSec: DAY0 + AT_HOUR,
    });
    expect(n).toBe(1);
    expect(sent[0]).toContain("2 条结算 · 1 条命中");
    // 有输单必须看得见 —— 只列赢单的成绩单当场破产。
    expect(sent[0]).toContain("输的那条");
    db.close();
  });

  it("战报:0 结算的日子静默", async () => {
    const db = openDb(":memory:");
    const sent: string[] = [];
    const n = await runTgContentCycle({
      db,
      senders: {
        scorecard: async (h: string) => {
          sent.push(h);
        },
      },
      publicUrl: PUBLIC_URL,
      nowSec: DAY0 + AT_HOUR,
    });
    expect(n).toBe(0);
    db.close();
  });

  it("发送失败不抛,且不重复轰炸(日门已 claim)", async () => {
    const db = openDb(":memory:");
    seedMarketDay(db, utcDay(DAY0 - 86_400));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn(async () => {
      throw new Error("chat not found");
    });
    const deps = {
      db,
      senders: { pulse: failing },
      publicUrl: PUBLIC_URL,
      nowSec: DAY0 + AT_HOUR,
    };
    await expect(runTgContentCycle(deps)).resolves.toBe(0);
    // 下一轮不再重试:一条日榜的价值不值得冒重复轰炸频道的风险。
    await runTgContentCycle({ ...deps, nowSec: DAY0 + AT_HOUR + 600 });
    expect(failing).toHaveBeenCalledOnce();
    err.mockRestore();
    db.close();
  });

  it("周报只在周一发,且空周静默", async () => {
    const db = openDb(":memory:");
    const sent: string[] = [];
    const senders = {
      weekly: async (h: string) => {
        sent.push(h);
      },
    };
    // DAY0 起找一个周一。
    let monday = DAY0;
    while (new Date(monday * 1000).getUTCDay() !== 1) monday += 86_400;
    // 空周:一笔已结算仓都没有 → 不发。
    expect(
      await runTgContentCycle({
        db,
        senders,
        publicUrl: PUBLIC_URL,
        nowSec: monday + 14 * 3600,
      }),
    ).toBe(0);
    // 补一笔已结算仓后再跑。
    const sid = (
      db
        .prepare("SELECT id FROM follow_strategies WHERE name = '巨鲸'")
        .get() as { id: number }
    ).id;
    db.prepare(
      `INSERT INTO follow_positions
         (strategy_id, condition_id, outcome, status, exit_ts, realized_pnl, size_usd)
       VALUES (?, '0xc', 'Yes', 'settled', ?, 120, 500)`,
    ).run(sid, monday + 14 * 3600 - 3600);
    expect(
      await runTgContentCycle({
        db,
        senders,
        publicUrl: PUBLIC_URL,
        nowSec: monday + 14 * 3600,
      }),
    ).toBe(1);
    expect(sent[0]).toContain("周报成绩单");
    // 周二不再发。
    expect(
      await runTgContentCycle({
        db,
        senders,
        publicUrl: PUBLIC_URL,
        nowSec: monday + 86_400 + 14 * 3600,
      }),
    ).toBe(0);
    db.close();
  });
});
