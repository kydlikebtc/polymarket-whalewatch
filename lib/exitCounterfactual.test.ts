import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import {
  analyzeExitCounterfactual,
  EXIT_RULES,
  runExitSimBackfill,
  simulatePosition,
  withExitCounterfactual,
} from "./exitCounterfactual";

// 反事实退出分析(2026-08-16,设计见 docs/plans/2026-08-16-exit-counterfactual-
// design.md)。模拟语义的每一条都有真实反例背景:保守成交口径(蜡烛间隙)、
// 限时先于结算不触发、稀疏路径不触发、未触发回退实际 pnl。

const POS = {
  entryPrice: 0.6,
  entryTs: 1000,
  exitTs: 1000 + 10 * 86_400, // 10 天后结算
  realizedPnl: -500, // 实际持有到结算:归零
  sizeUsd: 500,
};
const pt = (t: number, p: number) => ({ t, p });

describe("EXIT_RULES 网格", () => {
  it("九条规则:SL/TP 各 10/20/30¢ + 限时 24/72/168h", () => {
    expect(EXIT_RULES.map((r) => r.id).sort()).toEqual([
      "sl10",
      "sl20",
      "sl30",
      "t168",
      "t24",
      "t72",
      "tp10",
      "tp20",
      "tp30",
    ]);
  });
});

describe("simulatePosition — 触发语义", () => {
  it("SL:首个越线观测点成交(保守口径:用观测价而非线价)", () => {
    const path = [
      pt(2000, 0.55), // 未到 sl10 线(0.5)
      pt(3000, 0.47), // 越线(≤0.5),观测价 0.47 < 线价 —— 按 0.47 成交
      pt(4000, 0.3),
    ];
    const { sims } = simulatePosition(POS, path);
    const sl10 = sims.sl10;
    expect(sl10.exited).toBe(1);
    expect(sl10.exitPrice).toBe(0.47);
    expect(sl10.exitOffsetSec).toBe(2000);
    // pnl = (500/0.6) × (0.47−0.6) ≈ −108.33
    expect(sl10.pnl).toBeCloseTo((500 / 0.6) * (0.47 - 0.6), 2);
    // sl30 线 0.3:首个 ≤0.3 的点是 t=4000。
    expect(sims.sl30.exited).toBe(1);
    expect(sims.sl30.exitOffsetSec).toBe(3000);
  });

  it("TP:首个 ≥ entry+X 的观测点成交;边界含等号", () => {
    const path = [pt(2000, 0.69), pt(3000, 0.7), pt(4000, 0.95)];
    const { sims } = simulatePosition(POS, path);
    expect(sims.tp10.exited).toBe(1);
    expect(sims.tp10.exitPrice).toBe(0.7); // 0.7 = 0.6+0.10,含等号
    expect(sims.tp10.exitOffsetSec).toBe(2000);
    expect(sims.tp30.exited).toBe(1);
    expect(sims.tp30.exitPrice).toBe(0.95);
  });

  it("限时:deadline 前的点不算,首个 t≥deadline 的观测点成交", () => {
    const path = [
      pt(1000 + 23 * 3600, 0.58),
      pt(1000 + 25 * 3600, 0.55), // t24 deadline 后首点
      pt(1000 + 80 * 3600, 0.4), // t72 deadline 后首点
    ];
    const { sims } = simulatePosition(POS, path);
    expect(sims.t24.exited).toBe(1);
    expect(sims.t24.exitPrice).toBe(0.55);
    expect(sims.t72.exited).toBe(1);
    expect(sims.t72.exitPrice).toBe(0.4);
  });

  it("限时先于结算才有意义:deadline ≥ exitTs 的规则不触发", () => {
    const fast = { ...POS, exitTs: 1000 + 20 * 3600 }; // 20h 就结算
    const path = [pt(2000, 0.6), pt(1000 + 19 * 3600, 0.6)];
    const { sims } = simulatePosition(fast, path);
    expect(sims.t24.exited).toBe(0);
    expect(sims.t24.pnl).toBe(fast.realizedPnl);
  });

  it("稀疏路径:deadline 后无观测点 → 不触发(points 披露兜底)", () => {
    const path = [pt(2000, 0.6)]; // 只有开头一个点
    const { sims } = simulatePosition(POS, path);
    expect(sims.t24.exited).toBe(0);
    expect(sims.t24.pnl).toBe(POS.realizedPnl);
  });

  it("未触发规则 pnl = 实际 realized_pnl(Δ 恒 0 的基准锚)", () => {
    const path = [pt(2000, 0.62), pt(3000, 0.58)]; // 任何线都不越
    const { sims } = simulatePosition(POS, path);
    for (const r of EXIT_RULES) {
      if (r.kind !== "time") {
        expect(sims[r.id].exited).toBe(0);
        expect(sims[r.id].pnl).toBe(POS.realizedPnl);
      }
    }
  });

  it("路径按 t 排序且剔除区间外/非法点;MAE/MFE 以 entry 为基准", () => {
    const path = [
      pt(3000, 0.7), // 乱序输入
      pt(500, 0.99), // entryTs 之前 → 剔除
      pt(2000, 0.5),
      pt(POS.exitTs + 100, 0.01), // 结算之后 → 剔除
      { t: 2500, p: Number.NaN }, // 非法 → 剔除
    ];
    const { stats } = simulatePosition(POS, path);
    expect(stats.points).toBe(2);
    expect(stats.maeCents).toBeCloseTo((0.5 - 0.6) * 100, 6); // −10
    expect(stats.mfeCents).toBeCloseTo((0.7 - 0.6) * 100, 6); // +10
  });

  it("空路径:points=0,MAE/MFE null,规则全不触发", () => {
    const { sims, stats } = simulatePosition(POS, []);
    expect(stats.points).toBe(0);
    expect(stats.maeCents).toBeNull();
    expect(stats.mfeCents).toBeNull();
    expect(Object.values(sims).every((s) => s.exited === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

const insertSettled = (
  db: ReturnType<typeof openDb>,
  o: { id?: number; cid: string; entryTs: number; exitTs: number; pnl: number },
) => {
  db.prepare(
    `INSERT INTO follow_positions (strategy_id, condition_id, outcome, asset, outcome_index, title, event_slug, entry_ts, entry_price, smart_avg_price, size_usd, shares, status, exit_ts, exit_price, realized_pnl)
     VALUES (1, ?, 'Yes', 'tok-' || ?, 0, 'T', 'e', ?, 0.6, 0.58, 500, 833, 'settled', ?, 0, ?)`,
  ).run(o.cid, o.cid, o.entryTs, o.exitTs, o.pnl);
  return (
    db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }
  ).id;
};

describe("runExitSimBackfill — 回填纪律", () => {
  it("每轮封顶 batch 仓、新结算优先;写 sims+stats 后出队", async () => {
    const db = openDb(":memory:");
    const ids = [1, 2, 3].map((i) =>
      insertSettled(db, {
        cid: `c${i}`,
        entryTs: 1000,
        exitTs: 1000 + i * 86_400,
        pnl: -500,
      }),
    );
    const fetchSeries = vi.fn(async () => [pt(2000, 0.5), pt(3000, 0.7)]);
    const r1 = await runExitSimBackfill(db, { fetchSeries, batch: 2 });
    expect(r1.processed).toBe(2);
    expect(fetchSeries).toHaveBeenCalledTimes(2);
    // 新结算优先:exit_ts 最大的 c3、c2 先回填。
    const filled = db
      .prepare(
        "SELECT position_id FROM position_path_stats ORDER BY position_id",
      )
      .all() as { position_id: number }[];
    expect(filled.map((f) => f.position_id)).toEqual([ids[1], ids[2]].sort());
    const r2 = await runExitSimBackfill(db, { fetchSeries, batch: 2 });
    expect(r2.processed).toBe(1);
    const simCount = (
      db.prepare("SELECT COUNT(*) AS n FROM position_exit_sims").get() as {
        n: number;
      }
    ).n;
    expect(simCount).toBe(3 * EXIT_RULES.length);
    // 全部出队后 no-op。
    const r3 = await runExitSimBackfill(db, { fetchSeries, batch: 2 });
    expect(r3.processed).toBe(0);
    db.close();
  });

  it("空路径 → points=0 永久出队且不写 sims(死 token 不占坑不空烧)", async () => {
    const db = openDb(":memory:");
    const id = insertSettled(db, {
      cid: "dead",
      entryTs: 1000,
      exitTs: 90_000,
      pnl: -500,
    });
    const fetchSeries = vi.fn(async () => []);
    await runExitSimBackfill(db, { fetchSeries, batch: 5 });
    const stats = db
      .prepare("SELECT points FROM position_path_stats WHERE position_id = ?")
      .get(id) as { points: number };
    expect(stats.points).toBe(0);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM position_exit_sims").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    const again = await runExitSimBackfill(db, { fetchSeries, batch: 5 });
    expect(again.processed).toBe(0);
    expect(fetchSeries).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("抛错 → 本轮跳过留队,下轮重试成功", async () => {
    const db = openDb(":memory:");
    insertSettled(db, { cid: "c1", entryTs: 1000, exitTs: 90_000, pnl: 10 });
    const fetchSeries = vi
      .fn()
      .mockRejectedValueOnce(new Error("CLOB 5xx"))
      .mockResolvedValue([pt(2000, 0.6)]);
    const r1 = await runExitSimBackfill(db, { fetchSeries, batch: 5 });
    expect(r1.processed).toBe(0);
    expect(r1.failed).toBe(1);
    const r2 = await runExitSimBackfill(db, { fetchSeries, batch: 5 });
    expect(r2.processed).toBe(1);
    db.close();
  });
});

describe("analyzeExitCounterfactual — 聚合口径", () => {
  it("每规则:触发数/假想合计/Δ/触发仓均Δ;覆盖率与点数中位数", () => {
    const rows = [
      { id: 1, realizedPnl: -500 },
      { id: 2, realizedPnl: 300 },
      { id: 3, realizedPnl: 100 }, // 无 sims(未回填)
    ];
    const simsById = new Map([
      [1, { sl20: { exited: 1, pnl: -150 }, t72: { exited: 0, pnl: -500 } }],
      [2, { sl20: { exited: 1, pnl: -80 }, t72: { exited: 1, pnl: 120 } }],
    ]);
    const statsById = new Map([
      [1, { points: 40 }],
      [2, { points: 100 }],
    ]);
    const a = analyzeExitCounterfactual(rows, simsById, statsById);
    expect(a).not.toBeNull();
    expect(a!.covered).toBe(2);
    expect(a!.settledTotal).toBe(3);
    expect(a!.medianPoints).toBe(70);
    const sl20 = a!.rules.find((r) => r.rule === "sl20")!;
    expect(sl20.triggered).toBe(2);
    // 实际(covered 内):-500+300=-200;假想:-150+(-80)=-230;Δ=-30(止损更差)。
    expect(sl20.actualTotal).toBeCloseTo(-200);
    expect(sl20.simTotal).toBeCloseTo(-230);
    expect(sl20.delta).toBeCloseTo(-30);
    // 触发仓均 Δ:((-150−(−500)) + (−80−300))/2 = (350−380)/2 = −15。
    expect(sl20.avgDeltaTriggered).toBeCloseTo(-15);
    const t72 = a!.rules.find((r) => r.rule === "t72")!;
    expect(t72.triggered).toBe(1);
    // t72:sim = −500(未触发回退实际)+120 = −380;actual = −200;Δ = −180。
    expect(t72.delta).toBeCloseTo(-380 - -200);
  });

  it("零覆盖 → null(面板整块省略,回填中不硬画)", () => {
    expect(
      analyzeExitCounterfactual(
        [{ id: 1, realizedPnl: 5 }],
        new Map(),
        new Map(),
      ),
    ).toBeNull();
  });
});

describe("withExitCounterfactual — 视图附加", () => {
  it("回填过的仓进摘要;未回填/墓碑仓不进;零覆盖档得 null;不改入参", async () => {
    const db = openDb(":memory:");
    const a = insertSettled(db, { cid: "a", entryTs: 1000, exitTs: 90_000, pnl: -500 });
    const b = insertSettled(db, { cid: "b", entryTs: 1000, exitTs: 90_000, pnl: 300 });
    // a 回填出真实路径;b 留在队列(未回填)。
    await runExitSimBackfill(db, {
      fetchSeries: async () => [{ t: 2000, p: 0.3 }],
      batch: 1,
    });
    const views = [
      {
        name: "档一",
        settled: [
          { id: a, realized_pnl: -500 },
          { id: b, realized_pnl: 300 },
        ],
      },
      { name: "空档", settled: [] },
    ];
    const out = withExitCounterfactual(db, views);
    expect(out[0].exitCounterfactual).not.toBeNull();
    expect(out[0].exitCounterfactual!.covered).toBe(1);
    expect(out[0].exitCounterfactual!.settledTotal).toBe(2);
    // 0.3 ≤ 0.6−0.3:sl30 触发。
    const sl30 = out[0].exitCounterfactual!.rules.find((r) => r.rule === "sl30")!;
    expect(sl30.triggered).toBe(1);
    expect(out[1].exitCounterfactual).toBeNull();
    // 不可变纪律:入参对象未被写入新字段。
    expect("exitCounterfactual" in views[0]).toBe(false);
    db.close();
  });
});
