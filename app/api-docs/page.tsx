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
import { siteBase } from "../../lib/seo";
import { StatCard } from "../ui";

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

/** 表头原文 → 纯文本(去反引号/星号),供 td[data-label] 的伪元素使用。 */
function plainLabel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.replace(/[`*]/g, "").trim();
  return s.length > 0 ? s : undefined;
}

// HTTP 方法徽章 —— 绿 = GET(只读),蓝 = 写/推送。方法名是这份文档里出现频率
// 最高的三字母,做成定宽徽章后「端点总览」那张表能一眼扫出哪几行是 POST。
// 尺寸取设计稿两档:38×18 用在表格与句中,48×22 用在端点小节标题。
const METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE)$/;
const ENDPOINT_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/;

function MethodBadge({ method, big }: { method: string; big?: boolean }) {
  const get = method === "GET";
  return (
    <span
      style={{
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: big ? 48 : 38,
        height: big ? 22 : 18,
        borderRadius: 4,
        background: get ? "var(--ww-up-bg)" : "var(--ww-link-bg-active)",
        color: get ? "var(--ww-up)" : "var(--ww-link)",
        fontSize: big ? "var(--t-xs)" : 10,
        fontWeight: 600,
        lineHeight: 1,
        verticalAlign: "middle",
      }}
    >
      {method}
    </span>
  );
}

// 代码面板页签上的显示名 —— 设计稿那一行写的是「cURL / Node / Python」而不是
// 围栏里的语言标注(bash / javascript / jsonc)。纯改标签文案,不碰代码内容。
const LANG_LABEL: Record<string, string> = {
  bash: "Shell",
  sh: "Shell",
  javascript: "Node",
  js: "Node",
  typescript: "TypeScript",
  ts: "TypeScript",
  json: "JSON",
  jsonc: "JSON",
  http: "HTTP",
  html: "HTML",
  python: "Python",
};

function langLabel(lang: string, code: string): string {
  // ```bash 里既有 curl 也有 claude mcp add —— 按首个命令认,认不出就退回 Shell。
  if (/^\s*curl\b/.test(code)) return "cURL";
  return LANG_LABEL[lang.toLowerCase()] ?? lang;
}

// 左栏「端点」组 —— 标题写成 `GET /api/x` 的小节。只读已解析好的块派生一份
// 跳转清单,不改解析器、不改文档:目录本身只收 h2(§1…§16),而读者找一条端点
// 时要的是「/api/health 在哪」,在十六个中文小节名里翻是最慢的一条路。
const HEADING_ENDPOINT_RE = /`(GET|POST|PUT|PATCH|DELETE)\s+(\S+?)`/g;

type RailEndpoint = { id: string; method: string; label: string };

function endpointRail(blocks: DocBlock[]): RailEndpoint[] {
  const out: RailEndpoint[] = [];
  for (const b of blocks) {
    if (b.kind !== "heading") continue;
    const hits = [...b.text.matchAll(HEADING_ENDPOINT_RE)];
    if (hits.length === 0) continue;
    // 一个标题挂两条(`GET /embed/record` · `GET /embed/status`)时全列出来,
    // 路径不截断 —— 截断规则只对钱包地址与交易哈希开口子。
    out.push({
      id: b.id,
      method: hits[0][1],
      label: hits.map((m) => m[2]).join(" · "),
    });
  }
  return out;
}

type InlineOpts = {
  /** 小节标题里的 `GET /api/x` 展开成「徽章 + 路径」,而不是一颗行内代码丸。 */
  endpoint?: boolean;
};

function renderInline(raw: string, keyPrefix: string, opts?: InlineOpts) {
  return renderPieces(parseInline(raw), keyPrefix, opts);
}

function renderPieces(pieces: Inline[], keyPrefix: string, opts?: InlineOpts) {
  return pieces.map((piece: Inline, idx: number) => {
    const key = `${keyPrefix}-${idx}`;
    switch (piece.kind) {
      case "code": {
        const m = piece.text.trim();
        if (METHOD_RE.test(m)) return <MethodBadge key={key} method={m} />;
        const ep = opts?.endpoint ? m.match(ENDPOINT_RE) : null;
        if (ep) {
          return (
            <span
              key={key}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--s-2)",
                verticalAlign: "middle",
              }}
            >
              <MethodBadge method={ep[1]} big />
              <span style={{ fontFamily: "var(--ww-font-mono)" }}>{ep[2]}</span>
            </span>
          );
        }
        return (
          <code className="doc-code" key={key}>
            {piece.text}
          </code>
        );
      }
      case "strong":
        // 粗体可裹代码/链接,故渲染子节点而非纯文本。
        return (
          <strong key={key}>{renderPieces(piece.children, key, opts)}</strong>
        );
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

/** 卡内标题条 —— 主标 600 + 一句 muted 口径(「这是查库生成的,不是快照」)。 */
function CardBar({ title, note }: { title: string; note: string }) {
  return (
    <div className="card-bar" style={{ fontWeight: 600 }}>
      {title}
      <span className="muted" style={{ fontWeight: 400 }}>
        {note}
      </span>
    </div>
  );
}

/**
 * 文档里 ```status 围栏块的替身:按当前开关实时渲染。
 *
 * 排版是 KPI 分格卡而不是三列表:读者在这里只问一个问题 ——「我这把 key 现在
 * 收得到什么」,四个答案(核心端点 / strategies / bus[] / 存证链)彼此并列、
 * 没有主次,分格卡一眼四格,比一张要横向读的表快。原来的「你会看到」一列不
 * 丢,降成每格的副行。
 */
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
  const on = busTypes.filter((b) => b.enabled);
  const off = busTypes.filter((b) => !b.enabled);
  return (
    <div
      className="ds-card"
      style={{ overflow: "hidden", margin: "0 0 var(--s-4)" }}
    >
      <CardBar
        title="你这把 key 现在实际收得到什么"
        note="· 打开本页时查库生成 · 非手写快照"
      />
      <section
        className="kpi"
        style={{
          border: 0,
          borderRadius: 0,
          boxShadow: "none",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        }}
      >
        <StatCard label="核心端点" icon="✅">
          <div className="kpi-value" style={{ color: "var(--ww-up)" }}>
            运行中
          </div>
          <div className="kpi-sub">
            active · settled · record30d —— 任何有效 key 都能拿到
          </div>
        </StatCard>
        <StatCard label="strategies" icon="📈">
          <div className="kpi-value">
            {strategies.length > 0
              ? `${strategies.length} 档对外发布`
              : "无档位对外发布"}
          </div>
          <div className="kpi-sub">
            {strategies.length > 0
              ? strategies.map((s) => s.name).join(" · ")
              : "strategies 为空结构（形状仍完整，不必判空）"}
          </div>
        </StatCard>
        <StatCard label="bus[] sourceType" icon="🚚">
          <div className="kpi-value">
            {on.length > 0 ? on.map((b) => b.type).join(" · ") : "三类均未开启"}
          </div>
          <div className="kpi-sub">
            {off.length > 0
              ? `${off.map((b) => b.type).join(" · ")} 未开启 —— 该类型不出现在数组里`
              : "三类全开 —— bus[] 会出现全部 sourceType"}
          </div>
        </StatCard>
        <StatCard label="存证链最新一条" icon="🔗">
          <div
            className="kpi-value"
            style={digestDay != null ? { color: "var(--ww-link)" } : undefined}
          >
            {digestDay ?? "尚未生成"}
          </div>
          <div className="kpi-sub">
            {digestDay != null
              ? "见 /api/record 的 digest"
              : "需已发布信号 + 公开频道配置"}
          </div>
        </StatCard>
      </section>
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
    // 空态给出路:不是「表坏了」,是此刻确实没有档位放开推送。
    return (
      <div
        className="ds-card"
        style={{ overflow: "hidden", margin: "0 0 var(--s-4)" }}
      >
        <CardBar title="strategies[].id ↔ 档名" note="· 打开本页时查库生成" />
        <div className="ds-empty" style={{ border: 0, borderRadius: 0 }}>
          当前没有任何档位对外发布，因此本部署暂无 id↔档名对照。
          <br />
          运营者放开推送后此表自动出现；在那之前 strategies 是空结构，
          形状仍完整，不必判空。
        </div>
      </div>
    );
  }
  return (
    <div
      className="ds-card"
      style={{ overflow: "hidden", margin: "0 0 var(--s-4)" }}
    >
      <CardBar title="strategies[].id ↔ 档名" note="· 打开本页时查库生成" />
      <div
        className="ds-table-wrap"
        style={{
          border: 0,
          borderRadius: 0,
          boxShadow: "none",
          margin: 0,
        }}
      >
        <table className="ds-table">
          <thead>
            <tr>
              <th style={{ width: 120 }}>本部署 id</th>
              <th style={{ width: 200 }}>code · 认档用它</th>
              <th>档名</th>
            </tr>
          </thead>
          <tbody>
            {status.strategies.map((s) => (
              <tr key={s.id}>
                <td data-label="本部署 id">{s.id}</td>
                <td data-label="code">
                  {s.code ? (
                    <code className="doc-code">{s.code}</code>
                  ) : (
                    <span className="faint">—（未登记）</span>
                  )}
                </td>
                <td className="cell-wrap" data-label="档名">
                  {s.name}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="note-strip note-strip--warn">
        ⚠️ 只列已对外发布的档 —— 你收不到未发布档的信号。左列的 id{" "}
        <strong>只对本部署有效</strong>
        ，别写进代码或配置：它是自增行号，种子块重播时会打洞，同一个档名在
        另一个库里就是另一个数字。要硬编码请用中间那列的 code。
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
      // 文档自身的 H1 与页头的 24/600 页标题是同一句话的两个版本,并排出现就是
      // 两级同号标题 —— 设计稿的头区只允许一个标题。留下锚点,不留第二个标题。
      if (block.level === 1) {
        return (
          <span
            aria-hidden
            id={block.id}
            style={{ display: "block", scrollMarginTop: 80 }}
          />
        );
      }
      // 标题里的 `GET /api/x` 展开成端点头(徽章 + 路径),正文里的不展开 ——
      // 句子中间塞一颗 48px 徽章会把行高撑出台阶。
      const inner = renderInline(block.text, id, { endpoint: true });
      if (block.level === 2) return <h2 id={block.id}>{inner}</h2>;
      if (block.level === 3) return <h3 id={block.id}>{inner}</h3>;
      return <h4 id={block.id}>{inner}</h4>;
    }
    case "paragraph":
      return <p>{renderInline(block.text, id)}</p>;
    case "code":
      // 代码面板 —— 全站唯一深色面。有语言标注时顶上加一条深色标签条
      // (设计稿的 cURL / Node / Python 页签行),横向滚动收进代码区,
      // 免得标签条跟着代码一起滑走。
      return block.lang ? (
        <pre className="doc-pre" style={{ padding: 0 }}>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              padding: "8px 12px",
              borderBottom: "1px solid var(--ww-code-line)",
              fontSize: "var(--t-sm)",
            }}
          >
            <span
              style={{
                padding: "4px 10px",
                borderRadius: "var(--r-sm)",
                background: "var(--ww-code-tab)",
                // 深色面上的字色走令牌（--ww-text-on-dark，与 tip-pop / 代码面板
                // 同一档），不写死 #fff：面板配色只在 :root 那一处调。
                color: "var(--ww-text-on-dark)",
              }}
            >
              {langLabel(block.lang, block.code)}
            </span>
          </span>
          <span style={{ display: "block", padding: 14, overflowX: "auto" }}>
            <code>{block.code}</code>
          </span>
        </pre>
      ) : (
        <pre className="doc-pre">
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
                    // data-label 供窄屏堆叠卡显示列名(表头在 <640 被隐去)。
                    // 取表头原文去掉行内标记 —— 伪元素只吃纯字符串。
                    <td
                      className="cell-wrap"
                      data-label={plainLabel(block.head[c])}
                      key={`${id}-r${r}c${c}`}
                    >
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
  const endpoints = endpointRail(blocks);

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
      <header className="page-head">
        <div style={{ minWidth: 0 }}>
          <span className="page-head__eyebrow">
            <span aria-hidden>🔌</span>
            <span>API 参考手册 · 订阅方接入</span>
          </span>
          <h1 className="page-head__title">Signals API 接入文档</h1>
          <p className="page-head__desc">
            持有 API key 的订阅方请按本文接入。正文由仓库里的 docs/api-access.md
            渲染，「当前开放状态」与「id ↔ 档名」两处在打开本页时查库生成，
            不是手写快照。
          </p>
        </div>
        {/* 基址是这页最常被复制的一行,收进灰底名称标签(不是状态色)。 */}
        <div className="page-head__actions">
          <span className="ds-tag">基址 {siteBase()}</span>
        </div>
      </header>
      <div className="doc-layout">
        <nav
          className="ds-card doc-toc"
          aria-label="目录"
          style={{
            background: "var(--ww-surface-muted)",
            padding: "var(--s-4) 0",
          }}
        >
          <div className="ds-label" style={{ padding: "0 12px var(--s-2)" }}>
            章节
          </div>
          <ol>
            {toc.map((t) => (
              <li key={t.id}>
                <a href={`#${t.id}`} style={{ padding: "6px 12px" }}>
                  {t.text}
                </a>
              </li>
            ))}
          </ol>
          {endpoints.length > 0 ? (
            <>
              <div
                className="ds-label"
                style={{ padding: "14px 12px var(--s-2)" }}
              >
                端点
              </div>
              <ol>
                {endpoints.map((e) => (
                  <li key={`ep-${e.id}`}>
                    <a
                      href={`#${e.id}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--s-2)",
                        padding: "6px 12px",
                      }}
                    >
                      <MethodBadge method={e.method} />
                      <span
                        style={{
                          minWidth: 0,
                          lineHeight: "var(--lh-snug)",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {e.label}
                      </span>
                    </a>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
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
