"use client";

import Link from "next/link";
import { GUIDE_SECTIONS } from "../guide";
import { useLang } from "../i18n";

// /guide 功能说明书(设计文档 2026-08-28-feature-guide-design.md)。
// 数据唯一源在 app/guide.ts(中文),此处只做渲染并逐段过 t() ——
// 键即中文原文,译文在 lib/i18n/dict/guide.ts;数据层译文完整性由
// app/guide.test.ts 的机器闸保证(动态 t() 逃过 coverage 闸的盲区)。
// 页面公开但不进 NAV/sitemap:入口先只挂 /manage(复刻 /status 先例)。
export default function GuidePage() {
  const { t } = useLang();
  return (
    <main className="ds-main" style={{ maxWidth: 860 }}>
      <header style={{ marginBottom: "var(--s-5)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", margin: 0 }}>
          📚 {t("功能说明书")}
        </h1>
        <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
          {t(
            "每个板块三件事：这是什么、怎么使用、怎么解读。解读块继承全站的诚实纪律——每节都写清口径、样本与「别这么读」。名词级定义在",
          )}{" "}
          <Link href="/glossary">{t("说明")}</Link>
          {t("；本页讲板块。")}
        </div>
      </header>

      {/* 锚点目录 */}
      <nav
        className="ds-card"
        style={{
          padding: "var(--s-4)",
          marginBottom: "var(--s-6)",
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--s-2)",
        }}
        aria-label={t("目录")}
      >
        {GUIDE_SECTIONS.map((s) => (
          <a key={s.id} className="ds-btn ds-btn--sm" href={`#${s.id}`}>
            {s.icon} {t(s.title)}
          </a>
        ))}
      </nav>

      {GUIDE_SECTIONS.map((s) => (
        <section
          key={s.id}
          id={s.id}
          style={{ marginBottom: "var(--s-7)", scrollMarginTop: 72 }}
        >
          <h2
            style={{
              fontSize: "var(--t-xl)",
              marginBottom: "var(--s-1)",
              display: "flex",
              alignItems: "baseline",
              gap: "var(--s-2)",
              flexWrap: "wrap",
            }}
          >
            <span aria-hidden>{s.icon}</span>
            {t(s.title)}
            {s.href ? (
              <Link
                href={s.href}
                className="ds-hint"
                style={{ fontWeight: 400 }}
              >
                {s.href} {t("打开 →")}
              </Link>
            ) : null}
          </h2>
          <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
            {t(s.tagline)}
          </div>

          <div className="ds-label" style={{ marginBottom: "var(--s-1)" }}>
            {t("这是什么")}
          </div>
          <ul className="guide-list">
            {s.what.map((line, i) => (
              <li key={i}>{t(line)}</li>
            ))}
          </ul>

          <div
            className="ds-label"
            style={{ margin: "var(--s-3) 0 var(--s-1)" }}
          >
            {t("怎么使用")}
          </div>
          <ul className="guide-list">
            {s.how.map((line, i) => (
              <li key={i}>{t(line)}</li>
            ))}
          </ul>

          <div
            className="ds-callout ds-callout--warn"
            style={{ marginTop: "var(--s-3)" }}
          >
            <div className="ds-label" style={{ marginBottom: "var(--s-1)" }}>
              {t("怎么解读")}
            </div>
            <ul className="guide-list" style={{ margin: 0 }}>
              {s.read.map((line, i) => (
                <li key={i}>{t(line)}</li>
              ))}
            </ul>
          </div>
        </section>
      ))}

      <footer className="ds-hint" style={{ marginBottom: "var(--s-6)" }}>
        {t(
          "口径的完整论证散在设计文档与 CHANGELOG（GitHub 仓库 docs/），本页是它们的板块级摘要——两处冲突时以代码与测试为准。",
        )}
      </footer>
    </main>
  );
}
