"use client";

import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { catLabel, catLabelFine } from "../../lib/categoryLabel";
import type { ConvictionReport } from "../../lib/convictionIndex";
import type { PulseReport } from "../../lib/marketPulse";
import { MarketSlugActions } from "../ui";

// /api/pulse 的完整 payload:PulseReport + additive 的确信指数键(服务端
// 现算失败会降级 null,页面必须能在没有它的情况下照常渲染前两个 section)。
type PulsePayload = PulseReport & { conviction?: ConvictionReport | null };

// /pulse 市场脉搏:①异常市场日榜(四个可解释分量合成,总分必须能看到组成)
// ②散户 vs 鲸鱼分歧(小单与鲸鱼桶的方向背离)。数据 = market_daily 每日聚合,
// 从部署日开始积累 —— 页面对外自述底座厚度(dayCount),不装老。

const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const cents = (p: number | null): string =>
  p == null ? "—" : `${(p * 100).toFixed(1).replace(/\.0$/, "")}¢`;

function CompChips({
  c,
}: {
  c: {
    volSurge: number;
    oneSided: number;
    whaleShare: number;
    priceMove: number;
  };
}) {
  const { t } = useLang();
  const item = (label: string, v: number) => (
    <span className="pulse-comp" key={label}>
      <span className="pulse-comp__bar" aria-hidden>
        <span style={{ width: `${Math.round(v * 100)}%` }} />
      </span>
      {t(label)} {Math.round(v * 100)}
    </span>
  );
  return (
    <span className="pulse-comps">
      {item("量能", c.volSurge)}
      {item("单边", c.oneSided)}
      {item("鲸鱼", c.whaleShare)}
      {item("价移", c.priceMove)}
    </span>
  );
}

// 确信指数四分量微条(复用 .pulse-comp 系列样式;标签集与日榜的不同,不硬套
// CompChips 的类型)。
function ConvictionChips({
  c,
}: {
  c: {
    contest: number;
    divergence: number;
    priceMove: number;
    volSurge: number;
  };
}) {
  const { t } = useLang();
  const item = (label: string, v: number) => (
    <span className="pulse-comp" key={label}>
      <span className="pulse-comp__bar" aria-hidden>
        <span style={{ width: `${Math.round(v * 100)}%` }} />
      </span>
      {t(label)} {Math.round(v * 100)}
    </span>
  );
  return (
    <span className="pulse-comps">
      {item("对峙", c.contest)}
      {item("对立", c.divergence)}
      {item("价移", c.priceMove)}
      {item("量能", c.volSurge)}
    </span>
  );
}

// 迷你趋势线:分数天然 0-100 有界,直接线性映射,无需引入图表底座。
// 单点画圆不画线(polyline 单点不可见,会被误读为无数据)。
function ScoreSpark({ series }: { series: { day: string; score: number }[] }) {
  const W = 120;
  const H = 26;
  const PAD = 3;
  if (series.length === 0) return null;
  const y = (s: number) => PAD + (1 - s / 100) * (H - PAD * 2);
  if (series.length === 1) {
    return (
      <svg width={W} height={H} aria-hidden>
        <circle
          cx={W / 2}
          cy={y(series[0].score)}
          r={2.5}
          fill="currentColor"
        />
      </svg>
    );
  }
  const x = (i: number) => PAD + (i / (series.length - 1)) * (W - PAD * 2);
  const points = series.map((s, i) => `${x(i)},${y(s.score)}`).join(" ");
  return (
    <svg width={W} height={H} aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function PulsePage() {
  const { t } = useLang();
  const [report, setReport] = useState<PulsePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/pulse")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setReport((await r.json()) as PulsePayload);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-5)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", margin: 0 }}>{t("市场脉搏")}</h1>
        <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
          {t(
            "每 UTC 日收盘后重建的市场级聚合：谁在异动、小单与鲸鱼是否站在对立面。",
          )}
          {report?.latestDay && (
            <>
              {" "}
              {t("数据到 {d}（UTC）· 底座已积累 {n} 天", {
                d: report.latestDay,
                n: report.dayCount,
              })}
            </>
          )}
        </div>
      </header>

      {error && (
        <div className="ds-callout ds-callout--error">
          {t("加载失败：{err}", { err: error })}
        </div>
      )}
      {!report && !error && <div className="ds-hint">{t("加载中…")}</div>}

      {report && report.latestDay == null && (
        <div className="ds-callout">
          {t(
            "尚无聚合数据 —— 底座从部署后的第一个完整 UTC 日开始积累，明天再来。",
          )}
        </div>
      )}

      {report?.latestDay && (
        <>
          {report.truncated && (
            <div
              className="ds-callout ds-callout--warn"
              style={{ marginBottom: "var(--s-4)" }}
            >
              {t(
                "该日窗口在分页上限处被截断，覆盖不完整 —— 以下数字是下界，不是全量。",
              )}
            </div>
          )}

          <section style={{ marginBottom: "var(--s-6)" }}>
            <h2 style={{ fontSize: "var(--t-lg)", margin: "0 0 var(--s-3)" }}>
              {t("异常市场日榜")}
            </h2>
            {report.top.length === 0 ? (
              <div className="ds-hint">
                {t("该日无达到材料性门槛（$10k 总量）的市场。")}
              </div>
            ) : (
              <div className="ds-table-wrap">
                <table className="ds-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{t("市场")}</th>
                      <th className="is-right">{t("异常分")}</th>
                      <th>{t("构成")}</th>
                      <th className="is-right">{t("量能")}</th>
                      <th className="is-right">{t("顶结果首→末价")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.top.map((m, i) => (
                      <tr key={m.conditionId}>
                        <td className="num mono">{i + 1}</td>
                        <td>
                          <div style={{ fontWeight: 500 }}>
                            {m.title ?? m.conditionId}
                            {m.slug && (
                              <MarketSlugActions
                                slug={m.slug}
                                eventSlug={m.eventSlug ?? undefined}
                              />
                            )}
                          </div>
                          <div className="ds-hint">
                            {catLabelFine(m.category, m.subcategory)}
                            {m.topOutcome && <> · {m.topOutcome}</>}
                            {m.volRatio != null && (
                              <>
                                {" "}
                                ·{" "}
                                {t("量能为其 {n} 日均值的 {r} 倍", {
                                  n: m.volBaselineDays,
                                  r: m.volRatio.toFixed(1),
                                })}
                              </>
                            )}
                          </div>
                        </td>
                        <td
                          className="is-right num mono"
                          style={{ fontSize: "var(--t-lg)", fontWeight: 600 }}
                        >
                          {m.score}
                        </td>
                        <td>
                          <CompChips c={m.components} />
                        </td>
                        <td className="is-right num mono">
                          {usd(m.volumeUsd)}
                        </td>
                        <td className="is-right num mono">
                          {cents(m.priceFirst)} → {cents(m.priceLast)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section style={{ marginBottom: "var(--s-5)" }}>
            <h2 style={{ fontSize: "var(--t-lg)", margin: "0 0 var(--s-3)" }}>
              {t("小单 vs 鲸鱼 · 方向分歧")}
            </h2>
            {report.divergences.length === 0 ? (
              <div className="ds-hint">
                {t("该日无达到双边材料性门槛的方向分歧。")}
              </div>
            ) : (
              <div className="ds-table-wrap">
                <table className="ds-table">
                  <thead>
                    <tr>
                      <th>{t("市场")}</th>
                      <th>{t("小单在买")}</th>
                      <th>{t("鲸鱼在买")}</th>
                      <th className="is-right">{t("分歧强度")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.divergences.map((d) => (
                      <tr key={d.conditionId}>
                        <td>
                          <div style={{ fontWeight: 500 }}>
                            {d.title ?? d.conditionId}
                            {d.slug && <MarketSlugActions slug={d.slug} />}
                          </div>
                          <div className="ds-hint">
                            {catLabelFine(d.category, d.subcategory)}
                          </div>
                        </td>
                        <td>
                          {d.smallTopOutcome}{" "}
                          <span className="num mono up">
                            +{usd(d.smallNetUsd)}
                          </span>
                        </td>
                        <td>
                          {d.whaleTopOutcome}{" "}
                          <span className="num mono up">
                            +{usd(d.whaleNetUsd)}
                          </span>
                        </td>
                        <td className="is-right num mono">{usd(d.strength)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {report.conviction && report.conviction.categories.length > 0 && (
            <section style={{ marginBottom: "var(--s-5)" }}>
              <h2 style={{ fontSize: "var(--t-lg)", margin: "0 0 var(--s-3)" }}>
                {t("确信指数 · 品类激辩度")}
              </h2>
              <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
                {t(
                  "高 = 激辩/恐慌（阵营对峙、小单与鲸鱼对立、价格动荡、量能异动），低 = 确信（一边倒、平静）。VIX 语义，逐品类按日合成。",
                )}
              </div>
              <div className="ds-table-wrap">
                <table className="ds-table">
                  <thead>
                    <tr>
                      <th>{t("品类")}</th>
                      <th className="is-right">{t("指数")}</th>
                      <th>{t("构成")}</th>
                      <th>{t("近 {n} 日", { n: report.conviction.days })}</th>
                      <th className="is-right">{t("量能")}</th>
                      <th className="is-right">{t("市场数")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.conviction.categories.map((c) => (
                      <tr key={c.key || "__other"}>
                        <td style={{ fontWeight: 500 }}>{catLabel(c.key)}</td>
                        <td
                          className="is-right num mono"
                          style={{ fontSize: "var(--t-lg)", fontWeight: 600 }}
                        >
                          {c.score}
                        </td>
                        <td>
                          <ConvictionChips c={c.components} />
                        </td>
                        <td className="ds-hint">
                          <ScoreSpark series={c.series} />
                        </td>
                        <td className="is-right num mono">
                          {usd(c.volumeUsd)}
                        </td>
                        <td className="is-right num mono">{c.markets}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <div className="ds-hint">
            {t(
              "口径：小单 = 单笔 $2k–10k（抓取下限之下的真散户不可见，因此只说「小单」）；鲸鱼 = 单笔 ≥$50k，与 heavy 信号同一把尺；异常分 = 0.35·量能异动 + 0.25·单边度 + 0.20·鲸鱼占比 + 0.20·日内价移，各分量 0–1 可逐项核对；量能异动在同市场基线不足 3 天时退化为当日横截面分位。",
            )}{" "}
            {t(
              "确信指数 = 0.30·阵营对峙（量能加权 1−单边度）+ 0.30·对立度（合格分歧市场量能占比，双边门槛与上表同尺）+ 0.20·价格动荡 + 0.20·量能异动；品类日总量 <$10k 不给分；量能异动在品类自身基线不足 3 天时退化为当日横截面分位。",
            )}
          </div>
        </>
      )}
    </main>
  );
}
