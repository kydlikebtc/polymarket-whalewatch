import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseInline,
  parseMarkdownDoc,
  tocOf,
  type DocBlock,
  type Inline,
} from "../../lib/markdownDoc";

// 订阅者接入文档的站内入口 —— 运营者签发 key 后把这个 URL 一并发过去。
//
// 内容直接读 docs/api-access.md(仓库内那份唯一真相),不复制一份到 JSX 里:
// 两处维护必然漂移,而"文档与实际接口不符"是 API 最贵的缺陷。
//
// 排版走 lib/markdownDoc.ts 的解析器而不是把原文塞进 <pre>:这份文档的主体
// 是**字段类型表**与**类型定义块**,原文渲染下一张表就是一堵管道符墙,读者
// 得自己在脑子里对齐列 —— 一份"讲清楚数据类型和数据格式"的文档,排版失败
// 就是内容失败。渲染全程只构造 React 元素(React 默认转义文本),不走任何
// 原始 HTML 注入路径,所以解析器再怎么改都开不出 XSS 面。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Signals API — 接入文档",
  description:
    "WhaleWatch 信号 API 的接入说明：鉴权、tier 语义、响应结构、数据类型与格式、失败语义与拉取频率。",
  // 内部对接文档,不进搜索索引。
  robots: { index: false, follow: false },
};

const DOC_PATH = join(process.cwd(), "docs", "api-access.md");

const MISSING_DOC =
  "文档文件未随部署一起分发（docs/api-access.md）。\n" +
  "请确认镜像构建包含 docs 目录（Dockerfile 的 COPY docs）。";

function renderInline(raw: string, keyPrefix: string) {
  return renderPieces(parseInline(raw), keyPrefix);
}

function renderPieces(pieces: Inline[], keyPrefix: string) {
  return pieces.map((piece: Inline, idx: number) => {
    const key = `${keyPrefix}-${idx}`;
    switch (piece.kind) {
      case "code":
        return (
          <code className="doc-code" key={key}>
            {piece.text}
          </code>
        );
      case "strong":
        // 粗体可裹代码/链接,故渲染子节点而非纯文本。
        return <strong key={key}>{renderPieces(piece.children, key)}</strong>;
      case "link":
        return (
          <a
            href={piece.href}
            key={key}
            // 站外链接新标签打开并切断 opener 引用。
            {...(piece.href.startsWith("http")
              ? { target: "_blank", rel: "noreferrer noopener" }
              : {})}
          >
            {piece.text}
          </a>
        );
      default:
        return <span key={key}>{piece.text}</span>;
    }
  });
}

function Block({ block, id }: { block: DocBlock; id: string }) {
  switch (block.kind) {
    case "heading": {
      const inner = renderInline(block.text, id);
      if (block.level === 1) return <h1 id={block.id}>{inner}</h1>;
      if (block.level === 2) return <h2 id={block.id}>{inner}</h2>;
      if (block.level === 3) return <h3 id={block.id}>{inner}</h3>;
      return <h4 id={block.id}>{inner}</h4>;
    }
    case "paragraph":
      return <p>{renderInline(block.text, id)}</p>;
    case "code":
      return (
        <pre className="doc-pre">
          {block.lang ? (
            <span className="doc-pre-lang">{block.lang}</span>
          ) : null}
          <code>{block.code}</code>
        </pre>
      );
    case "table":
      return (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                {block.head.map((cell, c) => (
                  <th key={`${id}-h${c}`}>
                    {renderInline(cell, `${id}-h${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={`${id}-r${r}`}>
                  {row.map((cell, c) => (
                    <td key={`${id}-r${r}c${c}`}>
                      {renderInline(cell, `${id}-r${r}c${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "list": {
      const items = block.items.map((item, n) => (
        <li key={`${id}-i${n}`}>{renderInline(item, `${id}-i${n}`)}</li>
      ));
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case "quote":
      return <blockquote>{renderInline(block.text, id)}</blockquote>;
    case "hr":
      return <hr />;
  }
}

export default function ApiDocsPage() {
  let md: string;
  try {
    md = readFileSync(DOC_PATH, "utf8");
  } catch {
    // 容器里没带上 docs 时给出可操作的提示,而不是一个空白页。
    md = MISSING_DOC;
  }
  const blocks = parseMarkdownDoc(md);
  const toc = tocOf(blocks);

  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-4)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", margin: 0 }}>
          🔌 Signals API 接入文档
        </h1>
        <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
          持有 API key 的订阅方请按本文接入；key 由运营者签发，明文仅显示一次。
        </div>
      </header>
      <div className="doc-layout">
        <nav className="ds-card doc-toc" aria-label="目录">
          <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
            目录
          </div>
          <ol>
            {toc.map((t) => (
              <li key={t.id}>
                <a href={`#${t.id}`}>{t.text}</a>
              </li>
            ))}
          </ol>
        </nav>
        <article className="ds-card doc-prose">
          {blocks.map((block, n) => (
            <Block block={block} id={`b${n}`} key={`b${n}`} />
          ))}
        </article>
      </div>
    </main>
  );
}
