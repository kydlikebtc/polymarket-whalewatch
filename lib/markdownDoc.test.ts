import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  joinWrapped,
  parseInline,
  parseMarkdownDoc,
  slugify,
  tocOf,
  type DocBlock,
} from "./markdownDoc";

const kinds = (blocks: DocBlock[]) => blocks.map((b) => b.kind);

describe("joinWrapped —— 硬折行的 CJK 拼接", () => {
  it("中文换行不补空格(「监控 引擎」是这个解析器存在的理由)", () => {
    expect(joinWrapped("不会挤占监控", "引擎的预算")).toBe(
      "不会挤占监控引擎的预算",
    );
  });

  it("英文换行照常补空格", () => {
    expect(joinWrapped("AbortSignal", "timeout")).toBe("AbortSignal timeout");
  });

  it("一侧是中文标点也不补空格", () => {
    expect(joinWrapped("签发，", "明文只显示一次")).toBe(
      "签发，明文只显示一次",
    );
    expect(joinWrapped("the Polymarket API", "预算")).toBe(
      "the Polymarket API预算",
    );
  });

  it("空串两侧是恒等元", () => {
    expect(joinWrapped("", "a")).toBe("a");
    expect(joinWrapped("a", "")).toBe("a");
  });
});

describe("parseInline", () => {
  it("拆出 code / strong / link 与其间的纯文本", () => {
    expect(
      parseInline("看 `x-feed-token` 与 **必读** 和 [站点](https://a.b)"),
    ).toEqual([
      { kind: "text", text: "看 " },
      { kind: "code", text: "x-feed-token" },
      { kind: "text", text: " 与 " },
      { kind: "strong", text: "必读" },
      { kind: "text", text: " 和 " },
      { kind: "link", text: "站点", href: "https://a.b" },
    ]);
  });

  it("反引号里的星号不被当成粗体(代码是原样区)", () => {
    expect(parseInline("`a ** b`")).toEqual([{ kind: "code", text: "a ** b" }]);
  });

  it("无标记时原样单段返回", () => {
    expect(parseInline("纯文本")).toEqual([{ kind: "text", text: "纯文本" }]);
  });
});

describe("parseMarkdownDoc —— 块级", () => {
  it("标题带层级与锚点 id", () => {
    const [h] = parseMarkdownDoc("## 6. 响应结构");
    expect(h).toEqual({
      kind: "heading",
      level: 2,
      id: "6.-响应结构",
      text: "6. 响应结构",
    });
  });

  it("围栏代码原样保留,内部的 | 和 # 不被解析", () => {
    const md = ["```typescript", "// # 注释", "const a = b | c;", "```"].join(
      "\n",
    );
    expect(parseMarkdownDoc(md)).toEqual([
      { kind: "code", lang: "typescript", code: "// # 注释\nconst a = b | c;" },
    ]);
  });

  it("未闭合的围栏也收束,不抛错也不死循环", () => {
    const blocks = parseMarkdownDoc("```\nabc");
    expect(blocks).toEqual([{ kind: "code", lang: "", code: "abc" }]);
  });

  it("表格解析出表头与数据行", () => {
    const md = [
      "| 参数 | 默认 |",
      "| ---- | ---- |",
      "| `windowHours` | 24 |",
    ].join("\n");
    expect(parseMarkdownDoc(md)).toEqual([
      {
        kind: "table",
        head: ["参数", "默认"],
        rows: [["`windowHours`", "24"]],
      },
    ]);
  });

  it("单元格里的转义竖线不切分(联合类型 \\| 必须活下来)", () => {
    const md = ["| 形状 |", "| --- |", '| `"BUY"\\|"SELL"\\|null` |'].join(
      "\n",
    );
    const [table] = parseMarkdownDoc(md);
    expect(table).toMatchObject({
      rows: [['`"BUY"|"SELL"|null`']],
    });
  });

  it("缺分隔行的竖线开头行降级为段落,不是畸形表格", () => {
    expect(kinds(parseMarkdownDoc("| 不是表格"))).toEqual(["paragraph"]);
  });

  it("无序列表的缩进续行并入上一条", () => {
    const md = ["- 第一条继续", "  往下一行", "- 第二条"].join("\n");
    expect(parseMarkdownDoc(md)).toEqual([
      { kind: "list", ordered: false, items: ["第一条继续往下一行", "第二条"] },
    ]);
  });

  it("有序列表单独成块", () => {
    const md = ["1. 顶部展示中断提示", "2. 冻结时间戳"].join("\n");
    expect(parseMarkdownDoc(md)).toEqual([
      {
        kind: "list",
        ordered: true,
        items: ["顶部展示中断提示", "冻结时间戳"],
      },
    ]);
  });

  it("引用块合并连续的 > 行", () => {
    const md = ["> 面向订阅方。", "> 明文只显示一次。"].join("\n");
    expect(parseMarkdownDoc(md)).toEqual([
      { kind: "quote", text: "面向订阅方。明文只显示一次。" },
    ]);
  });

  it("--- 是分隔线而不是表格残片", () => {
    expect(kinds(parseMarkdownDoc("段落\n\n---\n\n段落"))).toEqual([
      "paragraph",
      "hr",
      "paragraph",
    ]);
  });

  it("段落遇到下一个块级标记即收束", () => {
    expect(kinds(parseMarkdownDoc("一段话\n## 标题"))).toEqual([
      "paragraph",
      "heading",
    ]);
  });

  it("空输入产出空数组", () => {
    expect(parseMarkdownDoc("")).toEqual([]);
    expect(parseMarkdownDoc("\n\n  \n")).toEqual([]);
  });
});

describe("tocOf", () => {
  it("只收 ## 级标题", () => {
    const md = ["# 大标题", "## 一节", "### 小节", "## 二节"].join("\n");
    expect(tocOf(parseMarkdownDoc(md))).toEqual([
      { id: "一节", text: "一节" },
      { id: "二节", text: "二节" },
    ]);
  });
});

describe("slugify", () => {
  it("去掉标点与反引号,空格换连字符", () => {
    expect(slugify("`GET /api/record` — 公开战绩")).toBe(
      "get-apirecord-公开战绩",
    );
  });
});

// 真文档的冒烟测试:/api-docs 渲染的就是这个文件,解析结果必须结构完整。
// 这道闸门的价值在于它会随文档一起演进 —— 有人往文档里写了本解析器认不出
// 的语法时,是这里先红,而不是线上页面先烂。
describe("docs/api-access.md 真文件", () => {
  const md = readFileSync(join(process.cwd(), "docs", "api-access.md"), "utf8");
  const blocks = parseMarkdownDoc(md);

  it("解析出全部块类型且无空段落", () => {
    const seen = new Set(kinds(blocks));
    for (const k of [
      "heading",
      "paragraph",
      "code",
      "table",
      "list",
      "quote",
    ]) {
      expect(seen.has(k as DocBlock["kind"]), `缺少 ${k} 块`).toBe(true);
    }
    for (const b of blocks) {
      if (b.kind === "paragraph") expect(b.text.trim()).not.toBe("");
    }
  });

  it("没有任何一行原始 markdown 语法漏进段落文本", () => {
    // 段落里若出现行首 # / | / ``` ,说明该行没被块级规则识别 —— 页面上会
    // 显示成裸语法,正是重写渲染要消灭的东西。
    for (const b of blocks) {
      if (b.kind !== "paragraph") continue;
      expect(b.text.startsWith("#"), b.text.slice(0, 40)).toBe(false);
      expect(b.text.startsWith("|"), b.text.slice(0, 40)).toBe(false);
      expect(b.text.includes("```"), b.text.slice(0, 40)).toBe(false);
    }
  });

  it("每张表的数据行列数与表头一致", () => {
    for (const b of blocks) {
      if (b.kind !== "table") continue;
      for (const row of b.rows) {
        expect(row.length, `表头 ${b.head.join("/")} 的行列数不一致`).toBe(
          b.head.length,
        );
      }
    }
  });

  it("目录覆盖全部一级章节且锚点唯一", () => {
    const toc = tocOf(blocks);
    expect(toc.length).toBeGreaterThanOrEqual(12);
    expect(new Set(toc.map((t) => t.id)).size).toBe(toc.length);
  });
});
