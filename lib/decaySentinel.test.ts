import { describe, it, expect } from "vitest";
import {
  clusterMarketPoints,
  decayVerdict,
  DECAY_BASE_MIN,
  DECAY_MONITOR_MIN,
} from "./decaySentinel";

// 衰变哨兵(第一梯队五件套):每档策略已结算仓 → 市场级观察点 → 单侧 CUSUM
// 检测下行漂移。逐仓贡献与 walk-forward contribOf 同口径
// ((realized−fee)/shares,概率点),但同市场多仓先折成均值 —— CUSUM 要的是
// 准独立观察流,同市场 N 仓共享同一次结算,不折会把一次随机事件当 N 次。

type P = {
  condition_id: string;
  status: "open" | "settled";
  exit_ts: number | null;
  realized_pnl: number | null;
  fee_usd: number | null;
  shares: number;
};

function pos(over: Partial<P> = {}): P {
  return {
    condition_id: over.condition_id ?? `c${Math.random()}`,
    status: "settled",
    exit_ts: 1000,
    realized_pnl: 50,
    fee_usd: 0,
    shares: 100,
    ...over,
  };
}

/** 基线 10 点:五个 +0.5、五个 −0.5 交替 → μ0=0,样本 σ=√(2.5/9)≈0.527。 */
function baseline(): P[] {
  const out: P[] = [];
  for (let i = 0; i < 10; i++) {
    out.push(
      pos({
        condition_id: `base${i}`,
        exit_ts: 1000 + i,
        realized_pnl: i % 2 === 0 ? 50 : -50, // /shares=100 → ±0.5
      }),
    );
  }
  return out;
}

/** 监控段:5 个市场点,每点贡献 = pnlPerShare。 */
function monitor(pnlPerShare: number): P[] {
  const out: P[] = [];
  for (let i = 0; i < 5; i++) {
    out.push(
      pos({
        condition_id: `mon${i}`,
        exit_ts: 2000 + i,
        realized_pnl: pnlPerShare * 100,
      }),
    );
  }
  return out;
}

describe("clusterMarketPoints — 市场级折点", () => {
  it("同市场多仓折成均值一个点,时间戳取该市场最后结算时刻", () => {
    const pts = clusterMarketPoints([
      pos({ condition_id: "m1", exit_ts: 100, realized_pnl: 10 }), // +0.10
      pos({ condition_id: "m1", exit_ts: 200, realized_pnl: 30, fee_usd: 10 }), // +0.20
      pos({ condition_id: "m2", exit_ts: 150, realized_pnl: -50 }), // −0.50
    ]);
    expect(pts.length).toBe(2);
    // 升序:m1 的市场时刻 = max(100,200)=200 > m2 的 150
    expect(pts[0]).toEqual({ ts: 150, point: -0.5 });
    expect(pts[1].ts).toBe(200);
    expect(pts[1].point).toBeCloseTo(0.15);
  });

  it("open/无盈亏/零份额的仓不进观察流(badShares 同 walk-forward 纪律)", () => {
    const pts = clusterMarketPoints([
      pos({ status: "open", realized_pnl: null }),
      pos({ realized_pnl: null }),
      pos({ shares: 0 }),
      pos({ condition_id: "ok", exit_ts: 9, realized_pnl: 20 }),
    ]);
    expect(pts).toEqual([{ ts: 9, point: 0.2 }]);
  });
});

describe("decayVerdict — 四态", () => {
  it("市场点不足(基线 10 + 监控 5)→ insufficient,不给任何数字结论", () => {
    const v = decayVerdict([...baseline(), ...monitor(-1).slice(0, 4)]);
    expect(v.state).toBe("insufficient");
    expect(v.marketPoints).toBe(14);
    expect(v.cusum).toBeNull();
    // 常量自述,防止阈值被悄悄改:14 = 10 + 5 − 1 恰好差一点。
    expect(DECAY_BASE_MIN + DECAY_MONITOR_MIN).toBe(15);
  });

  it("同市场多仓不虚增样本:15 仓但只 14 个市场 → 仍 insufficient", () => {
    const ps = [...baseline(), ...monitor(-1).slice(0, 4)];
    ps.push(pos({ condition_id: "mon0", exit_ts: 2100, realized_pnl: -100 }));
    expect(ps.length).toBe(15);
    expect(decayVerdict(ps).state).toBe("insufficient");
  });

  it("监控段与基线同分布 → ok(交替 ±0.5 的 CUSUM 峰值远低于观察线)", () => {
    const mon: P[] = [];
    for (let i = 0; i < 5; i++) {
      mon.push(
        pos({
          condition_id: `mon${i}`,
          exit_ts: 2000 + i,
          realized_pnl: i % 2 === 0 ? 50 : -50,
        }),
      );
    }
    const v = decayVerdict([...baseline(), ...mon]);
    expect(v.state).toBe("ok");
    expect(v.baselinePoint).toBeCloseTo(0);
  });

  it("温和下行(每点 −0.55)→ watch:2.5σ 观察线过、4σ 报警线未过", () => {
    const v = decayVerdict([...baseline(), ...monitor(-0.55)]);
    expect(v.state).toBe("watch");
    expect(v.crossedAtTs).toBeNull(); // 只有 4σ 报警线才记 crossedAt
    expect(v.recentPoint).toBeCloseTo(-0.55);
  });

  it("重度下行(每点 −1)→ degraded,crossedAtTs = 首次过 4σ 报警线的市场时刻", () => {
    const v = decayVerdict([...baseline(), ...monitor(-1)]);
    expect(v.state).toBe("degraded");
    // 增量 (μ0−x−0.5σ)/σ ≈ 1.397σ/点 → 第 3 个监控点(ts=2002)首次 ≥4σ。
    expect(v.crossedAtTs).toBe(2002);
    expect(v.baselinePoint).toBeCloseTo(0);
    expect(v.recentPoint).toBeCloseTo(-1);
    expect(v.cusum).toBeGreaterThan(4);
  });
});
