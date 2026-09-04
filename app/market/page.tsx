"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { StatCard } from "../ui";
import { useLang } from "../i18n";

// Landing for the single-market signal card: paste anything that identifies a
// market (Polymarket URL / market slug / conditionId) and jump. An event URL
// with several markets comes back as candidates to pick from.
//
// 版式出自设计稿 11「市场卡 · 粘贴落地页」:页头 → 48px 主搜索框(最宽 720)
// → 一张双栏白卡(左「支持三种格式」三行,右「卡里会告诉你」五格)。
// 搜索框内的放大镜是 lucide line icon(§6:功能图标走 lucide,不用 emoji),
// 以 background-image 画进输入框内侧 —— 这样输入框仍是唯一那个元素,
// .ds-input:focus 的焦点环照旧覆盖整个框,不会被外层包裹层裁掉。
const SEARCH_ICON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236c757d' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.3-4.3'/%3E%3C/svg%3E\")";

// 落地页那张卡的左栏:一行「名称 + 例子」。例子用 muted，名称用正文色。
// last 那一行不画下边线 —— 左栏比右栏矮,再画一条就是一根悬在卡中间的横线
// (设计稿 11 的左栏第三行没有下边框)。
function FormatRow({
  name,
  sample,
  last,
}: {
  name: string;
  sample: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        padding: "var(--s-3) var(--s-4)",
        borderBottom: last ? undefined : "1px solid var(--ww-border)",
        fontSize: "var(--t-md)",
        color: "var(--ww-text)",
        overflowWrap: "anywhere",
      }}
    >
      {name} <span className="muted">{sample}</span>
    </div>
  );
}

export default function MarketLanding() {
  const router = useRouter();
  const { t } = useLang();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<
    { conditionId: string; question: string }[] | null
  >(null);

  const go = async () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    setError(null);
    setCandidates(null);
    try {
      const res = await fetch(
        `/api/market/resolve?input=${encodeURIComponent(input.trim())}`,
      );
      const j = (await res.json()) as {
        conditionId?: string;
        candidates?: { conditionId: string; question: string }[];
        error?: string;
      };
      if (j.conditionId) router.push(`/market/${j.conditionId}`);
      else if (j.candidates) setCandidates(j.candidates);
      else setError(j.error ?? "解析失败");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="ds-main">
      <header className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="page-head__eyebrow">{t("🃏 单市场信号卡")}</div>
          <h1 className="page-head__title">{t("市场卡")}</h1>
          <p className="page-head__desc">
            {t(
              "粘贴任何能指认一个市场的东西，10 秒看清聪明钱在这个市场里做了什么。",
            )}
          </p>
        </div>
      </header>

      {/* 主搜索框 —— 一个 48px 高、最宽 720 的框(§4 控件高度:市场卡搜索 48),
          「查看」这颗蓝钮嵌在框内右侧、四边各让 4px、圆角 6(设计系统
          SearchField size=lg 的确切值)。做法是让 input 自己承担外框与圆角、
          按钮绝对定位压在它上面 —— 这样 .ds-input:focus 的蓝边与焦点环仍然
          框住整只框,而不是缩成框里的一个小框。「查看」是本屏唯一的主按钮。 */}
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          maxWidth: 720,
          marginBottom: "var(--s-6)",
        }}
      >
        <input
          className="ds-input"
          style={{
            width: "100%",
            minWidth: 0,
            height: 48,
            paddingLeft: 38,
            paddingRight: 124,
            backgroundImage: SEARCH_ICON,
            backgroundRepeat: "no-repeat",
            backgroundPosition: "14px center",
            backgroundSize: "16px 16px",
          }}
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void go();
          }}
          placeholder={t(
            "https://polymarket.com/event/… 或 market slug 或 0x…",
          )}
          aria-label={t("市场链接或 slug")}
        />
        <button
          className="ds-btn ds-btn--primary"
          style={{
            position: "absolute",
            right: 4,
            top: 4,
            bottom: 4,
            height: "auto",
            padding: "0 20px",
            borderRadius: "var(--r-sm)",
            fontSize: 15,
          }}
          onClick={() => void go()}
          disabled={busy}
        >
          {busy ? t("解析中…") : t("查看")}
        </button>
      </div>

      {error && (
        <div
          className="ds-callout ds-callout--error"
          style={{ maxWidth: 720, marginBottom: "var(--s-6)" }}
        >
          {t(error)}
        </div>
      )}

      {candidates && (
        <section style={{ marginBottom: "var(--s-6)" }}>
          <div className="ds-card" style={{ overflow: "hidden" }}>
            <div className="card-bar">
              <span style={{ fontWeight: 600 }}>
                {t("该事件包含 {n} 个市场，选择一个：", {
                  n: candidates.length,
                })}
              </span>
            </div>
            {/* 包裹层的框/圆角/阴影由外层卡承担,内层只负责横向滚动 */}
            <div
              className="ds-table-wrap"
              style={{ border: 0, borderRadius: 0, boxShadow: "none" }}
            >
              <table className="ds-table">
                <tbody>
                  {candidates.map((c) => (
                    <tr
                      key={c.conditionId}
                      style={{ cursor: "pointer" }}
                      onClick={() => router.push(`/market/${c.conditionId}`)}
                    >
                      {/* 市场名永不截断（§1.1）—— 换行，顶对齐 */}
                      <td className="cell-wrap">
                        {c.question || c.conditionId}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* 双栏说明卡:左「输入什么」右「输出什么」。flex + 基准宽让桌面保持
          设计稿的 1 : 1.4,窄屏自动堆成两段(内联 grid 无法随视口塌陷)。 */}
      <div
        className="ds-card"
        style={{ overflow: "hidden", display: "flex", flexWrap: "wrap" }}
      >
        <div
          style={{
            flex: "1 1 280px",
            minWidth: 0,
            borderRight: "1px solid var(--ww-border)",
          }}
        >
          <div className="card-bar">
            <span style={{ fontWeight: 600 }}>{t("支持三种格式")}</span>
          </div>
          <FormatRow name={t("事件链接")} sample="polymarket.com/event/…" />
          <FormatRow name="market slug" sample="will-morocco-win-…" />
          <FormatRow name="conditionId" sample="0x…" last />
        </div>
        <div style={{ flex: "1.4 1 392px", minWidth: 0 }}>
          <div className="card-bar">
            <span style={{ fontWeight: 600 }}>{t("卡里会告诉你")}</span>
          </div>
          {/* KPI 分格:gap 1px + 容器底色=边框色，格线自动补齐 */}
          <section
            className="kpi"
            style={{
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
              border: 0,
              borderRadius: 0,
              boxShadow: "none",
            }}
          >
            <StatCard icon="🔥" label={t("共识 / 分歧状态")}>
              <div className="kpi-value">{t("白名单站哪一侧")}</div>
            </StatCard>
            <StatCard icon="🧩" label={t("拆单累计")}>
              <div className="kpi-value">{t("谁在蚂蚁搬家")}</div>
            </StatCard>
            <StatCard icon="🏆" label={t("留存敞口")}>
              <div className="kpi-value">{t("净股数 × 买入均价")}</div>
            </StatCard>
            <StatCard icon="🆕" label={t("新钱包异常流")}>
              <div className="kpi-value">{t("账龄 ≤7 天的重注")}</div>
            </StatCard>
            <div style={{ gridColumn: "1 / -1" }}>
              <StatCard icon="📐" label={t("本工具告警战绩")}>
                <div className="kpi-value">{t("90 天内 · 含验证结果")}</div>
              </StatCard>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
