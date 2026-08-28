import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMarkdownDoc, type DocBlock } from "./markdownDoc";

// docs/README.md「设计文档索引」表 ↔ docs/plans/ 目录 的双向同步守卫。
//
// README 自述这张索引「新增文档时需同步」—— 但同步靠的是人工纪律,而纪律
// 已反复欠账:索引在 2026-08-18 全面重修(b933451)出生时是严格双向同步的
// (24 链接 ↔ 24 文件),此后五个 docs 提交(fe06cac/0934c22/0369f5c/
// 3a54b3e/9eb99a0)只添文件不添行,一路漂到 30 行 ↔ 35 份也从来不红 ——
// 因为没有任何测试对照「表里链接的」与「目录里实有的」。本文件就是那把
// 缺的锁(同 busFeedParity 之于 bus[] 投影白名单)。
//
// 解析要点(都是踩过坑的):
//  - 不自己按行切 markdown,复用 /api-docs 同款解析器 parseMarkdownDoc
//    (apiDocsContract 的先例):prettier 的对齐空格被 splitRow 吃掉、围栏
//    代码块先被收走(小节里贴表格写法示例不会误报)、HTML 注释会打断表行
//    (被 <!-- --> 注释掉的行不再被计入 —— 逐行 startsWith("|") 的土解析
//    会把它们当活行,产生假绿)。
//  - 链接仍锚定 ](plans/ 且用 [^)] 断在右括号:计数散文里也有 `docs/plans/`
//    字样,此前的验证脚本在这里吃过贪婪匹配的亏。
//  - 计数散文也上锁:表锁上之后,漂移只会转移到散文(下次加档,表红被迫改,
//    散文更容易漏)。历史教训:只比数量曾在 24↔24 的巧合下看似同步,且散文
//    曾点名过表里根本不存在的行 —— 谁也不校验谁。数字全部由目录推导。

const README = readFileSync(join(process.cwd(), "docs", "README.md"), "utf8");
const PLANS_DIR = join(process.cwd(), "docs", "plans");
const BLOCKS = parseMarkdownDoc(README);

type Table = Extract<DocBlock, { kind: "table" }>;

/** 「设计文档索引」标题之后、下一个标题之前的表(应恰好一张)。 */
function indexTables(): Table[] {
  const start = BLOCKS.findIndex(
    (b) => b.kind === "heading" && b.text === "设计文档索引",
  );
  if (start === -1) return [];
  const rest = BLOCKS.slice(start + 1);
  const end = rest.findIndex((b) => b.kind === "heading");
  return rest
    .slice(0, end === -1 ? undefined : end)
    .filter((b): b is Table => b.kind === "table");
}

/** 取某一列(按表头名定位,不假设列序 —— 列序是会调整的)。 */
function tableColumn(t: Table, name: string): string[] {
  const i = t.head.findIndex((h) => h.trim() === name);
  return i === -1 ? [] : t.rows.map((r) => (r[i] ?? "").trim());
}

type IndexRow = { date: string; file: string; type: string; linkCount: number };

function indexRows(): IndexRow[] {
  const t = indexTables()[0];
  if (!t) return [];
  const dates = tableColumn(t, "日期");
  const topics = tableColumn(t, "主题");
  const types = tableColumn(t, "类型");
  return t.rows.map((_, i) => {
    const links = [...(topics[i] ?? "").matchAll(/\]\(plans\/([^)]+)\)/g)].map(
      (m) => m[1],
    );
    return {
      date: dates[i] ?? "",
      file: links[0] ?? "",
      type: types[i] ?? "",
      linkCount: links.length,
    };
  });
}

/** plans/ 刻意保持扁平(子目录既不入表也不入计数),故不递归。 */
function planFiles(): string[] {
  return readdirSync(PLANS_DIR).filter((f) => f.endsWith(".md"));
}

describe("docs/README.md 设计文档索引 ↔ docs/plans/ 目录", () => {
  it("小节、表与三列在场;每行恰好链接一份文档、首列是日期", () => {
    const tables = indexTables();
    expect(
      tables.length,
      "「设计文档索引」小节下应恰好一张表 —— 小节/表被改名或删除时连本测试一起改",
    ).toBe(1);
    for (const name of ["日期", "主题", "类型"]) {
      expect(
        tables[0].head.map((h) => h.trim()),
        `索引表缺「${name}」列`,
      ).toContain(name);
    }
    const rows = indexRows();
    expect(rows.length, "索引表里一行都没解析到").toBeGreaterThan(0);
    for (const r of rows) {
      expect(
        r.linkCount,
        `一行应恰好链接一份文档:${r.date} ${r.file || "(无链接)"}`,
      ).toBe(1);
      expect(r.date, `首列不是 YYYY-MM-DD 日期:${r.file}`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    }
  });

  it("链接集合 = 目录文件集合(双向) —— 加档漏登记、表挂死链、一档两行都点名报红", () => {
    // 排序数组而非 Set:同一文件被链两行时长度不等照样红,Set 会把重复吞掉。
    expect(
      indexRows()
        .map((r) => r.file)
        .sort(),
    ).toEqual([...planFiles()].sort());
  });

  it("表行按日期倒序(同日并列不限序) —— 新行要插对位置,不是缀在表尾", () => {
    const rows = indexRows();
    for (let i = 1; i < rows.length; i++) {
      // YYYY-MM-DD 的字典序即时间序,字符串比较成立。
      expect(
        rows[i].date <= rows[i - 1].date,
        `乱序:${rows[i - 1].file}(${rows[i - 1].date}) 之后出现 ${rows[i].file}(${rows[i].date})`,
      ).toBe(true);
    }
  });

  it("日期列与文件名日期前缀一致 —— 防复制上一行忘改日期", () => {
    for (const r of indexRows()) {
      expect(
        r.file.slice(0, 10),
        `「${r.file}」所在行的日期列写着 ${r.date},与文件名前缀不符`,
      ).toBe(r.date);
    }
  });

  it("类型列与文件名后缀自洽 —— -design.md 必标 design,-implementation.md 必标 implementation", () => {
    for (const r of indexRows()) {
      // 无后缀文件(战略总纲/脑暴快照/自述为实现计划的)按正文实际类型标注,
      // 表比文件名知道得多,不在此约束。
      if (r.file.endsWith("-design.md")) {
        expect(r.type, `「${r.file}」的类型列`).toBe("design");
      } else if (r.file.endsWith("-implementation.md")) {
        expect(r.type, `「${r.file}」的类型列`).toBe("implementation");
      }
    }
  });

  it("README 全部计数散文与目录一致 —— 表锁上了,散文不能继续裸奔", () => {
    const plans = planFiles();
    const design = plans.filter((f) => f.endsWith("-design.md")).length;
    const impl = plans.filter((f) => f.endsWith("-implementation.md")).length;
    const bare = plans.length - design - impl;
    const rootMd = readdirSync(join(process.cwd(), "docs")).filter((f) =>
      f.endsWith(".md"),
    ).length;
    // 钉的是数字,不是措辞:改写这几句散文时把这里的模板同步改掉即可。
    // toContain 失配是误报(句子重排),能接受;数字悄悄过期才是事故。
    for (const claim of [
      // 小节抬头
      `共 **${plans.length} 份**`,
      // 顶部三类边界表
      `设计文档与实现计划（${plans.length} 份，按日期命名）`,
      // 计数说明引用块的分量拆解
      `\`docs/plans/\` 下 ${plans.length} 份 markdown = ${design} 份 \`-design.md\` + ${impl} 份 \`-implementation.md\` + ${bare} 份无后缀`,
      // 计数说明结尾的全目录合计
      `\`docs/\` 全目录共 ${plans.length + rootMd} 份 markdown`,
    ]) {
      expect(
        README.includes(claim),
        `README 里找不到「${claim}」—— 数字过期,或句子被改写(那就同步改本测试的模板)`,
      ).toBe(true);
    }
  });
});
