"use client";

import { useState } from "react";
import { ICONS, TERMS, WALLET_TAGS, type WalletTagEntry } from "../glossary";
import { useLang } from "../i18n";
import { Tag } from "../ui";

// Static reference page — every symbol and term the dashboard uses, from the
// same data source that powers the hover tooltips (app/glossary.ts).
//
// 双语化:词表数据(app/glossary.ts)是中文唯一源,页面只在渲染处过
// t(中文串) —— 键即中文原文,译文全部在 lib/i18n/dict/glossary.ts。
// 所以 name/tip/detail 与各页悬停提示走同一批键,永不漂移;缺译回退中文。
//
// 版式(设计稿 17「说明 · 图标与名词」):页头 + 260px 搜索框 → 四分类筛选条
// → 五级阶梯卡 → 图标表 → 钱包标签三组卡 → 名词双栏定义列表。徽章五类语义
// 固定:✅ 绿=命中 · ❌ 红=反向 · 灰底=名称标签(不表示状态)。
//
// 页面自身不写方法论:61 条词条本身就是解释,再给页面加一层「我们为什么这么
// 分组」只会把它读得更慢。留下的唯一一条告诫是阶梯那句「不是胜率」——
// 不读它会把强度阶梯当成胜率排名。

// 三类 kind 的展示顺序 —— 人工排的,因为展示顺序是设计决定,不该由数据里
// 谁先出现决定。
const TAG_KINDS = ["状态", "来源", "渠道证据"] as const;

// 编译期穷尽闸:kind 若加第四类,下面这行立刻类型报错(「不满足约束 never」),
// 而不是让新标签在三张卡里静默消失、筛选钮却仍宣称总数。
// 纯类型,无运行时代价。
type AssertNever<T extends never> = T;
type _TagKindsAreExhaustive = AssertNever<
  Exclude<WalletTagEntry["kind"], (typeof TAG_KINDS)[number]>
>;

// 四分类筛选(设计稿 17 的头部四钮)。
type Facet = "all" | "icons" | "tags" | "terms";

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
  const [query, setQuery] = useState("");
  const [facet, setFacet] = useState<Facet>("all");

  // 匹配口径:原文 + 译文都进候选,所以中文界面搜英文词(如 "Wilson")与英文
  // 界面搜中文词都能命中,不用先切语言。符号本身(💰 / ✅)也可搜。
  // 61 条数据全在内存里,每次渲染重算即可 —— 不值得上 useMemo。
  const q = query.trim().toLowerCase();
  const hit = (...parts: string[]) =>
    q === "" || parts.some((p) => p.toLowerCase().includes(q));

  const icons = ICONS.filter((e) =>
    hit(e.symbol, e.name, e.detail, t(e.name), t(e.detail)),
  );
  const tags = WALLET_TAGS.filter((e) =>
    hit(e.icon, e.name, e.detail, e.kind, t(e.name), t(e.detail), t(e.kind)),
  );
  const terms = TERMS.filter((e) =>
    hit(e.term, e.detail, t(e.term), t(e.detail)),
  );

  const show = (f: Exclude<Facet, "all">) => facet === "all" || facet === f;
  // 阶梯是导读不是词条:搜索时让位给命中结果,筛到标签/名词时也不占地方。
  const showLadder = q === "" && (facet === "all" || facet === "icons");
  const shown =
    (show("icons") ? icons.length : 0) +
    (show("tags") ? tags.length : 0) +
    (show("terms") ? terms.length : 0);

  // 计数随搜索走 —— 筛选钮同时是「这个词在哪一类里」的分面计数,
  // 搜完还显示 61 会骗人。
  const facets: { id: Facet; label: string; n: number }[] = [
    {
      id: "all",
      label: t("全部"),
      n: icons.length + tags.length + terms.length,
    },
    { id: "icons", label: t("图标"), n: icons.length },
    { id: "tags", label: t("钱包标签"), n: tags.length },
    { id: "terms", label: t("名词"), n: terms.length },
  ];

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
            {t("全站图标、钱包标签与名词的唯一定义表，与各页悬停提示同源。")}
          </p>
        </div>
        {/* 设计稿 17:页头右侧 260px 搜索框(取代原先的静态计数钮 —— 计数
            移进筛选钮，那里它同时是分面计数)。 */}
        <div className="page-head__actions">
          <input
            className="ds-input"
            style={{ width: 260, maxWidth: "100%" }}
            placeholder={t("搜索图标 / 标签 / 名词")}
            aria-label={t("搜索")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </header>

      {/* 四分类筛选 —— 当前项蓝描边。不是锚点跳转:61 条按需显示比一次全铺
          更快找到东西。 */}
      <div className="filter-bar">
        {facets.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`ds-btn${facet === f.id ? " ds-btn--active" : ""}`}
            aria-pressed={facet === f.id}
            onClick={() => setFacet(f.id)}
          >
            {f.label} {f.n}
          </button>
        ))}
      </div>

      {/* 信号强度五级阶梯 */}
      {showLadder && (
        <section
          id="ladder"
          className="ds-card"
          style={{
            overflow: "hidden",
            marginBottom: "var(--s-5)",
            scrollMarginTop: 72,
          }}
        >
          {/* 唯一保留的告诫写在卡头(数据前面,不做脚注)—— 不读它会把强度
              阶梯当成胜率排名。 */}
          <div className="card-bar">
            <span style={{ fontWeight: 600 }}>{t("信号强度五级阶梯")}</span>
            <span className="muted">
              {t("· 只表示该多看一眼的程度，不是胜率（胜率见信号战绩页）")}
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
        </section>
      )}

      {/* 空态 —— 绝不返回 null:给读数(搜的是什么)也给出路(一键清除)。 */}
      {shown === 0 && (
        <div className="ds-empty">
          {t("没有匹配「{q}」的条目", { q: query.trim() })}
          <div style={{ marginTop: "var(--s-3)" }}>
            <button
              type="button"
              className="ds-btn ds-btn--sm"
              onClick={() => {
                setQuery("");
                setFacet("all");
              }}
            >
              {t("清除")}
            </button>
          </div>
        </div>
      )}

      {/* 图标 */}
      {show("icons") && icons.length > 0 && (
        <section
          id="icons"
          style={{ marginBottom: "var(--s-5)", scrollMarginTop: 72 }}
        >
          <div className="ds-table-wrap">
            <div className="card-bar">
              <span style={{ fontWeight: 600 }}>{t("图标")}</span>
              <span className="muted">
                {t("· {n} 个", { n: icons.length })}
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
                {icons.map((e) => (
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
      )}

      {/* 钱包标签 —— 按 kind 分三组，每组一张卡；标签用灰底名称标签，
          定义跟在标签下方(不因分组丢掉 detail) */}
      {show("tags") && tags.length > 0 && (
        <section
          id="wallet-tags"
          style={{ marginBottom: "var(--s-5)", scrollMarginTop: 72 }}
        >
          <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
            {t("钱包标签")}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
              gap: "var(--s-4)",
            }}
          >
            {TAG_KINDS.map((kind) => {
              const rows = tags.filter((w) => w.kind === kind);
              if (rows.length === 0) return null;
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
      )}

      {/* 名词 —— 双栏定义列表 */}
      {show("terms") && terms.length > 0 && (
        <section id="terms" style={{ scrollMarginTop: 72 }}>
          <div className="ds-card" style={{ overflow: "hidden" }}>
            <div className="card-bar">
              <span style={{ fontWeight: 600 }}>{t("核心名词")}</span>
              <span className="muted">
                {t("· {n} 个", { n: terms.length })}
              </span>
            </div>
            {/* 双栏：多列排版天然吃得下奇数条(37)，不会像 grid 那样在末尾
                留一格空轨；末行的下边线与卡片下沿用 -1px 合并成一条 */}
            <div
              style={{
                columns: "320px 2",
                columnGap: "1px",
                columnRule: "1px solid var(--ww-border)",
                marginBottom: -1,
              }}
            >
              {terms.map((e) => (
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
          </div>
        </section>
      )}
    </main>
  );
}
