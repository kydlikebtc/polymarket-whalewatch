import { utcWeekStart } from "./followAnalysis";

// Walk-forward 阈值重推的纯函数层(2026-08-28,设计见 docs/plans/
// 2026-08-28-walkforward-rederivation-design.md,实现口径见同名实现计划 §0)。
//
// 分层纪律与 detector/exitCounterfactual 相同:本文件**全部是数据进数据出**,
// 没有 DB 句柄、没有时钟、没有 Math.random —— SQL 取数、终端渲染、落库都在
// scripts/walkforward.ts。统计错了比没有更糟(edge-audit 文件头的原话),所以
// 能被合成数据钉死的口径全部放在这里直测。

const DAY = 86_400;
const WEEK = 7 * DAY;

/**
 * validate 折清单:干净窗内**从第 2 个完整周起**的每个 UTC 整周(周一起点秒)。
 *
 * - 第 1 个干净周只做 train(扩张窗的地基,设计 §4.1);闸门起点非周一时,
 *   它所在的残周含闸门前脏数据,首个干净整周顺延到下一个周一。
 * - 跑的当天所在的不完整周不做 validate:「已结算」宇宙在最近的残周里天然
 *   偏向快结算市场,拿它评分是选择偏置(报告代表性一节须披露这层)。
 */
export function listValidateFolds(gateStart: number, nowSec: number): number[] {
  const w1 =
    utcWeekStart(gateStart) === gateStart
      ? gateStart
      : utcWeekStart(gateStart) + WEEK;
  const lastCompleteEnd = utcWeekStart(nowSec);
  const folds: number[] = [];
  for (let s = w1 + WEEK; s + WEEK <= lastCompleteEnd; s += WEEK) {
    folds.push(s);
  }
  return folds;
}

/**
 * 一笔仓按 formation_ts(决策时刻,不是结算时刻 —— 按结算归折会把训练期的
 * 决策泄进验证期)归到哪个 validate 折;不在任何折内(W1/闸门前/窗外)返回
 * null,这些仓只进 train。
 */
export function foldOf(formationTs: number, folds: number[]): number | null {
  for (const s of folds) {
    if (formationTs >= s && formationTs < s + WEEK) return s;
  }
  return null;
}
