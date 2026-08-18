// 文档渲染用的极小 markdown 解析器 —— 只服务 /api-docs（docs/api-access.md）。
//
// 为什么手写而不是装一个 markdown 库:
//   1. 这份仓库的运行时依赖只有 6 个,为一个静态页引入解析器 + 其传递依赖,
//      是给唯一一个对外接口文档页加供应链面积,不划算;
//   2. 通用库按 CommonMark 处理软换行 —— 一律补空格。这份文档整段是硬折行
//      的中文,「不会挤占监控\n引擎的…」补空格后渲染成「监控 引擎」,通篇皆是。
//      CJK 感知的换行拼接(joinWrapped)在通用库里是要打补丁的,在这里是默认;
//   3. 支持的语法只需覆盖这一份文档:标题/段落/围栏代码/表格/列表/引用/分隔线,
//      加行内的 `code`、**粗体**、[链接](url)。范围封闭,行为可被测试穷举。
//
// 纪律:解析器**永不抛错**。文档是构建产物的一部分,一个畸形表格不该把接入
// 文档页变成 500 —— 认不出的行一律降级成普通段落,原文照出。

/** 行内片段 —— 渲染侧据此产出 React 元素(绝不拼 HTML 字符串,零注入面)。 */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "link"; text: string; href: string };

export type DocBlock =
  | { kind: "heading"; level: number; id: string; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lang: string; code: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "hr" };

// 中日韩字符与全角标点。两侧任一命中即视为「不需要空格的换行」。
const CJK = /[⺀-〿぀-ヿ㐀-䶿一-鿿＀-￯]/;

/**
 * 拼接一个硬折行的续行。CJK 两侧直接相接,其余按 CommonMark 补空格 ——
 * 「监控」+「引擎」不能变成「监控 引擎」,而 "AbortSignal" + "timeout" 必须
 * 留空格。这是本解析器存在的主要理由,改动前请先想清楚这两个反例。
 */
export function joinWrapped(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const boundaryIsCjk = CJK.test(a[a.length - 1]) || CJK.test(b[0]);
  return boundaryIsCjk ? a + b : `${a} ${b}`;
}

/** 标题 → 锚点 id(目录跳转用)。中文原样保留,浏览器与 URL 都能处理。 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s.-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

// 一次扫描搞定三种行内标记:交替匹配保证「先出现者先胜」,反引号里的内容
// 天然不再参与后续的粗体/链接匹配(它整段被吃掉了)。
const INLINE_RE = /`([^`]+)`|\*\*([^*]+?)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;

export function parseInline(raw: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of raw.matchAll(INLINE_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: raw.slice(last, at) });
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "strong", text: m[2] });
    else out.push({ kind: "link", text: m[3], href: m[4] });
    last = at + m[0].length;
  }
  if (last < raw.length) out.push({ kind: "text", text: raw.slice(last) });
  return out;
}

/** `| a | b \| c |` → ["a", "b | c"]。转义竖线不切分,还原成字面量。 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  // 去掉首尾的边框竖线后逐字符扫,\| 吃进单元格内容。
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (body[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += body[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

const isSeparatorRow = (line: string): boolean =>
  /^\|?[\s:|-]+\|[\s:|-]*$/.test(line.trim()) && line.includes("-");

const isTableRow = (line: string): boolean => line.trim().startsWith("|");

const BULLET_RE = /^\s*[-*]\s+(.*)$/;
const NUMBERED_RE = /^\s*\d+\.\s+(.*)$/;

export function parseMarkdownDoc(md: string): DocBlock[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: DocBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行:块分隔,无输出。
    if (!line.trim()) {
      i++;
      continue;
    }

    // 围栏代码 —— 必须最先判,否则代码里的 | 和 # 会被当成表格/标题。
    const fence = line.trim().match(/^```(\w*)/);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      i++; // 吃掉收尾围栏;未闭合(i 已越界)也照常收束,不抛错。
      blocks.push({ kind: "code", lang, code: body.join("\n") });
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const text = heading[2].trim();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        id: slugify(text),
        text,
      });
      i++;
      continue;
    }

    // 分隔线(--- / ***)。表格分隔行永远跟在表头之后,不会走到这里。
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    // 表格:表头 + 分隔行的两行前瞻。缺分隔行的 | 开头行按普通段落处理。
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      isSeparatorRow(lines[i + 1])
    ) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    // 引用块:连续的 > 行合成一段(内部硬折行按 CJK 规则拼接)。
    if (line.trimStart().startsWith(">")) {
      let text = "";
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        const stripped = lines[i].trimStart().replace(/^>\s?/, "").trim();
        text = joinWrapped(text, stripped);
        i++;
      }
      blocks.push({ kind: "quote", text });
      continue;
    }

    // 列表:有序/无序各自成块,缩进续行并入当前条目。
    const bullet = line.match(BULLET_RE);
    const numbered = line.match(NUMBERED_RE);
    if (bullet || numbered) {
      const ordered = !bullet;
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (!cur.trim()) break;
        const b = cur.match(BULLET_RE);
        const n = cur.match(NUMBERED_RE);
        if (b && !ordered) items.push(b[1].trim());
        else if (n && ordered) items.push(n[1].trim());
        else if ((b || n) && items.length > 0)
          break; // 换了列表类型,收束本块
        else if (/^\s/.test(cur) && items.length > 0) {
          items[items.length - 1] = joinWrapped(
            items[items.length - 1],
            cur.trim(),
          );
        } else break;
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // 段落:**首行无条件吃下**,续行才判块级起始标记。
    // 首行也做判定的话,一个走到这里却仍匹配某个块级前缀的行(例如缺分隔行
    // 的 `| …`,它已被表格分支以两行前瞻拒绝)会一个字都不产出,然后被下面
    // 的 i++ 静默丢弃 —— 内容凭空消失是本解析器最不能有的失败形态。
    let text = lines[i].trim();
    i++;
    while (i < lines.length) {
      const cur = lines[i];
      if (
        !cur.trim() ||
        /^#{1,6}\s/.test(cur) ||
        cur.trim().startsWith("```") ||
        cur.trimStart().startsWith(">") ||
        isTableRow(cur) ||
        /^\s*([-*]|\d+\.)\s+/.test(cur)
      ) {
        break;
      }
      text = joinWrapped(text, cur.trim());
      i++;
    }
    // 首行已被吃下且 i 已推进,循环必然收敛;空文本(全空白行)不产出块。
    if (text) blocks.push({ kind: "paragraph", text });
  }

  return blocks;
}

/** 目录项 —— 页面导航只收 `##` 级标题。 */
export interface DocTocEntry {
  id: string;
  text: string;
}

export function tocOf(blocks: DocBlock[]): DocTocEntry[] {
  return blocks
    .filter(
      (b): b is Extract<DocBlock, { kind: "heading" }> =>
        b.kind === "heading" && b.level === 2,
    )
    .map((b) => ({ id: b.id, text: b.text }));
}
