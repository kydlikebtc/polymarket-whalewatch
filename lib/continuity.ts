import type { DB } from "./db";
import { LOOP_STALE_AFTER_SEC } from "./health";

// 数据连续性重建(/status 的 30 天起算时钟)。README 路线图把「30 个不间断
// 交易日的数据」列为重推所有阈值的前置闸门 —— 这个模块让那口钟对外可见,
// 且起算日由数据自己说话:当前不间断覆盖段的第一天,不靠人工宣布。
//
// 判定材料是共识循环逐轮落库的实测时间戳(cycle_metrics,每 5 分钟一轮,
// 且只有 fetchWindow 成功才写行,见 lib/consensus.ts)——一行 = 「引擎活着
// 且真的看到了那 5 分钟的市场」。心跳表(heartbeats)按循环只留当日计数,
// 提供不了跨日序列;/status 此前因此拒绝画 uptime 条(「编的数字会让整页
// 数字都不值钱」)—— cycle_metrics 是真序列,这里画的每一格都有原始行背书。
//
// 三条判定纪律,全部取保守方向(信誉时钟宁可少计一天,不能多计一天):
//  - 容忍阈值 = /api/health 判共识循环停跳的同一把尺(20 分钟,约 4 倍
//    节拍)。容忍内的重启不留痕,超过即断档;
//  - 跨午夜的断档两天都不计入 —— 断档属于它触碰的每一个日历日;
//  - 记录起点日若非从午夜(±容忍)起跑,记 partial 不计入。

export const CONTINUITY_GATE_DAYS = 30;
export const CONTINUITY_TOL_SEC = LOOP_STALE_AFTER_SEC.consensus;
/** 对外条带展示的历史日数。闸门(30)必须整个装得进来。 */
export const CONTINUITY_WINDOW_DAYS = 60;

export type ContinuityDayStatus =
  | "covered" // 全日无超容忍断档
  | "gap" // 至少一段超容忍断档触碰本日
  | "partial" // 记录起点日,从中途开始 —— 无法主张全日覆盖
  | "pre" // 早于记录起点
  | "pending"; // 今天,尚未结束,不参与判定

export interface ContinuityDay {
  day: string; // UTC yyyy-mm-dd
  status: ContinuityDayStatus;
  cycles: number;
  /** 触碰本日的最长断档(秒)。0 = 无超容忍断档。 */
  maxGapSec: number;
}

export interface ContinuityReport {
  gateDays: number;
  tolSec: number;
  /** 全表最早一轮所在的 UTC 日;null = 从未有过记录。 */
  recordStartDay: string | null;
  /** 旧 → 新,共 windowDays + 1 条,最后一条恒为今天(pending)。 */
  days: ContinuityDay[];
  /** 截至昨天的连续覆盖日数 —— 这就是「30 天时钟」的读数。 */
  streakDays: number;
  streakStartDay: string | null;
  /** 连续段打满展示窗 —— 真实 streak 可能更长(闸门 30 < 窗 60,不影响判定)。 */
  streakClipped: boolean;
  todayCoveredSoFar: boolean;
  gateReached: boolean;
}

const DAY = 86_400;
const utcDayStr = (sec: number): string =>
  new Date(sec * 1000).toISOString().slice(0, 10);

/**
 * @param tsAsc 升序的循环时间戳,取数窗应比展示窗多留 ≥2 天余量
 * (跨越展示窗左边界的断档要靠余量里的行才看得见)。
 * @param opts.eraFirstTs 全表 MIN(ts) —— 与取数窗无关的「记录起点」。
 * @param opts.fetchStartSec tsAsc 的截取起点。当记录起点早于它而窗口开头
 * 一片空白时,说明有一段跨边界的长断档,窗口内只见尾巴 —— 用一个合成
 * 断档对兜住,防止把断档日误判成覆盖日(长度是下界,足以定性)。
 */
export function computeContinuity(
  tsAsc: number[],
  opts: {
    nowSec: number;
    eraFirstTs?: number | null;
    fetchStartSec?: number;
    days?: number;
    tolSec?: number;
    gateDays?: number;
  },
): ContinuityReport {
  const { nowSec } = opts;
  const days = opts.days ?? CONTINUITY_WINDOW_DAYS;
  const tol = opts.tolSec ?? CONTINUITY_TOL_SEC;
  const gate = opts.gateDays ?? CONTINUITY_GATE_DAYS;
  const eraFirstTs = opts.eraFirstTs ?? tsAsc[0] ?? null;
  const todayStart = nowSec - (nowSec % DAY);
  const displayStart = todayStart - days * DAY;
  const fetchStart = opts.fetchStartSec ?? displayStart - 2 * DAY;

  // 断档对:相邻两轮间隔 > 容忍的区间。只存断档,覆盖是「没有断档」的推论。
  const pairs: { a: number; b: number }[] = [];
  if (eraFirstTs != null && eraFirstTs < fetchStart) {
    if (tsAsc.length === 0) {
      // 记录在窗外开始过,窗内却一轮都没有 —— 整个窗口都在断档里。
      pairs.push({ a: fetchStart, b: nowSec });
    } else if (tsAsc[0] - fetchStart > tol) {
      pairs.push({ a: fetchStart, b: tsAsc[0] });
    }
  }
  for (let i = 1; i < tsAsc.length; i++) {
    if (tsAsc[i] - tsAsc[i - 1] > tol) {
      pairs.push({ a: tsAsc[i - 1], b: tsAsc[i] });
    }
  }
  const last = tsAsc.length > 0 ? tsAsc[tsAsc.length - 1] : null;
  if (last != null && nowSec - last > tol) {
    // 开放断档:最后一轮到现在 —— 今天的 coveredSoFar 靠它判。
    pairs.push({ a: last, b: nowSec });
  }

  const cyclesByDay = new Array<number>(days + 1).fill(0);
  for (const t of tsAsc) {
    const idx = Math.floor((t - displayStart) / DAY);
    if (idx >= 0 && idx <= days) cyclesByDay[idx]++;
  }

  const eraDay = eraFirstTs != null ? utcDayStr(eraFirstTs) : null;
  const out: ContinuityDay[] = [];
  for (let i = 0; i <= days; i++) {
    const dStart = displayStart + i * DAY;
    const isToday = i === days;
    // 今天只判到当下:未来不存在,也就不存在「未来的断档」。
    const dEnd = isToday ? nowSec : dStart + DAY;
    const day = utcDayStr(dStart);
    let maxGapSec = 0;
    for (const p of pairs) {
      if (p.a < dEnd && p.b > dStart) {
        maxGapSec = Math.max(maxGapSec, p.b - p.a);
      }
    }
    let status: ContinuityDayStatus;
    if (eraDay == null) {
      status = isToday ? "pending" : "pre";
    } else if (day < eraDay) {
      status = "pre";
    } else if (day === eraDay && eraFirstTs! > dStart + tol) {
      // 起点在午夜后容忍内(如 00:10 首跑)不算 partial —— 与断档同一把尺。
      status = isToday ? "pending" : "partial";
    } else if (isToday) {
      status = "pending";
    } else {
      status = maxGapSec > 0 ? "gap" : "covered";
    }
    out.push({ day, status, cycles: cyclesByDay[i], maxGapSec });
  }

  const today = out[out.length - 1];
  const todayPartial =
    eraFirstTs != null && eraDay === today.day && eraFirstTs > todayStart + tol;
  const todayCoveredSoFar =
    eraFirstTs != null && !todayPartial && today.maxGapSec === 0;

  let streakDays = 0;
  let streakStartDay: string | null = null;
  for (let i = out.length - 2; i >= 0; i--) {
    if (out[i].status !== "covered") break;
    streakDays++;
    streakStartDay = out[i].day;
  }

  return {
    gateDays: gate,
    tolSec: tol,
    recordStartDay: eraDay,
    days: out,
    streakDays,
    streakStartDay,
    streakClipped: streakDays === days,
    todayCoveredSoFar,
    gateReached: streakDays >= gate,
  };
}

/**
 * 从 cycle_metrics 读取并重建连续性报告 —— /api/continuity 与 /embed/status
 * 共用的取数层(两处各写一遍 SQL 迟早口径分叉)。取数窗比展示窗多 2 天,
 * 理由见 computeContinuity 的 fetchStartSec 注释。
 */
export function readContinuity(
  db: DB,
  nowSec: number = Math.floor(Date.now() / 1000),
): ContinuityReport {
  const todayStart = nowSec - (nowSec % DAY);
  const fetchStartSec = todayStart - (CONTINUITY_WINDOW_DAYS + 2) * DAY;
  const ts = (
    db
      .prepare(
        "SELECT ts FROM cycle_metrics WHERE loop = 'consensus' AND ts >= ? ORDER BY ts ASC",
      )
      .all(fetchStartSec) as { ts: number }[]
  ).map((r) => r.ts);
  const era = db
    .prepare("SELECT MIN(ts) AS t FROM cycle_metrics WHERE loop = 'consensus'")
    .get() as { t: number | null };
  return computeContinuity(ts, { nowSec, eraFirstTs: era.t, fetchStartSec });
}
