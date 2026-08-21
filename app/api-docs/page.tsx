import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildApiDocsStatus,
  type ApiDocsStatus,
} from "../../lib/apiDocsStatus";
import { openDb } from "../../lib/db";
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
//
// 「当前开放状态」是**渲染时查库生成**的,不写在 markdown 里:哪些档位放开了
// 推送、哪些总线类型开着,运营者在 /manage 随时可改。手写快照(原文里那张
// 「截至 2026-08-19…」的表)在开关一拨之后就开始骗人,而没有任何机制会提醒
// 谁去改它。markdown 因此只保留**系统能力的全集**(永不过期),此刻开着什么
// 由 lib/apiDocsStatus 回答(永不撒谎)。文档里用 ```status 围栏块占位。
//
// §8.3 的 ```strategy_ids 是同一条纪律的第二次应用,起因是一次真实误读:
// 原文那张 19 档表带一列 `#`(1…19 的行序),读者顺理成章把它当成
// `strategy.id`。但 id 是 follow_strategies 的自增行号,而种子块按版本门控
// 整体重播、`INSERT OR IGNORE` 命中 UNIQUE 时**照样消耗 AUTOINCREMENT 号**
// —— 于是每次 bump 都在 id 上打一排洞,id 图谱变成「这个库是哪个种子版本
// 建的」的函数。同一个「超级巨鲸」在全新库是 7,在本服务的库(v1 时代建的)
// 是 9,而 7 在本服务上是「首发共识」。照 `#` 硬编码 strategyId===7 不报错,
// 只是静默地读了另一档。行序列因此从 markdown 里删掉(它对订阅方零用处、
// 一个陷阱),真实映射改由本模块查库回答。
// 数据仍复用 buildApiDocsStatus.strategies(push_enabled=1,按 id 升序)——
// 订阅方本来也只会收到已放开推送的档,不必也不该多列。
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

function Pill({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span className={`status-pill status-pill--${on ? "up" : "down"}`}>
      {children}
    </span>
  );
}

/** 文档里 ```status 围栏块的替身:按当前开关实时渲染。 */
function LiveStatus({ status }: { status: ApiDocsStatus | null }) {
  if (!status) {
    return (
      <div className="ds-callout ds-callout--warn">
        当前开放状态暂时读不到（数据库不可用）。本文其余部分描述的是系统能力的
        全集，具体哪些已对外开放请联系运营者确认。
      </div>
    );
  }
  const { strategies, busTypes, digestDay } = status;
  return (
    <div className="ds-table-wrap">
      <table className="ds-table">
        <thead>
          <tr>
            <th>能力</th>
            <th>当前状态</th>
            <th>你会看到</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code className="doc-code">active</code> /{" "}
              <code className="doc-code">settled</code> /{" "}
              <code className="doc-code">record30d</code>
            </td>
            <td>
              <Pill on>运行中</Pill>
            </td>
            <td>正常数据，任何有效 key 都能拿到</td>
          </tr>
          <tr>
            <td>
              <code className="doc-code">strategies</code>
            </td>
            <td>
              <Pill on={strategies.length > 0}>
                {strategies.length > 0
                  ? `${strategies.length} 档对外发布`
                  : "无档位对外发布"}
              </Pill>
            </td>
            <td>
              {strategies.length > 0 ? (
                <>
                  {strategies.map((s, i) => (
                    <span key={s.id}>
                      {i > 0 && "、"}
                      {s.name}
                      <span className="muted">（id={s.id}）</span>
                    </span>
                  ))}
                  <span className="muted"> 的信号与战绩</span>
                </>
              ) : (
                <>
                  <code className="doc-code">strategies</code>{" "}
                  为空结构（形状仍完整）
                </>
              )}
            </td>
          </tr>
          {busTypes.map((b) => (
            <tr key={b.type}>
              <td>
                <code className="doc-code">bus[]</code>
                <span className="muted"> · {b.label}</span>
              </td>
              <td>
                <Pill on={b.enabled}>{b.enabled ? "已开启" : "未开启"}</Pill>
              </td>
              <td>
                {b.enabled ? (
                  <>
                    <code className="doc-code">
                      sourceType: &quot;{b.type}&quot;
                    </code>{" "}
                    的条目
                  </>
                ) : (
                  <>
                    该类型不出现在 <code className="doc-code">bus[]</code> 里
                  </>
                )}
              </td>
            </tr>
          ))}
          <tr>
            <td>存证链</td>
            <td>
              <Pill on={digestDay != null}>
                {digestDay != null ? "运行中" : "尚未生成"}
              </Pill>
            </td>
            <td>
              {digestDay != null ? (
                <>
                  最近一条 <span className="mono">{digestDay}</span>，见{" "}
                  <code className="doc-code">/api/record</code> 的{" "}
                  <code className="doc-code">digest</code>
                </>
              ) : (
                <>需已发布信号 + 公开频道配置</>
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** 文档 §8.3 里 ```strategy_ids 围栏块的替身:本部署此刻真实的 id↔档名。 */
function LiveStrategyIds({ status }: { status: ApiDocsStatus | null }) {
  if (!status) {
    return (
      <div className="ds-callout ds-callout--warn">
        本部署的 id↔档名对照表暂时读不到（数据库不可用）。请改用{" "}
        <code className="doc-code">name</code> 认档，或调一次{" "}
        <code className="doc-code">/api/record</code>
        （公开、无需 key）拿当下的对照。
      </div>
    );
  }
  if (status.strategies.length === 0) {
    return (
      <div className="ds-callout">
        当前没有任何档位对外发布，因此本部署暂无 id↔档名对照。放开推送后此表
        自动出现。
      </div>
    );
  }
  return (
    <div className="ds-table-wrap">
      <table className="ds-table">
        <thead>
          <tr>
            <th>
              本部署的 <code className="doc-code">id</code>
            </th>
            <th>
              <code className="doc-code">code</code>（认档用它）
            </th>
            <th>
              档名（<code className="doc-code">name</code>）
            </th>
          </tr>
        </thead>
        <tbody>
          {status.strategies.map((s) => (
            <tr key={s.id}>
              <td className="mono">{s.id}</td>
              <td>
                {s.code ? (
                  <code className="doc-code">{s.code}</code>
                ) : (
                  <span className="muted">—（未登记）</span>
                )}
              </td>
              <td>{s.name}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
        只列已对外发布的档——你收不到未发布档的信号。左列的
        <strong>数字只对本部署有效</strong>，别写进代码或配置；要硬编码请用
        中间那列的 <code className="doc-code">code</code>。
      </div>
    </div>
  );
}

function Block({
  block,
  id,
  status,
}: {
  block: DocBlock;
  id: string;
  status: ApiDocsStatus | null;
}) {
  // ```status / ```strategy_ids 是占位符,不是代码 —— 换成实时表格。
  if (block.kind === "code" && block.lang === "status") {
    return <LiveStatus status={status} />;
  }
  if (block.kind === "code" && block.lang === "strategy_ids") {
    return <LiveStrategyIds status={status} />;
  }
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

  // 实时开放状态。查库失败不该让整份文档打不开 —— 文档的主体(字段契约)
  // 与库无关,降级成一条「状态读不到」的提示即可。
  let status: ApiDocsStatus | null = null;
  try {
    const db = openDb(process.env.DASH_DB ?? "data.sqlite");
    try {
      status = buildApiDocsStatus(db);
    } finally {
      db.close();
    }
  } catch (e) {
    console.error("[/api-docs] 读取开放状态失败:", e);
  }

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
            <Block block={block} id={`b${n}`} key={`b${n}`} status={status} />
          ))}
        </article>
      </div>
    </main>
  );
}
