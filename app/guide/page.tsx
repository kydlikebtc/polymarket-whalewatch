"use client";

import Link from "next/link";
import { GUIDE_SECTIONS } from "../guide";
import { useLang } from "../i18n";

// /guide 功能说明书(设计文档 2026-08-28-feature-guide-design.md)。
// 数据唯一源在 app/guide.ts(中文),此处只做渲染并逐段过 t() ——
// 键即中文原文,译文在 lib/i18n/dict/guide.ts;数据层译文完整性由
// app/guide.test.ts 的机器闸保证(动态 t() 逃过 coverage 闸的盲区)。
// 页面公开但不进 NAV/sitemap:入口先只挂 /manage(复刻 /status 先例)。
//
// 版式(设计稿 16「功能说明书 · 17 节」):页头 → 口径条 → 左侧锚点目录粘顶
// + 右侧一节一张白卡;卡内三行「01 这是什么 / 02 怎么使用 / 03 怎么解读」,
// 12px 大写小标在左 120px 槽,内容在右。层级只来自 1px 分格线与小标,
// 不来自字号跳档。

// 卡内一行:左 12px 编号小标 + 右内容列表。三块同权,「怎么解读」不再
// 单独套琥珀框 —— 口径框全页只出现一次(页头下那条),不逐节重复。
// 尺寸照设计稿 16:120px 标签槽 + 12px 列间距 + 12/16 行内边距 + 14px 正文,
// 标签在行内垂直居中(设计稿的 align-items:center);窄屏标签槽可缩到 88px。
function GuideBlock({
  no,
  label,
  lines,
  divider,
}: {
  no: string;
  label: string;
  lines: string[];
  divider?: boolean;
}) {
  const { t } = useLang();
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(88px, 120px) minmax(0, 1fr)",
        gap: "var(--s-3)",
        alignItems: "center",
        padding: "var(--s-3) var(--s-4)",
        borderBottom: divider ? "1px solid var(--ww-border)" : undefined,
        fontSize: "var(--t-md)",
      }}
    >
      <span className="ds-label">
        {no} {label}
      </span>
      <ul
        className="guide-list"
        style={{ margin: 0, lineHeight: "var(--lh-note)" }}
      >
        {lines.map((line, i) => (
          <li key={i}>{t(line)}</li>
        ))}
      </ul>
    </div>
  );
}

export default function GuidePage() {
  const { t } = useLang();
  return (
    <main className="ds-main">
      <header className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="page-head__eyebrow">
            <span aria-hidden>📚</span>
            {t("板块级说明 · 名词级见「说明」")}
          </div>
          <h1 className="page-head__title">{t("功能说明书")}</h1>
          <p className="page-head__desc">
            {t(
              "每个板块三件事：这是什么、怎么使用、怎么解读。解读块写清口径、样本与「别这么读」。",
            )}
          </p>
        </div>
        <div className="page-head__actions">
          <span className="ds-btn" style={{ cursor: "default" }}>
            {t("共 {n} 节", { n: GUIDE_SECTIONS.length })}
          </span>
          <Link className="ds-btn" href="/glossary">
            {t("说明")} →
          </Link>
        </div>
      </header>

      {/* 口径条 —— 琥珀框紧跟页头，放在正文之前(不做脚注) */}
      <div
        className="ds-callout ds-callout--warn"
        style={{ marginBottom: "var(--s-5)" }}
      >
        {t(
          "口径的完整论证散在设计文档与 CHANGELOG（GitHub 仓库 docs/），本页是它们的板块级摘要——两处冲突时以代码与测试为准。",
        )}
      </div>

      <div className="doc-layout">
        {/* 锚点目录 —— 粘顶灰轨;≤900px 由 .doc-layout 自动落回单栏 */}
        <nav
          className="doc-toc"
          aria-label={t("目录")}
          style={{
            padding: "var(--s-4) 0",
            background: "var(--ww-surface-muted)",
            border: "1px solid var(--ww-border)",
            borderRadius: "var(--r-md)",
          }}
        >
          <div
            className="ds-label"
            style={{ padding: "0 var(--s-4)", marginBottom: "10px" }}
          >
            {t("锚点目录")}
          </div>
          <ol style={{ gap: 0 }}>
            {GUIDE_SECTIONS.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--s-2)",
                    padding: "8px var(--s-4)",
                    borderRadius: 0,
                    fontSize: "var(--t-md)",
                  }}
                >
                  <span aria-hidden style={{ flex: "0 0 auto", width: 18 }}>
                    {s.icon}
                  </span>
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                    {t(s.title)}
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </nav>

        {/* 一节一张白卡，纵向长页可从头读到尾 */}
        <div
          style={{
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: "var(--s-4)",
          }}
        >
          {GUIDE_SECTIONS.map((s) => (
            <section
              key={s.id}
              id={s.id}
              className="ds-card"
              style={{ overflow: "hidden", scrollMarginTop: 72 }}
            >
              <div className="card-bar" style={{ alignItems: "baseline" }}>
                <span aria-hidden style={{ fontSize: 20, lineHeight: 1 }}>
                  {s.icon}
                </span>
                <h2 style={{ fontSize: 18, fontWeight: 600 }}>{t(s.title)}</h2>
                <span
                  className="muted"
                  style={{
                    minWidth: 0,
                    fontSize: "var(--t-base)",
                    lineHeight: "var(--lh-snug)",
                    overflowWrap: "anywhere",
                  }}
                >
                  {t(s.tagline)}
                </span>
                {s.href ? (
                  <Link
                    href={s.href}
                    style={{
                      marginLeft: "auto",
                      fontSize: "var(--t-base)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t("打开 →")}
                  </Link>
                ) : null}
              </div>

              <GuideBlock
                no="01"
                label={t("这是什么")}
                lines={s.what}
                divider
              />
              <GuideBlock no="02" label={t("怎么使用")} lines={s.how} divider />
              <GuideBlock no="03" label={t("怎么解读")} lines={s.read} />
            </section>
          ))}

          {/* 版式说明脚注(设计稿 16 末行)—— 13px muted，不成卡不加框 */}
          <p className="ds-hint" style={{ margin: 0 }}>
            {t("页面保留纵向长页，可从头读到尾；左侧锚点目录粘顶。")}
          </p>
        </div>
      </div>
    </main>
  );
}
