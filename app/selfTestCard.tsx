"use client";

// 聪明钱自测判决卡 —— /selftest 落地页与钱包档案页共享的唯一渲染件
// (设计文档 2026-08-28-smart-money-selftest-design.md)。判决词、分位条、
// 口径声明只存在这一份,两个入口永不漂移。
import { useState } from "react";
import { useLang } from "./i18n";
import { usdCompact } from "../lib/xComposer";
import type { SelfTestResponse } from "../lib/selfTest";
import type { AxisPercentile } from "../lib/selfTest";

function fmtTs(sec: number, locale: string): string {
  return new Date(sec * 1000).toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 判决词行:「没过」与「判不了」在字面上严格分家。 */
function headline(
  d: SelfTestResponse,
  t: (zh: string, p?: Record<string, string | number>) => string,
): { text: string; color: string } {
  switch (d.verdict) {
    case "pass":
      return {
        text: t("✅ 过闸——按本站准入口径，这份战绩过了聪明钱池的门槛"),
        color: "var(--up-700)",
      };
    case "fail":
      return {
        text: t("❌ 未过闸——样本足够、判得出，但两条路都没到线"),
        color: "var(--down-700)",
      };
    case "bot":
      return {
        text: t("🤖 不适用——高频做市/机器人画像，胜率口径对它无意义"),
        color: "var(--n-600)",
      };
    case "unjudged":
      return {
        text:
          d.unjudgedReason === "truncated"
            ? t(
                "⚖️ 样本不可判——已结算市场过多，只能取到按盈亏排序的最赚一部分（赢家偏差），胜率/ROI 无法可靠统计",
              )
            : d.unjudgedReason === "small_sample"
              ? t(
                  "⚖️ 样本不足——已结算市场少于 {n} 个，两条路的最低样本线都没到",
                  {
                    n: d.criteria.minSettledRoi,
                  },
                )
              : t("⚖️ 暂不可判——净盈亏暂不可得，按闸门纪律拒绝凭部分数据下判"),
        color: "var(--n-600)",
      };
    default:
      return {
        text: t("上游接口暂时取不到这份战绩——稍后再试"),
        color: "var(--n-600)",
      };
  }
}

function AxisRow({
  label,
  value,
  pctile,
  t,
}: {
  label: string;
  value: string;
  pctile: AxisPercentile | null;
  t: (zh: string, p?: Record<string, string | number>) => string;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(90px, 130px) 70px 1fr",
        gap: "var(--s-3)",
        alignItems: "center",
      }}
    >
      <span className="muted" style={{ fontSize: "var(--t-sm)" }}>
        {label}
      </span>
      <span className="mono num" style={{ textAlign: "right" }}>
        {value}
      </span>
      {pctile ? (
        <div>
          <div
            aria-hidden
            style={{
              height: 6,
              borderRadius: 3,
              background: "var(--n-150)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.max(2, Math.min(100, pctile.pct))}%`,
                height: "100%",
                background: "var(--brand-500)",
              }}
            />
          </div>
          <div className="kpi-sub" style={{ marginTop: 2 }}>
            {t("超过池内约 {p}% 成员 · 样本 {n}", {
              p: Math.round(pctile.pct),
              n: pctile.sampleN,
            })}
          </div>
        </div>
      ) : (
        <span className="muted mono">—</span>
      )}
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

  return (
    <div
      className="ds-card"
      style={{ padding: "var(--s-4)", display: "grid", gap: "var(--s-3)" }}
    >
      <div style={{ fontWeight: 600, color: head.color }}>{head.text}</div>

      {showAxes ? (
        <div style={{ display: "grid", gap: "var(--s-2)" }}>
          <AxisRow
            label={t("已结算胜率")}
            value={s?.winRate != null ? `${Math.round(s.winRate * 100)}%` : "—"}
            pctile={data.percentiles.winRate}
            t={t}
          />
          <AxisRow
            label={t("净盈亏")}
            value={
              s?.netPnl != null
                ? `${s.netPnl >= 0 ? "+" : ""}${usdCompact(s.netPnl)}`
                : "—"
            }
            pctile={data.percentiles.netPnl}
            t={t}
          />
          <AxisRow
            label={t("评分")}
            value={data.score != null ? String(data.score) : "—"}
            pctile={data.percentiles.score}
            t={t}
          />
        </div>
      ) : null}

      {data.inPool ? (
        <div style={{ fontSize: "var(--t-sm)", color: "var(--brand-700)" }}>
          {t("🏆 该地址已在本站聪明钱池内（分位含自身）")}
        </div>
      ) : null}

      <div className="kpi-sub" style={{ lineHeight: 1.6 }}>
        {t("准入口径（两条路，满足其一）：")}
        <br />
        {t("① 已结算 ≥{n} 市场 · 胜率 ≥{p}% · 净盈亏为正", {
          n: data.criteria.minSettled,
          p: Math.round(data.criteria.minWinRate * 100),
        })}
        <br />
        {t("② 已结算 ≥{n} 市场 · ROI ≥{p}% · 净盈亏为正", {
          n: data.criteria.minSettledRoi,
          p: Math.round(data.criteria.minRoi * 100),
        })}
        <br />
        {t(
          "池准入另有「30 天 ≥3 个不同市场」的复发证据要求——那是发现渠道的候选资格，不在自测范围；自测通过 ≠ 自动入池。",
        )}
      </div>

      <div className="kpi-sub">
        {s ? t("已结算 {n} 仓 · ", { n: s.settledCount }) : ""}
        {t("判决计算于 {at}", { at: fmtTs(data.computedAt, locale) })}
        {data.statsFetchedAt != null
          ? " · " +
            t("战绩数据截至 {at}", {
              at: fmtTs(data.statsFetchedAt, locale),
            })
          : ""}
        {" · "}
        {t("分位样本 = 当前池 {n} 名成员", { n: data.poolSize })}
      </div>

      <div
        style={{
          display: "flex",
          gap: "var(--s-2)",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <a className="ds-btn ds-btn--sm" href={`/wallet/${data.address}`}>
          {t("查看完整档案 →")}
        </a>
        <button className="ds-btn ds-btn--sm" onClick={copyEmbed}>
          {copied ? t("已复制") : t("复制嵌入卡代码")}
        </button>
        <a
          className="ds-btn ds-btn--sm"
          href={embedUrl}
          target="_blank"
          rel="noreferrer"
        >
          {t("预览嵌入卡 ↗")}
        </a>
      </div>
    </div>
  );
}
