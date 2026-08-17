import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 订阅者接入文档的站内入口 —— 运营者签发 key 后把这个 URL 一并发过去。
//
// 内容直接读 docs/api-access.md(仓库内那份唯一真相),不复制一份到 JSX 里:
// 两处维护必然漂移,而"文档与实际接口不符"是 API 最贵的缺陷。渲染用等宽
// 原文而非 markdown 解析器 —— 受众是工程师,原文可读且零解析风险;真要
// 好看的排版,把 md 交给任何静态站生成器即可。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Signals API — 接入文档",
  description:
    "WhaleWatch 信号 API 的接入说明：鉴权、tier 语义、响应结构、失败语义与拉取频率。",
  // 内部对接文档,不进搜索索引。
  robots: { index: false, follow: false },
};

const DOC_PATH = join(process.cwd(), "docs", "api-access.md");

export default function ApiDocsPage() {
  let md: string;
  try {
    md = readFileSync(DOC_PATH, "utf8");
  } catch {
    // 容器里没带上 docs 时给出可操作的提示,而不是一个空白页。
    md =
      "文档文件未随部署一起分发（docs/api-access.md）。\n" +
      "请确认镜像构建包含 docs 目录（Dockerfile 的 COPY docs）。";
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
      <div className="ds-card" style={{ padding: "var(--s-5)" }}>
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--t-sm)",
            lineHeight: "var(--lh-normal)",
            color: "var(--n-800)",
          }}
        >
          {md}
        </pre>
      </div>
    </main>
  );
}
