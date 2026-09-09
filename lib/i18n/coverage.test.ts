import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DICT } from "./dict";

// 全站翻译覆盖率闸 —— 双语化的长期保障:
// 任何人在页面里写了 t("新文案") 却忘记补译文,这条测试立刻红,而不是
// 等到英文界面上线后由用户发现一段中文。扫描 app/ 下所有源文件里的
// t("…") 字面量调用,逐一比对合并字典。
//
// 只查静态字面量:t(变量) / t(iconTip(s)) 这类动态调用扫不到,由各自
// 属主分片(glossary 等)自行保证 —— 静态部分能守住绝大多数回归。

const APP_DIR = join(__dirname, "../../app");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (/\.tsx?$/.test(name) && !name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

// t("…") / t('…') 的第一参数字面量。反引号模板不匹配(它们不是合法键)。
const T_CALL = /\bt\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g;

function unescape(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

describe("i18n coverage", () => {
  const files = walk(APP_DIR);

  it("扫到了 app/ 下的源文件", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('每个 t("字面量") 都有对应译文(含汉字的键)', () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(T_CALL)) {
        const key = unescape(m[2]);
        // 只要求含汉字的键有译文:语言中立键(" · ROI {roi}%")无需翻译。
        if (!/[一-鿿]/.test(key)) continue;
        if (!(key in DICT)) {
          missing.push(`${f.replace(APP_DIR, "app")}: ${JSON.stringify(key)}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

// LOOP_META 专项守卫(评审 2026-09-09 问题 3):/status 与 /manage 用
// t(meta.label) / t(meta.cadence) / t(meta.impact) **动态传参**渲染循环表,
// 上面的字面量扫描抓不到 —— 改 loopMeta 忘补词条时,英文界面会静默回退中文
// (core.ts 的 dict[zh] ?? zh),测试却仍是绿的。这里把 LOOP_META 三列逐值
// 对照合并字典,补上这个盲区。
import { LOOP_META } from "../../app/loopMeta";

describe("i18n coverage — LOOP_META 动态传参", () => {
  it("循环表的 label/cadence/impact 全部有译文", () => {
    const missing: string[] = [];
    for (const [loop, m] of Object.entries(LOOP_META)) {
      for (const v of [m.label, m.cadence, m.impact]) {
        if (/[一-鿿]/.test(v) && !(v in DICT)) {
          missing.push(`${loop}: ${JSON.stringify(v)}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
