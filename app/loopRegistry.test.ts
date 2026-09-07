import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOOP_META, loopMeta } from "./loopMeta";
import { CONDITIONAL_LOOPS, LOOP_STALE_AFTER_SEC } from "../lib/health";

// 引擎循环 ↔ 两张登记表(展示名 app/loopMeta · 停跳阈值 lib/health)的同步守卫。
//
// 存在理由是一次真实的静默失效:`market_daily` 循环 2026-08 上线,是
// /pulse 五榜与确信指数的唯一底座,却既没打心跳、也没进这两张表 —— 它挂了
// /api/health 照样 200,页面只是安静地停在旧的一天。同一个坑此前还咬过一次
// (loopMeta 模块的文件头写着:delivery 是后加的,漏改的那一处会把新循环显示
// 成裸 key)。两次都是「加循环」与「登记循环」由人工纪律连接,而纪律已经
// 断过两回 —— 这里就是那把缺的锁(同 docsPlansIndexParity 之于文档索引)。
//
// 判定材料取引擎源码里的 `beat(db, "…")` 字面量:beat 是心跳的唯一写入口,
// 一个循环打不打心跳、叫什么名字,只有这一处说了算。

const ENGINE_SRC = readFileSync(
  join(process.cwd(), "worker", "embeddedEngine.ts"),
  "utf8",
);

/**
 * 打心跳但**故意不进** LOOP_STALE_AFTER_SEC 的循环。
 *
 * 判据不是「可选」而是「缺席是否等于故障」:
 *  - `delivery` 也只在配了通道时才跑,但它进表 + 进 CONDITIONAL_LOOPS ——
 *    进表让它跑起来之后停跳能被抓到,进豁免集让「从未心跳」不算故障;
 *  - `x_broadcast` 只在配了 X 凭证时启动,且它停跳的后果止于「X 不发帖」,
 *    不影响任何数据面 —— 不进表 = 它一旦心跳过就走 DEFAULT_STALE_AFTER_SEC
 *    的兜底阈值,缺席则永不判定。
 *
 * 新加循环时这个集合会逼你显式表态,而不是默认漏登记。
 */
const UNTRACKED_BY_DESIGN = new Set(["x_broadcast"]);

function beatingLoops(): string[] {
  const re = /\bbeat\(\s*db\s*,\s*"([a-z_]+)"\s*\)/g;
  const out = new Set<string>();
  for (const m of ENGINE_SRC.matchAll(re)) out.add(m[1]);
  return [...out].sort();
}

describe("引擎循环登记表 ↔ worker/embeddedEngine 的 beat() 调用", () => {
  it("扫得到引擎源码里的心跳调用(正则没被重构改废)", () => {
    // 少于 5 个几乎一定是正则失配而不是真的删了循环 —— 一把扫不到东西的
    // 锁比没有锁更危险,它会一直绿。
    expect(beatingLoops().length).toBeGreaterThanOrEqual(5);
  });

  it("每个打心跳的循环都有展示名 —— /status 与 /manage 不该出现裸 key", () => {
    for (const loop of beatingLoops()) {
      expect(
        Object.prototype.hasOwnProperty.call(LOOP_META, loop),
        `循环「${loop}」在引擎里打心跳,但 app/loopMeta 没登记 —— 公开状态页会把它显示成裸 key`,
      ).toBe(true);
      // 回退分支返回 key 本身:登记了却写成空标签同样算漏。
      expect(loopMeta(loop).label).not.toBe(loop);
      expect(loopMeta(loop).impact).not.toBe("—");
    }
  });

  it("每个打心跳的循环要么有停跳阈值,要么显式列为不判定", () => {
    for (const loop of beatingLoops()) {
      const tracked = Object.prototype.hasOwnProperty.call(
        LOOP_STALE_AFTER_SEC,
        loop,
      );
      expect(
        tracked || UNTRACKED_BY_DESIGN.has(loop),
        `循环「${loop}」打心跳却既不在 LOOP_STALE_AFTER_SEC、也不在本测试的 UNTRACKED_BY_DESIGN —— 它停跳时 /api/health 会照常 200(market_daily 就是这么静默失效了一个月)`,
      ).toBe(true);
    }
  });

  it("阈值表里的循环都有展示名,且豁免集不超出阈值表", () => {
    for (const loop of Object.keys(LOOP_STALE_AFTER_SEC)) {
      expect(
        Object.prototype.hasOwnProperty.call(LOOP_META, loop),
        `循环「${loop}」有停跳阈值却没有展示名`,
      ).toBe(true);
    }
    // CONDITIONAL_LOOPS 只在遍历 LOOP_STALE_AFTER_SEC 时被查(见
    // evaluateHealth 的缺席判定),列一个不在表里的名字是死代码 + 假安心。
    for (const loop of CONDITIONAL_LOOPS) {
      expect(
        Object.prototype.hasOwnProperty.call(LOOP_STALE_AFTER_SEC, loop),
        `「${loop}」在 CONDITIONAL_LOOPS 里却不在 LOOP_STALE_AFTER_SEC —— 豁免一个从不被遍历的循环没有任何效果`,
      ).toBe(true);
    }
  });

  it("market_daily 已登记:阈值是轮次节拍的整数倍,不是日节拍", () => {
    // 回归钉:这个循环最初以「日节拍配不了阈值」为由不打心跳。轮次是
    // 30 分钟,阈值必须落在「几轮」这个量级上,落到 20h+ 就等于没有闸。
    expect(LOOP_STALE_AFTER_SEC.market_daily).toBeGreaterThanOrEqual(3600);
    expect(LOOP_STALE_AFTER_SEC.market_daily).toBeLessThanOrEqual(6 * 3600);
    expect(beatingLoops()).toContain("market_daily");
  });
});
