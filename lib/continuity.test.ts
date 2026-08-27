import { describe, it, expect } from "vitest";
import {
  computeContinuity,
  CONTINUITY_GATE_DAYS,
  CONTINUITY_TOL_SEC,
  CONTINUITY_WINDOW_DAYS,
} from "./continuity";
import { LOOP_STALE_AFTER_SEC } from "./health";

// 数据连续性重建(/status 的 30 天起算时钟)。判定材料是共识循环逐轮落库的
// 实测时间戳(cycle_metrics,每 5 分钟一轮,fetchWindow 成功才写行)——
// 不是推测式 uptime。这里钉死三类最容易撒谎的边角:
//  - 跨午夜断档要双杀(保守方向:信誉时钟宁可少计一天,不能多计一天);
//  - 取数窗左边界外的长断档,窗口内只见尾巴,不能误判成覆盖;
//  - 记录起点日只过了半天,不能冒充完整覆盖日。

const DAY = 86_400;
const NOW = Math.floor(Date.UTC(2026, 7, 27, 12) / 1000); // 2026-08-27T12:00Z
const TODAY_START = NOW - (NOW % DAY);

/** day(-1, 10, 30) = 昨天 10:30 UTC 的秒级时间戳。 */
const at = (offsetDays: number, hour = 0, min = 0): number =>
  TODAY_START + offsetDays * DAY + hour * 3600 + min * 60;

/** [from, to) 内每 5 分钟一轮。 */
function cadence(from: number, to: number, stepSec = 300): number[] {
  const out: number[] = [];
  for (let t = from; t < to; t += stepSec) out.push(t);
  return out;
}

const dayStr = (offsetDays: number): string =>
  new Date(at(offsetDays) * 1000).toISOString().slice(0, 10);

const FETCH_START = at(-(CONTINUITY_WINDOW_DAYS + 2));

function run(ts: number[], eraFirstTs: number | null = ts[0] ?? null) {
  return computeContinuity(ts, {
    nowSec: NOW,
    eraFirstTs,
    fetchStartSec: FETCH_START,
  });
}

const statusOf = (r: ReturnType<typeof run>, offsetDays: number) =>
  r.days.find((d) => d.day === dayStr(offsetDays))!;

describe("常量与全站口径", () => {
  it("容忍阈值与 /api/health 判共识循环停跳是同一把尺", () => {
    expect(CONTINUITY_TOL_SEC).toBe(LOOP_STALE_AFTER_SEC.consensus);
  });
  it("闸门 30 天,展示窗 60 天(闸门必须能整个装进展示窗)", () => {
    expect(CONTINUITY_GATE_DAYS).toBe(30);
    expect(CONTINUITY_WINDOW_DAYS).toBeGreaterThan(CONTINUITY_GATE_DAYS);
  });
});

describe("computeContinuity — 基本形状", () => {
  it("三天全覆盖:60 个历史日 + 今天,起点前是 pre,streak=3", () => {
    const r = run(cadence(at(-3), NOW));
    expect(r.days).toHaveLength(CONTINUITY_WINDOW_DAYS + 1);
    expect(r.days[r.days.length - 1].day).toBe(dayStr(0));
    expect(r.days[0].day).toBe(dayStr(-CONTINUITY_WINDOW_DAYS));

    // 记录起点恰在午夜 → 起点日从 00:00 起就有覆盖,算完整覆盖日。
    expect(statusOf(r, -3).status).toBe("covered");
    expect(statusOf(r, -2).status).toBe("covered");
    expect(statusOf(r, -1).status).toBe("covered");
    expect(statusOf(r, -4).status).toBe("pre");
    expect(statusOf(r, 0).status).toBe("pending");

    expect(r.recordStartDay).toBe(dayStr(-3));
    expect(r.streakDays).toBe(3);
    expect(r.streakStartDay).toBe(dayStr(-3));
    expect(r.streakClipped).toBe(false);
    expect(r.todayCoveredSoFar).toBe(true);
    expect(r.gateReached).toBe(false);
  });

  it("每日轮次如实计数(5 分钟一轮 = 288 轮/日)", () => {
    const r = run(cadence(at(-2), NOW));
    expect(statusOf(r, -1).cycles).toBe(288);
    // 今天只跑到 12:00 → 144 轮。
    expect(statusOf(r, 0).cycles).toBe(144);
  });
});

describe("computeContinuity — 断档判定", () => {
  it("单日中段断档(相邻轮距 30 分钟):该日 gap 并记录停顿时长,streak 归零", () => {
    // 抠掉 [10:00, 10:25) 的轮次后,幸存邻居是 09:55 与 10:25 —— 相邻轮距
    // 30 分钟,这才是断档的真实度量(不是被抠掉的区间长度)。
    const ts = cadence(at(-2), NOW).filter(
      (t) => t < at(-1, 10, 0) || t >= at(-1, 10, 25),
    );
    const r = run(ts);
    const d = statusOf(r, -1);
    expect(d.status).toBe("gap");
    expect(d.maxGapSec).toBe(30 * 60);
    expect(statusOf(r, -2).status).toBe("covered");
    // 昨天就是断档日 → 不存在「截至昨天的连续覆盖」。
    expect(r.streakDays).toBe(0);
    expect(r.streakStartDay).toBeNull();
  });

  it("15 分钟停顿在容忍内(引擎重启),不算断档", () => {
    // 抠掉 [10:00, 10:10) → 邻居 09:55 与 10:10,轮距 15 分钟 ≤ 20 分钟容忍。
    const ts = cadence(at(-2), NOW).filter(
      (t) => t < at(-1, 10, 0) || t >= at(-1, 10, 10),
    );
    const r = run(ts);
    expect(statusOf(r, -1).status).toBe("covered");
    // maxGapSec 只记「超过容忍」的断档 —— 容忍内的重启不留痕。
    expect(statusOf(r, -1).maxGapSec).toBe(0);
    expect(r.streakDays).toBe(2);
  });

  it("跨午夜断档双杀:23:50 → 次日 00:15 让两天都不计入", () => {
    const ts = cadence(at(-3), NOW).filter(
      (t) => t < at(-2, 23, 50) || t >= at(-1, 0, 15),
    );
    const r = run(ts);
    expect(statusOf(r, -2).status).toBe("gap");
    expect(statusOf(r, -1).status).toBe("gap");
    expect(statusOf(r, -3).status).toBe("covered");
    expect(r.streakDays).toBe(0);
  });

  it("今天已出现断档:todayCoveredSoFar=false,但不影响截至昨天的 streak", () => {
    // 今天 09:00 之后引擎停了,NOW=12:00 → 3h 的开放断档。
    const r = run(cadence(at(-2), at(0, 9, 0)));
    expect(r.todayCoveredSoFar).toBe(false);
    expect(statusOf(r, 0).status).toBe("pending");
    expect(r.streakDays).toBe(2);
  });
});

describe("computeContinuity — 记录起点与边界", () => {
  it("记录起点日中途开跑:该日 partial 不计入,之前是 pre", () => {
    const r = run(cadence(at(-2, 9, 0), NOW));
    expect(statusOf(r, -2).status).toBe("partial");
    expect(statusOf(r, -3).status).toBe("pre");
    expect(statusOf(r, -1).status).toBe("covered");
    expect(r.streakDays).toBe(1);
    expect(r.recordStartDay).toBe(dayStr(-2));
  });

  it("起点在午夜后容忍内(00:10)仍算完整覆盖日 —— 与断档判定同一把尺", () => {
    const r = run(cadence(at(-2, 0, 10), NOW));
    expect(statusOf(r, -2).status).toBe("covered");
    expect(r.streakDays).toBe(2);
  });

  it("跨取数窗左边界的长断档:窗口内只见尾巴也不能误判覆盖", () => {
    // 记录 40 天前就开始了,但取数窗起点到 5 天前之间一轮都没有 ——
    // 一段跨边界的长断档。恢复之后的 5 天才是真覆盖。
    const ts = cadence(at(-5), NOW);
    const r = computeContinuity(ts, {
      nowSec: NOW,
      eraFirstTs: at(-100),
      fetchStartSec: FETCH_START,
    });
    expect(statusOf(r, -6).status).toBe("gap");
    expect(statusOf(r, -30).status).toBe("gap");
    expect(statusOf(r, -5).status).toBe("covered");
    expect(r.streakDays).toBe(5);
    expect(r.streakStartDay).toBe(dayStr(-5));
    // 起点日在窗外 → 展示窗里没有它,但 recordStartDay 仍如实上报。
    expect(r.recordStartDay).toBe(dayStr(-100));
  });

  it("空表:无记录起点,历史全 pre,今天 pending 且未覆盖", () => {
    const r = run([], null);
    expect(r.recordStartDay).toBeNull();
    expect(r.streakDays).toBe(0);
    expect(r.todayCoveredSoFar).toBe(false);
    expect(statusOf(r, -1).status).toBe("pre");
    expect(statusOf(r, 0).status).toBe("pending");
  });

  it("整窗全覆盖:streak 打到展示窗上限并标记 clipped,闸门达标", () => {
    const r = computeContinuity(cadence(FETCH_START, NOW), {
      nowSec: NOW,
      eraFirstTs: at(-100),
      fetchStartSec: FETCH_START,
    });
    expect(r.streakDays).toBe(CONTINUITY_WINDOW_DAYS);
    expect(r.streakClipped).toBe(true);
    expect(r.gateReached).toBe(true);
  });

  it("恰好 30 个覆盖日达标,29 不达标", () => {
    const r30 = run(cadence(at(-30), NOW));
    expect(r30.streakDays).toBe(30);
    expect(r30.gateReached).toBe(true);
    const r29 = run(cadence(at(-29), NOW));
    expect(r29.streakDays).toBe(29);
    expect(r29.gateReached).toBe(false);
  });
});
