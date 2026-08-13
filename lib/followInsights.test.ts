import { describe, expect, it } from "vitest";
import { BUCKET_LOW_SAMPLE_N, type AnalysisPosition } from "./followAnalysis";
import { buildEdgeMatrix, diagnoseSegments } from "./followInsights";

// 造仓工具(与 followAnalysis.test 同构):默认已结算、$500/仓、50¢ 入场。
function pos(over: Partial<AnalysisPosition> = {}): AnalysisPosition {
  return {
    status: "settled",
    entry_price: 0.5,
    size_usd: 500,
    realized_pnl: 0,
    entry_ts: 1000,
    exit_ts: 4600,
    category: null,
    subcategory: null,
    ...over,
  };
}

// 批量造段:同一细赛道/入场价/时长下 wins 胜 + losses 负。
function batch(
  n: { wins: number; losses: number },
  over: Partial<AnalysisPosition> = {},
): AnalysisPosition[] {
  const out: AnalysisPosition[] = [];
  for (let i = 0; i < n.wins; i++) {
    out.push(pos({ realized_pnl: 100, exit_ts: 5000 + i, ...over }));
  }
  for (let i = 0; i < n.losses; i++) {
    out.push(pos({ realized_pnl: -500, exit_ts: 9000 + i, ...over }));
  }
  return out;
}

describe("buildEdgeMatrix — 赛道 × 策略透视", () => {
  it("列按全体样本数降序;格子对齐;零仓 → null;open 仓不进", () => {
    const s1 = [
      // Sports|NBA:3 胜 2 负 @0.5 → 实际 60%,隐含 50%,edge +0.1
      ...batch(
        { wins: 3, losses: 2 },
        { category: "Sports", subcategory: "NBA" },
      ),
      // Sports|(未细分):1 胜
      ...batch({ wins: 1, losses: 0 }, { category: "Sports" }),
      pos({
        status: "open",
        realized_pnl: null,
        exit_ts: null,
        category: "Sports",
        subcategory: "NBA",
      }),
    ];
    const s2 = [
      // Crypto|Bitcoin:1 负
      ...batch(
        { wins: 0, losses: 1 },
        { category: "Crypto", subcategory: "Bitcoin" },
      ),
      // Sports|NBA:1 胜 1 平(push 进 n 不进胜率分母)
      ...batch(
        { wins: 1, losses: 0 },
        { category: "Sports", subcategory: "NBA" },
      ),
      pos({
        category: "Sports",
        subcategory: "NBA",
        realized_pnl: 0,
        exit_ts: 12000,
      }),
    ];
    const m = buildEdgeMatrix([
      { id: 1, name: "保守", positions: s1 },
      { id: 2, name: "激进", positions: s2 },
    ]);
    // 全体样本:NBA 5+2=7、Sports 未细分 1、Bitcoin 1 → NBA 第一,
    // 后两者同 n,按 category 字典序 Crypto < Sports。
    expect(m.tracks.map((t) => t.key)).toEqual([
      "Sports|NBA",
      "Crypto|Bitcoin",
      "Sports|",
    ]);
    expect(m.tracks[0].totalN).toBe(7);
    expect(m.rows.map((r) => r.name)).toEqual(["保守", "激进"]);
    const nba1 = m.rows[0].cells[0]!;
    expect(nba1.n).toBe(5);
    expect(nba1.winRate).toBeCloseTo(0.6, 10);
    expect(nba1.avgEntry).toBeCloseTo(0.5, 10);
    expect(nba1.edge).toBeCloseTo(0.1, 10);
    expect(nba1.realized).toBeCloseTo(3 * 100 - 2 * 500, 10);
    // 保守在 Bitcoin 零仓 → null;激进在 Sports 未细分零仓 → null。
    expect(m.rows[0].cells[1]).toBeNull();
    expect(m.rows[1].cells[2]).toBeNull();
    // 激进 NBA:1 胜 1 平 → n=2,胜率 100%(平不进分母)。
    const nba2 = m.rows[1].cells[0]!;
    expect(nba2.n).toBe(2);
    expect(nba2.pushes).toBe(1);
    expect(nba2.winRate).toBe(1);
  });

  it("全无已结算 → tracks 空、各行 cells 空", () => {
    const m = buildEdgeMatrix([
      {
        id: 1,
        name: "保守",
        positions: [pos({ status: "open", realized_pnl: null, exit_ts: null })],
      },
    ]);
    expect(m.tracks).toEqual([]);
    expect(m.rows[0].cells).toEqual([]);
  });
});

describe("diagnoseSegments — 分段缺陷诊断", () => {
  it("判定边界:n≥阈值且落袋<0 才进;n=4 不进", () => {
    const bad = batch(
      { wins: 1, losses: 4 }, // n=5,realized = 100-2000 = -1900
      { category: "Sports", subcategory: "Soccer" },
    );
    const small = batch(
      { wins: 0, losses: 4 }, // n=4,再亏也不进(样本不足)
      { category: "Crypto", subcategory: "XRP" },
    );
    const d = diagnoseSegments([...bad, ...small]);
    const trackWeak = d.weaknesses.filter((w) => w.dimension === "track");
    expect(trackWeak.map((w) => [w.category, w.subcategory])).toEqual([
      ["Sports", "Soccer"],
    ]);
    expect(trackWeak[0].n).toBe(BUCKET_LOW_SAMPLE_N);
    expect(trackWeak[0].realized).toBeCloseTo(-1900, 10);
    // 反事实:总净额 -1900 + (-2000) = -3900;剔除 Soccer 段 → -2000。
    expect(d.totalRealized).toBeCloseTo(-3900, 10);
    expect(trackWeak[0].totalWithout).toBeCloseTo(-2000, 10);
  });

  it("三维度都扫:同一批仓可同时产出赛道/时长/赔率带亏损段(互有重叠)", () => {
    // 5 仓全亏,同赛道、同 2h 时长(<6h 桶)、同 0.5 入场(40-60¢ 桶)。
    const rows = batch(
      { wins: 0, losses: 5 },
      {
        category: "Sports",
        subcategory: "NBA",
        entry_ts: 1000,
        exit_ts: 1000 + 7200,
      },
    ).map((p, i) => ({ ...p, exit_ts: 1000 + 7200 + i })); // exit 微错开
    const d = diagnoseSegments(rows);
    const dims = d.weaknesses.map((w) => w.dimension).sort();
    expect(dims).toEqual(["duration", "odds", "track"].sort());
    const dur = d.weaknesses.find((w) => w.dimension === "duration")!;
    expect(dur.label).toBe("<6 小时");
    const odds = d.weaknesses.find((w) => w.dimension === "odds")!;
    expect(odds.label).toBe("40–60¢");
  });

  it("排序按落袋升序(最亏在前),超过 5 段截断", () => {
    const rows: AnalysisPosition[] = [];
    // 6 个赛道段全亏(A=-2500,B=-2400,…,E=-2100,F=-1600),入场价/时长
    // 全同 → 时长与赔率带各自聚成一个更亏的大段(-13100),也参与同一个
    // cap 排序;所以 5 段上限里必然是 [时长, 赔率带, A, B, C]。
    const cats = ["A", "B", "C", "D", "E", "F"];
    cats.forEach((c, i) => {
      rows.push(
        ...batch(
          { wins: i >= 5 ? 4 : i, losses: 5 - (i >= 5 ? 1 : 0) },
          {
            category: c,
          },
        ),
      );
    });
    const d = diagnoseSegments(rows);
    const trackWeak = d.weaknesses.filter((w) => w.dimension === "track");
    // cap 5 里最亏的两位是时长/赔率带大段,赛道段只剩最亏的前几个 ——
    // 只断言 A(最亏赛道)仍在、整体升序、总数不超上限。
    expect(trackWeak.map((w) => w.category)).toEqual(
      expect.arrayContaining(["A"]),
    );
    const vals = d.weaknesses.map((w) => w.realized);
    expect(vals).toEqual([...vals].sort((a, b) => a - b));
    expect(d.weaknesses.length).toBeLessThanOrEqual(5);
  });

  it("edge≥0 的亏损段照样进(短期波动也要看见),edge 值供 UI 标注", () => {
    // 入场 0.2 的仓:2 胜 3 负 → 实际 40% > 隐含 20%(edge>0)但净亏
    // (100*2 - 500*3 = -1300)。
    const d = diagnoseSegments(
      batch(
        { wins: 2, losses: 3 },
        { category: "Sports", subcategory: "MLB", entry_price: 0.2 },
      ),
    );
    const w = d.weaknesses.find((x) => x.dimension === "track")!;
    expect(w.realized).toBeCloseTo(-1300, 10);
    expect(w.edge).toBeCloseTo(0.4 - 0.2, 10);
  });

  it("最强特征:n≥阈值且落袋>0 且 edge>0,取落袋最大;无则 null", () => {
    const strong = batch(
      { wins: 4, losses: 1 }, // +100*4-500 = -100?不行 —— 用大赢仓
      { category: "Crypto", subcategory: "Bitcoin", entry_price: 0.4 },
    ).map((p) => (p.realized_pnl! > 0 ? { ...p, realized_pnl: 750 } : p));
    // 4×750 - 500 = +2500;实际 80% vs 隐含 40% → edge>0。
    const d = diagnoseSegments(strong);
    expect(d.strongest).not.toBeNull();
    expect(d.strongest!.category).toBe("Crypto");
    expect(d.strongest!.realized).toBeCloseTo(2500, 10);
    expect(diagnoseSegments([]).strongest).toBeNull();
  });

  it("无符合条件的段 → weaknesses 空、strongest null(不硬凑)", () => {
    const d = diagnoseSegments(
      batch({ wins: 2, losses: 1 }, { category: "Sports" }), // n=3 全不够
    );
    expect(d.weaknesses).toEqual([]);
    expect(d.strongest).toBeNull();
  });
});
