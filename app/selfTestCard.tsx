"use client";

// 聪明钱自测判决卡 —— /selftest 落地页与钱包档案页共享的唯一渲染件
// (设计文档 2026-08-28-smart-money-selftest-design.md)。判决词、分位、
// 口径声明只存在这一份,两个入口永不漂移。
//
// 版式(Etherscan 风设计稿 08 帧「判决卡」):
//   卡一 判决徽章条(徽章上色 + 句子中性)→ 三格 KPI(格间 1px 竖线)→ 灰底口径条
//   卡二 准入口径两条路(每条右侧一个状态徽章)→ 琥珀口径条
//   末行 三个 32px 描边操作钮
// 轻重只靠徽章颜色:没有行级强调、没有字号跳档、数字与正文同字体常规字重。
import { useState } from "react";
import type { ReactNode } from "react";
import { useLang } from "./i18n";
import { StatCard, Tag } from "./ui";
import type { SelfTestResponse } from "../lib/selfTest";
import type { AxisPercentile } from "../lib/selfTest";

type T = (zh: string, p?: Record<string, string | number>) => string;
type Tone = "default" | "up" | "down" | "warn";

/**
 * 金额按设计系统 §1 的数字格式写满千分位(`+$4,712,880`),不用 K / M 缩写:
 * 同一份判决的嵌入卡(lib/embedCards)本来就是这个写法,判决卡跟着它,
 * 两个出口的同一个数不会长得不一样。数字与正文同字体、常规字重。
 */
function fmtUsdSigned(n: number): string {
  const sign = n < 0 ? "-" : "+";
  return `${sign}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
}

function fmtTs(sec: number, locale: string): string {
  return new Date(sec * 1000).toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 判决词:徽章(短、上色)与句子(长、中性)分家 —— 徽章五类语义固定,
 * 绿=过闸 / 红=未过闸 / 琥珀=机器人与判不了的三种成因。
 * 「没过」与「判不了」在字面上依旧严格分家。
 */
function headline(
  d: SelfTestResponse,
  t: T,
): { tag: string; tone: Tone; text: string } {
  switch (d.verdict) {
    case "pass":
      return {
        tag: t("✅ 过闸"),
        tone: "up",
        text: t("按本站准入口径，这份战绩过了聪明钱池的门槛。"),
      };
    case "fail":
      return {
        tag: t("❌ 未过闸"),
        tone: "down",
        text: t("样本足够、判得出，但两条路都没到线。"),
      };
    case "bot":
      return {
        tag: t("🤖 不适用"),
        tone: "warn",
        text: t("高频做市 / 机器人画像，胜率口径对它无意义。"),
      };
    case "unjudged":
      if (d.unjudgedReason === "truncated") {
        return {
          tag: t("⚖️ 样本不可判"),
          tone: "warn",
          text: t(
            "已结算市场过多，只能取到按盈亏排序的最赚一部分（赢家偏差），胜率 / ROI 无法可靠统计。",
          ),
        };
      }
      if (d.unjudgedReason === "small_sample") {
        return {
          tag: t("⚖️ 样本不足"),
          tone: "warn",
          text: t("已结算市场少于 {n} 个，两条路的最低样本线都没到。", {
            n: d.criteria.minSettledRoi,
          }),
        };
      }
      return {
        tag: t("⚖️ 暂不可判"),
        tone: "warn",
        text: t("净盈亏暂不可得，按闸门纪律拒绝凭部分数据下判。"),
      };
    default:
      return {
        tag: t("⚠️ 暂无数据"),
        tone: "warn",
        text: t("上游接口暂时取不到这份战绩——稍后再试"),
      };
  }
}

/**
 * 两条准入路各自的达成状态 —— 只**解释**权威闸门已给出的结论,不另判:
 * pass 时点出走的是哪条路(闸门既已 admit,两条路必有其一成立),
 * fail 时闸门保证两条都没到线;其余判决(判不了 / 机器人 / 无数据)不标。
 * 万一与闸门对不上(理论上不会),宁可一个徽章都不出,也不与判决词打架。
 */
function admittedPaths(d: SelfTestResponse): [boolean, boolean] | null {
  const s = d.stats;
  if (!s) return null;
  if (d.verdict === "fail") return [false, false];
  if (d.verdict !== "pass") return null;
  const c = d.criteria;
  const pnlPositive = s.netPnl != null && s.netPnl > 0;
  const p1 =
    pnlPositive &&
    s.winRate != null &&
    s.settledCount >= c.minSettled &&
    s.winRate >= c.minWinRate;
  const p2 =
    pnlPositive &&
    s.roi != null &&
    s.roi >= c.minRoi &&
    s.settledCount >= c.minSettledRoi;
  return p1 || p2 ? [p1, p2] : null;
}

/** midrank 分位(超过多少人)→ 「池内前 X%」。0.x% 保守收成 1%。 */
function topPct(pct: number): number {
  return Math.max(1, Math.round(100 - pct));
}

const DASH = <span className="faint">—</span>;

/** KPI 一格:20px emoji 图标位 + 12px 大写小标 + 18px 常规字重值 + 分位副行。 */
function AxisCell({
  icon,
  label,
  value,
  tone,
  pctile,
  t,
}: {
  icon: string;
  label: string;
  value: ReactNode;
  tone?: string;
  pctile: AxisPercentile | null;
  t: T;
}) {
  return (
    <StatCard label={label} icon={icon}>
      <div className="kpi-value" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      <div
        className="kpi-sub"
        // 原始口径(超过多少人 · 该轴样本数)留在 title 里,不丢。
        title={
          pctile
            ? t("超过池内约 {p}% 成员 · 样本 {n}", {
                p: Math.round(pctile.pct),
                n: pctile.sampleN,
              })
            : undefined
        }
      >
        {pctile
          ? t("池内前 {p}% · 样本 {n}", {
              p: topPct(pctile.pct),
              n: pctile.sampleN,
            })
          : DASH}
      </div>
    </StatCard>
  );
}

/** 准入口径的一条路:门槛说明永不截断(换行,顶对齐),右侧一列状态徽章。 */
function PathRow({
  text,
  met,
  last,
  t,
}: {
  text: string;
  met: boolean | null;
  last?: boolean;
  t: T;
}) {
  return (
    <div
      style={{
        display: "grid",
        // 徽章列 auto:两行的徽章按同一宽度对齐(设计稿 140px 的作用),
        // 窄屏又不会硬占走说明文字的宽度。
        gridTemplateColumns: "minmax(0,1fr) auto",
        gap: "var(--s-3)",
        alignItems: "start",
        padding: "var(--s-3) var(--s-4)",
        borderBottom: last ? undefined : "1px solid var(--ww-border)",
        fontSize: "var(--t-md)",
      }}
    >
      <span style={{ lineHeight: 1.35, overflowWrap: "anywhere" }}>{text}</span>
      <span style={{ display: "flex", justifyContent: "flex-end" }}>
        {met == null ? null : met ? (
          <Tag variant="up">{t("✅ 走这条过的")}</Tag>
        ) : (
          <Tag>{t("未走这条")}</Tag>
        )}
      </span>
    </div>
  );
}

export function SelfTestVerdictCard({ data }: { data: SelfTestResponse }) {
  const { lang, t } = useLang();
  const locale = lang === "en" ? "en-US" : "zh-CN";
  const [copied, setCopied] = useState(false);
  const head = headline(data, t);
  const s = data.stats;
  const showAxes = data.verdict !== "no_data";
  const paths = admittedPaths(data);

  const embedUrl = `/embed/selftest?address=${data.address}`;
  const copyEmbed = () => {
    const origin = window.location.origin;
    void navigator.clipboard
      .writeText(
        `<iframe src="${origin}${embedUrl}" width="440" height="300" frameborder="0" title="WhaleWatch self-test"></iframe>`,
      )
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
  };

  // 卡底灰条:分位样本口径先说,再说数据新鲜度(统计声明不当脚注)。
  // 「按本站口径挑选,非全体交易者」写在卡内而不是只写在 /selftest 的口径条里
  // —— 这张卡也长在钱包档案页(SelfTestBlock)上,那里没有口径条,它得自己说清。
  const meta = [
    t("分位样本 = 当前池 {n} 名成员（按本站口径挑选，非全体交易者）", {
      n: data.poolSize,
    }),
    s ? t("已结算 {n} 仓", { n: s.settledCount }) : "",
    t("判决计算于 {at}", { at: fmtTs(data.computedAt, locale) }),
    data.statsFetchedAt != null
      ? t("战绩数据截至 {at}", { at: fmtTs(data.statsFetchedAt, locale) })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

  // 「—」是判不了不是零 —— 页面上真出现了才解释,成因写在琥珀条里。
  const hasDash =
    showAxes &&
    (s?.winRate == null ||
      s?.netPnl == null ||
      data.score == null ||
      !data.percentiles.winRate ||
      !data.percentiles.netPnl ||
      !data.percentiles.score);

  return (
    <div style={{ display: "grid", gap: "var(--s-5)" }}>
      {/* 卡一 · 判决 */}
      <div className="ds-card" style={{ overflow: "hidden" }}>
        <div className="card-bar">
          <Tag variant={head.tone}>{head.tag}</Tag>
          <span style={{ flex: "1 1 260px", minWidth: 0, lineHeight: 1.35 }}>
            {head.text}
          </span>
          {data.inPool ? (
            <span title={t("🏆 该地址已在本站聪明钱池内（分位含自身）")}>
              <Tag>{t("🏆 已在池内")}</Tag>
            </span>
          ) : null}
        </div>

        {showAxes ? (
          // 卡内 KPI 分格:外框交给卡片,这里只留格间 1px 竖线。
          <section
            className="kpi"
            style={{ border: 0, borderRadius: 0, boxShadow: "none" }}
          >
            <AxisCell
              icon="📐"
              label={t("已结算胜率")}
              value={
                s?.winRate != null ? `${Math.round(s.winRate * 100)}%` : DASH
              }
              pctile={data.percentiles.winRate}
              t={t}
            />
            <AxisCell
              icon="💰"
              label={t("净盈亏")}
              value={s?.netPnl != null ? fmtUsdSigned(s.netPnl) : DASH}
              tone={
                s?.netPnl != null
                  ? s.netPnl >= 0
                    ? "var(--ww-up)"
                    : "var(--ww-down)"
                  : undefined
              }
              pctile={data.percentiles.netPnl}
              t={t}
            />
            <AxisCell
              icon="🏆"
              label={t("评分")}
              value={data.score != null ? String(data.score) : DASH}
              pctile={data.percentiles.score}
              t={t}
            />
          </section>
        ) : null}

        <div className="note-strip">{meta}</div>
      </div>

      {/* 卡二 · 准入口径(数字来自 admissionGate 常量,展示层不硬编码阈值) */}
      <div className="ds-card" style={{ overflow: "hidden" }}>
        <div className="card-bar" style={{ gap: 6, fontWeight: 600 }}>
          {t("准入口径")}
          <span className="muted" style={{ fontWeight: 400 }}>
            {t("· 两条路满足其一")}
          </span>
        </div>
        <PathRow
          text={t("① 已结算 ≥{n} 市场 · 胜率 ≥{p}% · 净盈亏为正", {
            n: data.criteria.minSettled,
            p: Math.round(data.criteria.minWinRate * 100),
          })}
          met={paths ? paths[0] : null}
          t={t}
        />
        <PathRow
          text={t("② 已结算 ≥{n} 市场 · ROI ≥{p}% · 净盈亏为正", {
            n: data.criteria.minSettledRoi,
            p: Math.round(data.criteria.minRoi * 100),
          })}
          met={paths ? paths[1] : null}
          last
          t={t}
        />
        <div className="note-strip note-strip--warn">
          {"⚠️ "}
          {t(
            "池准入另有「30 天 ≥3 个不同市场」的复发证据要求——那是发现渠道的候选资格，不在自测范围；自测通过 ≠ 自动入池。",
          )}
          {hasDash ? (
            <>
              {" "}
              {t(
                "卡内 — 是「判不了」不是零：做市商或截断样本下胜率 / ROI 被判为不可用，池内该轴没有可比成员时分位同样不出数。",
              )}
            </>
          ) : null}
        </div>
      </div>

      {/* 末行操作 —— 主按钮留给页面顶部的「领取判决书」,这里一律描边白底 */}
      <div
        style={{
          display: "flex",
          gap: "var(--s-2)",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <a className="ds-btn" href={`/wallet/${data.address}`}>
          {t("查看完整档案 →")}
        </a>
        <button className="ds-btn" onClick={copyEmbed}>
          {copied ? t("已复制") : t("复制嵌入卡代码")}
        </button>
        <a className="ds-btn" href={embedUrl} target="_blank" rel="noreferrer">
          {t("预览嵌入卡 ↗")}
        </a>
      </div>
    </div>
  );
}
