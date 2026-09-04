"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { GUIDE_SECTIONS } from "../guide";
import { useLang } from "../i18n";

// /guide 功能说明书(设计文档 2026-08-28-feature-guide-design.md)。
// 数据唯一源在 app/guide.ts(中文),此处只做渲染并逐段过 t() ——
// 键即中文原文,译文在 lib/i18n/dict/guide.ts;数据层译文完整性由
// app/guide.test.ts 的机器闸保证(动态 t() 逃过 coverage 闸的盲区)。
// 页面公开但不进 NAV/sitemap:入口先只挂 /manage(复刻 /status 先例)。
//
// 版式(设计稿 16「功能说明书 · 17 节」):页头 → 口径条 → 左侧锚点目录粘顶
// (当前项由 scroll-spy 点亮) + 右侧一节一张白卡;卡内三行「01 这是什么 /
// 02 怎么使用 / 03 怎么解读」,12px 大写小标在左 120px 槽,内容在右。
// 层级只来自 1px 分格线与小标,不来自字号跳档。
//
// 页面正文不解释自己:原先末尾那句「页面保留纵向长页…左侧目录粘顶」描述的
// 是读者眼前就能看见的版式,删掉不丢信息。留下的说明只剩两处 —— 页头一句
// 「这页是什么」,和唯一那条会改变读法的琥珀口径条。

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

  // 目录当前项(scroll-spy)—— 样式在 globals.css 的 .doc-toc a[aria-current]
  // (蓝字 + 白底 + 左侧 2px 蓝轨)。用 IntersectionObserver 而不是 :target:
  // 后者只在点击后生效,滚动进入某节时不亮。
  const [activeId, setActiveId] = useState<string>(GUIDE_SECTIONS[0]?.id ?? "");
  const visibleIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = GUIDE_SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => el != null,
    );
    if (els.length === 0) return;
    const seen = visibleIds.current;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) seen.add(e.target.id);
          else seen.delete(e.target.id);
        }
        // 取文档序最靠前的可见节 —— 一屏能装下两三张卡时,当前项应该是
        // 顶上那张,而不是最后一个触发回调的那张。
        const first = GUIDE_SECTIONS.find((s) => seen.has(s.id));
        if (first) setActiveId(first.id);
      },
      // 上 -72px 与卡片的 scrollMarginTop 对齐(粘顶栏高度);下 -55% 把判定
      // 带收到视口上半,否则长页里五六节同时可见,当前项会来回跳。
      { rootMargin: "-72px 0px -55% 0px" },
    );
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, []);

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
            {t("每个板块三件事：这是什么、怎么使用、怎么解读。")}
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

      {/* 口径条 —— 全页唯一一条琥珀框，紧跟页头放在正文之前(不做脚注)。
          留它是因为它会改变读法:本页是摘要，不是权威口径本身。 */}
      <div
        className="ds-callout ds-callout--warn"
        style={{ marginBottom: "var(--s-5)" }}
      >
        {t("本页是各板块口径的摘要；与代码 / 测试冲突时以后者为准。")}
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
                  // 点击立刻点亮 —— 平滑滚动期间 observer 还没回调。
                  aria-current={activeId === s.id ? "true" : undefined}
                  onClick={() => setActiveId(s.id)}
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
        </div>
      </div>
    </main>
  );
}
