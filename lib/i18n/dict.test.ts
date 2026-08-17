import { describe, it, expect } from "vitest";
import { DICT } from "./dict";
import { DICT_COMMON } from "./dict/common";
import { DICT_HOME } from "./dict/home";
import { DICT_ALERTS } from "./dict/alerts";
import { DICT_CONSENSUS } from "./dict/consensus";
import { DICT_ACCUMULATION } from "./dict/accumulation";
import { DICT_DISCOVERY } from "./dict/discovery";
import { DICT_FOLLOW } from "./dict/follow";
import { DICT_DEEP } from "./dict/deep";
import { DICT_WALLET } from "./dict/wallet";
import { DICT_MARKET } from "./dict/market";
import { DICT_GLOSSARY } from "./dict/glossary";
import { DICT_MISC } from "./dict/misc";

// 字典卫生:四条规则挡住四类真实事故 ——
//  1. 空译文 → 英文界面出现空洞;
//  2. 译文=原文 → 假翻译(键值抄反或占位没删);
//  3. 占位符集合不一致 → 英文丢变量({n} 消失,数字不见);
//  4. 跨分片同键异值 → 后导入的分片静默覆盖前者(真实发生过:deep 的
//     「胜率: win rate」把 consensus/discovery 的「Win rate」改成小写,
//     四个页面的表头跟着变,没有任何报错)。
function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

const SHARDS: [string, Record<string, string>][] = [
  ["common", DICT_COMMON],
  ["home", DICT_HOME],
  ["alerts", DICT_ALERTS],
  ["consensus", DICT_CONSENSUS],
  ["accumulation", DICT_ACCUMULATION],
  ["discovery", DICT_DISCOVERY],
  ["follow", DICT_FOLLOW],
  ["deep", DICT_DEEP],
  ["wallet", DICT_WALLET],
  ["market", DICT_MARKET],
  ["glossary", DICT_GLOSSARY],
  ["misc", DICT_MISC],
];

describe("DICT hygiene", () => {
  const entries = Object.entries(DICT);
  it("has entries", () => {
    expect(entries.length).toBeGreaterThan(0);
  });
  it("no empty translations", () => {
    const empty = entries.filter(([, v]) => v.trim() === "");
    expect(empty.map(([k]) => k)).toEqual([]);
  });
  it("no value === key fake translations (只查含汉字的键 —— 语言中立键天然同形)", () => {
    const fake = entries.filter(([k, v]) => k === v && /[一-鿿]/.test(k));
    expect(fake.map(([k]) => k)).toEqual([]);
  });
  it("placeholder sets match between zh key and en value", () => {
    const mismatched = entries.filter(
      ([k, v]) =>
        JSON.stringify(placeholders(k)) !== JSON.stringify(placeholders(v)),
    );
    expect(mismatched.map(([k]) => k)).toEqual([]);
  });
  it("no cross-shard key collisions with DIFFERENT values (静默覆盖)", () => {
    const seen = new Map<string, { shard: string; value: string }>();
    const conflicts: string[] = [];
    for (const [shard, dict] of SHARDS) {
      for (const [k, v] of Object.entries(dict)) {
        const prev = seen.get(k);
        // 同键同值是无害的刻意复用(如两页共用「金额」);同键异值才是事故。
        if (prev && prev.value !== v) {
          conflicts.push(
            `${JSON.stringify(k)}: ${prev.shard}=${JSON.stringify(prev.value)} vs ${shard}=${JSON.stringify(v)}`,
          );
        } else if (!prev) {
          seen.set(k, { shard, value: v });
        }
      }
    }
    expect(conflicts).toEqual([]);
  });
});
