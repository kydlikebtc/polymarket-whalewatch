"use client";

import { ICONS, TERMS, WALLET_TAGS } from "../glossary";
import { useLang } from "../i18n";
import { Tag } from "../ui";

// Static reference page — every symbol and term the dashboard uses, from the
// same data source that powers the hover tooltips (app/glossary.ts).
//
// 双语化:词表数据(app/glossary.ts)是中文唯一源,页面只在渲染处过
// t(中文串) —— 键即中文原文,译文全部在 lib/i18n/dict/glossary.ts。
// 所以 name/tip/detail 与各页悬停提示走同一批键,永不漂移;缺译回退中文。
//
// 版式(设计稿 17「说明 · 图标与名词」):页头 → 跳转条 → 五级阶梯卡 →
// 图标表 → 钱包标签三组卡 → 名词双栏定义列表。徽章五类语义固定:
// ✅ 绿=命中 · ❌ 红=反向 · 灰底=名称标签(不表示状态)。

// 三类 kind 的展示顺序 —— 与 app/glossary.ts 的 WalletTagEntry["kind"] 同集合。
const TAG_KINDS = ["状态", "来源", "渠道证据"] as const;

// 符号列:结算三态用徽章(绿/红/灰底),交互符号用灰底名称标签,
// 其余 emoji 保持 20px 裸符号 —— emoji 在这里承担语义,不加框。
function IconSymbol({ symbol }: { symbol: string }) {
  if (symbol === "✅") return <Tag variant="up">✅</Tag>;
  if (symbol === "❌") return <Tag variant="down">❌</Tag>;
  if (["➖", "↗", "⧉", "…"].includes(symbol)) return <Tag>{symbol}</Tag>;
  return <span style={{ fontSize: 20, lineHeight: 1 }}>{symbol}</span>;
}

export default function GlossaryPage() {
  const { t } = useLang();
  const total = ICONS.length + WALLET_TAGS.length + TERMS.length;

  // 五级信号强度阶梯(设计系统 §1 固定):档位与门槛取 app/glossary.ts 的
  // 既有口径 —— 共识是 ≥2 个白名单同向,不是 ≥3。
  const ladder = [
    {
      symbol: "💰",
      name: t("大额成交"),
      sub: t("单笔达阈值（默认 ≥$10k）"),
      tone: "var(--ww-text-faint)",
    },
    {
      symbol: "🐳",
      name: t("巨鲸单"),
      sub: t("单笔 ≥$50k"),
      tone: "var(--ww-text-muted)",
    },
    {
      symbol: "🧩",
      name: t("拆单累计"),
      sub: t("多笔小额累积净买入"),
      tone: "var(--ww-warn)",
    },
    {
      symbol: "🏆",
      name: t("聪明钱"),
      sub: t("白名单钱包在场"),
      tone: "var(--ww-link)",
    },
    {
      symbol: "🔥",
      name: t("聪明钱共识"),
      sub: t("≥2 个白名单同向"),
      tone: "var(--ww-up)",
    },
  ];

  return (
    <main className="ds-main">
      <header className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="page-head__eyebrow">
            <span aria-hidden>📖</span>
            {t("名词级定义 · 板块级见「功能说明书」")}
          </div>
          <h1 className="page-head__title">{t("说明 · 图标与名词")}</h1>
          <p className="page-head__desc">
            {t(
              "{i} 个图标 · {w} 个钱包标签 · {n} 个名词。信号强度五级阶梯在最前，其余按出现顺序排列。",
              { i: ICONS.length, w: WALLET_TAGS.length, n: TERMS.length },
            )}
          </p>
        </div>
        <div className="page-head__actions">
          <span className="ds-btn" style={{ cursor: "default" }}>
            {t("共 {n} 条", { n: total })}
          </span>
        </div>
      </header>

      {/* 跳转条 —— 一排描边钮，不是筛选(没有选中态，点了就是滚到该组) */}
      <div className="filter-bar">
        <span className="filter-row__label">{t("跳到")}</span>
        <a className="ds-btn" href="#ladder">
          {t("信号阶梯")}
        </a>
        <a className="ds-btn" href="#icons">
          {t("图标")} {ICONS.length}
        </a>
        <a className="ds-btn" href="#wallet-tags">
          {t("钱包标签")} {WALLET_TAGS.length}
        </a>
        <a className="ds-btn" href="#terms">
          {t("名词")} {TERMS.length}
        </a>
      </div>

      {/* 信号强度五级阶梯 */}
      <section
        id="ladder"
        className="ds-card"
        style={{
          overflow: "hidden",
          marginBottom: "var(--s-5)",
          scrollMarginTop: 72,
        }}
      >
        <div className="card-bar">
          <span style={{ fontWeight: 600 }}>{t("信号强度五级阶梯")}</span>
          <span className="muted">
            {t("· 从「值得看一眼」到「值得停下来」")}
          </span>
        </div>
        {/* 分格阶梯(设计稿 17):卡内 16px 留白 + 五等分，格间 1px 竖线内缩到
            留白里(不贴卡边)。1px gap + 容器底色为边框色 —— 窄屏换行时横线
            自动补齐，不用靠 :first-child 猜哪一格在行首。 */}
        <div style={{ padding: "var(--s-4)" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 1,
              background: "var(--ww-border)",
            }}
          >
            {ladder.map((l) => (
              <div
                key={l.symbol}
                style={{
                  background: "var(--ww-surface)",
                  // 设计稿是 0 14px；底部留 6px 只为窄屏换行时下一行的色条
                  // 不贴着上一行的副行 —— 桌面单行时看不出差别。
                  padding: "0 14px 6px",
                  minWidth: 0,
                }}
              >
                <div style={{ height: 4, background: l.tone }} />
                <div
                  aria-hidden
                  style={{ marginTop: 10, fontSize: 20, lineHeight: 1 }}
                >
                  {l.symbol}
                </div>
                <div style={{ marginTop: 6, fontSize: "var(--t-md)" }}>
                  {l.name}
                </div>
                <div
                  className="muted"
                  style={{
                    marginTop: 2,
                    fontSize: "var(--t-sm)",
                    lineHeight: "var(--lh-snug)",
                    overflowWrap: "anywhere",
                  }}
                >
                  {l.sub}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="note-strip">
          {t(
            "阶梯只表示「本站认为该多看一眼」的程度，不表示胜率高低 —— 后者去信号战绩页。",
          )}
        </div>
      </section>

      {/* 图标 */}
      <section
        id="icons"
        style={{ marginBottom: "var(--s-5)", scrollMarginTop: 72 }}
      >
        <div className="ds-table-wrap">
          <div className="card-bar">
            <span style={{ fontWeight: 600 }}>{t("图标")}</span>
            <span className="muted">
              {t("· {n} 个 · 按成交 / 结算 / 交互排列", { n: ICONS.length })}
            </span>
          </div>
          <table className="ds-table">
            <thead>
              <tr>
                <th style={{ width: 56 }}>{t("符号")}</th>
                <th style={{ width: 160 }}>{t("名称")}</th>
                <th>{t("含义")}</th>
              </tr>
            </thead>
            <tbody>
              {ICONS.map((e) => (
                <tr key={e.symbol}>
                  <td data-label={t("符号")}>
                    <IconSymbol symbol={e.symbol} />
                  </td>
                  <td data-label={t("名称")} style={{ whiteSpace: "nowrap" }}>
                    {t(e.name)}
                  </td>
                  {/* 含义列在设计稿里是 muted 说明文字，不与名称同色抢重量。
                      色值走内联:.muted(0,1,0) 压不过 .ds-table td(0,1,1)。 */}
                  <td
                    data-label={t("含义")}
                    className="cell-wrap"
                    style={{
                      lineHeight: "var(--lh-note)",
                      color: "var(--ww-text-muted)",
                    }}
                  >
                    {t(e.detail)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 钱包标签 —— 按 kind 分三组，每组一张卡；标签用灰底名称标签，
          定义跟在标签下方(不因分组丢掉 detail) */}
      <section
        id="wallet-tags"
        style={{ marginBottom: "var(--s-5)", scrollMarginTop: 72 }}
      >
        <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
          {t("钱包标签（聪明钱发现 / 钱包档案页）")}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: "var(--s-4)",
          }}
        >
          {TAG_KINDS.map((kind) => {
            const rows = WALLET_TAGS.filter((w) => w.kind === kind);
            return (
              <div
                key={kind}
                className="ds-card"
                style={{ overflow: "hidden" }}
              >
                <div className="card-bar">
                  <span style={{ fontWeight: 600 }}>{t(kind)}</span>
                  <span className="muted">
                    {t("· {n} 个", { n: rows.length })}
                  </span>
                </div>
                {rows.map((w, i) => (
                  <div
                    key={w.keyPrefix}
                    style={{
                      padding: "var(--s-3) var(--s-4)",
                      borderTop: i ? "1px solid var(--ww-border)" : undefined,
                    }}
                  >
                    <span className="ds-tag">
                      <span aria-hidden>{w.icon}</span>
                      {t(w.name)}
                    </span>
                    <div
                      className="muted"
                      style={{
                        marginTop: 6,
                        fontSize: "var(--t-base)",
                        lineHeight: "var(--lh-note)",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {t(w.detail)}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </section>

      {/* 名词 —— 双栏定义列表 */}
      <section id="terms" style={{ scrollMarginTop: 72 }}>
        <div className="ds-card" style={{ overflow: "hidden" }}>
          <div className="card-bar">
            <span style={{ fontWeight: 600 }}>{t("核心名词")}</span>
            <span className="muted">{t("· {n} 个", { n: TERMS.length })}</span>
          </div>
          {/* 双栏：多列排版天然吃得下奇数条(37)，不会像 grid 那样在末尾
              留一格空轨；末行的下边线与说明条上边线用 -1px 合并成一条 */}
          <div
            style={{
              columns: "320px 2",
              columnGap: "1px",
              columnRule: "1px solid var(--ww-border)",
              marginBottom: -1,
            }}
          >
            {TERMS.map((e) => (
              <div
                key={e.term}
                style={{
                  breakInside: "avoid",
                  padding: "var(--s-3) var(--s-4)",
                  borderBottom: "1px solid var(--ww-border)",
                }}
              >
                <strong
                  style={{
                    fontWeight: 600,
                    fontSize: "var(--t-md)",
                    overflowWrap: "anywhere",
                  }}
                >
                  {t(e.term)}
                </strong>
                <div
                  className="muted"
                  style={{
                    marginTop: 2,
                    fontSize: "var(--t-base)",
                    lineHeight: "var(--lh-note)",
                    overflowWrap: "anywhere",
                  }}
                >
                  {t(e.detail)}
                </div>
              </div>
            ))}
          </div>
          <div className="note-strip">
            {t(
              "全站所有符号和术语的定义 — 鼠标悬停在任意页面的图标上也能看到同样的解释",
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
