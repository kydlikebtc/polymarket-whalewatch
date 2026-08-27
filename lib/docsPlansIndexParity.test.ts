import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// docs/README.md「设计文档索引」表 ↔ docs/plans/ 目录 的双向同步守卫。
//
// README 自述这张索引「新增文档时需同步」—— 但同步靠的是人工纪律,而纪律
// 已反复欠账:索引在 2026-08-18 全面重修(b933451)出生时是严格双向同步的
// (24 链接 ↔ 24 文件),此后五个 docs 提交(fe06cac/0934c22/0369f5c/
// 3a54b3e/9eb99a0)只添文件不添行,一路漂到 30 行 ↔ 35 份也从来不红 ——
// 因为没有任何测试对照「表里链接的」与「目录里实有的」。计数说明散文甚至
// 点名了 strategic-roadmap / x-post-copy-density / market-card-api,表里
// 却没有它们的行:散文与表各自手工维护,谁也不校验谁。本文件就是那把缺的
// 锁(同 busFeedParity 之于 bus[] 投影白名单)。
//
// 解析要点(都是踩过坑的):
//  - 表由 prettier 对齐,任一行变宽都会全表重排 —— 所以不按列位切割,
//    只认 ](plans/…) 的链接语法。
//  - 计数说明散文里也有 `docs/plans/` 字样,此前的验证脚本在这里吃过
//    贪婪匹配的亏 —— 锚定 ](plans/ 且用 [^)] 断在右括号,天然免疫。
//  - 只认「## 设计文档索引」小节内以 | 开头的行:正文/引用块将来即使出现
//    指向 plans/ 的交叉引用链接,也不该被当成索引行。

const README = readFileSync(join(process.cwd(), "docs", "README.md"), "utf8");
const PLANS_DIR = join(process.cwd(), "docs", "plans");

/** 「## 设计文档索引」小节:标题之后、下一个 ## 标题或 --- 分隔线之前。 */
function sectionLines(): string[] {
  const lines = README.split("\n");
  const start = lines.findIndex((l) => l.trim() === "## 设计文档索引");
  if (start === -1) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const t = line.trim();
    if (t === "---" || t.startsWith("## ")) break;
    body.push(line);
  }
  return body;
}

type IndexRow = { date: string; file: string; links: number; raw: string };

/** 表内数据行:| 开头且带 ](plans/…) 链接的行(表头与对齐行天然不含链接)。 */
function indexRows(): IndexRow[] {
  return sectionLines()
    .filter((l) => l.trimStart().startsWith("|"))
    .flatMap((raw) => {
      const links = [...raw.matchAll(/\]\(plans\/([^)]+)\)/g)].map((m) => m[1]);
      if (links.length === 0) return [];
      const date =
        raw.trimStart().match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|/)?.[1] ?? "";
      return [{ date, file: links[0], links: links.length, raw }];
    });
}

function planFiles(): string[] {
  return readdirSync(PLANS_DIR).filter((f) => f.endsWith(".md"));
}

describe("docs/README.md 设计文档索引 ↔ docs/plans/ 目录", () => {
  it("小节与表在场,每个数据行恰好链接一份文档、首列是日期", () => {
    expect(
      sectionLines().length,
      "找不到「## 设计文档索引」小节 —— 标题改名要连本测试一起改",
    ).toBeGreaterThan(0);
    const rows = indexRows();
    expect(rows.length, "小节里一行索引都没解析到").toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.links, `一行应恰好链接一份文档:${r.raw.slice(0, 80)}`).toBe(1);
      expect(r.date, `首列不是 YYYY-MM-DD 日期:${r.raw.slice(0, 80)}`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    }
  });

  it("链接集合 = 目录文件集合(双向) —— 加档漏登记、表挂死链、一档两行都点名报红", () => {
    // 排序数组而非 Set:同一文件被链两行时长度不等照样红,Set 会把重复吞掉。
    // 历史教训:只比数量曾在 24 链接 ↔ 24 文件的巧合下看似同步 —— 必须比集合。
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

  it("小节抬头「共 N 份」计数与目录一致(没写这句就没有可过期的东西)", () => {
    const m = sectionLines()
      .join("\n")
      .match(/共 \*\*(\d+) 份\*\*/);
    if (!m) return; // 同 apiDocsContract 活文档档数闸门的哲学:无声明即无过期
    expect(
      Number(m[1]),
      `小节抬头写着共 ${m[1]} 份,目录里实有 ${planFiles().length} 份`,
    ).toBe(planFiles().length);
  });
});
