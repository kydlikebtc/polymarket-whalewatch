"use client";

import { useEffect, useMemo, useState } from "react";
import { useLang } from "../i18n";
import { catLabel } from "../../lib/categoryLabel";
import type { CalibrationBand, CalibrationReport } from "../../lib/calibration";
import { StatCard, Tag } from "../ui";

// /calibration 市场校准研究:这不是我们的战绩页 —— 样本是「alert 时点的市场
// 隐含概率 vs 最终结算」,回答的是 Polymarket 价格本身准不准。选择偏差声明
// 是本页的可信度底线(observations 不是随机抽样),砍谁不能砍它。

const pct = (p: number): string => `${(p * 100).toFixed(1)}%`;

// 偏差的带号写法:正号 +,负号用真减号 U+2212(不是 ASCII 连字符)——
// 整列右对齐时两种符号宽度不同会看出参差。
const gapText = (gap: number): string =>
  `${gap >= 0 ? "+" : "−"}${pct(Math.abs(gap))}`;

// 涨绿跌红只留给真正有方向的数,±0.5 个百分点内记平推(1pp 就是 1¢,与全站
// 的 ±0.5¢ 死区同一把尺)—— 把半个 ¢ 的噪声染成绿/红是在画方向。
const gapTone = (gap: number): string =>
  Math.abs(gap) < 0.005 ? "faint" : gap > 0 ? "up" : "down";

// 「显著」的唯一判据,与表下读法说明同一句话:隐含均值落在聚簇 95% 区间之外。
// 纯展示派生,不改 lib/calibration 里的任何统计。
const isSignificant = (b: CalibrationBand): boolean =>
  b.implied < b.ciLo || b.implied > b.ciHi;

export default function CalibrationPage() {
  const { t } = useLang();
  const [report, setReport] = useState<CalibrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<string>("overall");

  useEffect(() => {
    fetch("/api/calibration")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setReport((await r.json()) as CalibrationReport);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const options = useMemo(() => {
    const cats = report?.byCategory ?? [];
    return [
      { value: "overall", label: t("总体") },
      ...cats.map((g) => ({ value: g.key, label: t(catLabel(g.key)) })),
    ];
  }, [report, t]);

  const active =
    group === "overall"
      ? report?.overall
      : (report?.byCategory.find((g) => g.key === group) ?? report?.overall);
  const bands = (active?.bands ?? []).filter((b) => b.n > 0);
  const sigCount = bands.filter(isSignificant).length;

  return (
    <main className="ds-main">
      <header className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="page-head__eyebrow">
            {t("📐 研究页 · 不是本站战绩")}
          </div>
          <h1 className="page-head__title">{t("市场校准")}</h1>
          {/* 描述句不再重复「不是本站战绩」—— 那句话已经由上面的 12px 小标
              说过一次;页头三层(小标 / 标题 / 描述)各说各的,不互相复读。 */}
          <p className="page-head__desc">
            {t(
              "Polymarket 的价格本身准不准：按赔率带对比市场隐含概率与实际发生率。",
            )}
          </p>
        </div>
        <div className="page-head__actions">
          <a className="ds-btn" href="#bias">
            {t("选择偏差声明")}
          </a>
        </div>
      </header>

      {error && (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-4)" }}
        >
          {t("加载失败：{err}", { err: error })}
        </div>
      )}

      {report && report.totalN > 0 && (
        <section className="kpi">
          <StatCard label={t("观察数")} icon="📊">
            <div className="kpi-value">
              {(active?.n ?? 0).toLocaleString("en-US")}
            </div>
            <div className="kpi-sub">{t("本站 alert 触发时点的价格观察")}</div>
          </StatCard>
          <StatCard label={t("去重市场")} icon="🗂">
            <div className="kpi-value">
              {(active?.markets ?? 0).toLocaleString("en-US")}
            </div>
            <div className="kpi-sub">{t("本站覆盖过的市场")}</div>
          </StatCard>
          <StatCard label={t("统计显著的赔率带")} icon="📐">
            <div
              className="kpi-value"
              style={sigCount > 0 ? { color: "var(--ww-link)" } : undefined}
            >
              {sigCount} / {bands.length}
            </div>
            <div className="kpi-sub">{t("隐含均值落在聚簇 95% 区间之外")}</div>
          </StatCard>
        </section>
      )}

      {/* 口径条 —— 选择偏差是本页可信度底线,永远在数据前面。
          正文自己就以「选择偏差声明：」开头,所以不再顶一行同名小标
          (设计稿 07 的琥珀框是单段:⚠️ + 一句话口径,不是标题 + 正文)。 */}
      <div
        className="ds-callout ds-callout--warn"
        id="bias"
        style={{ margin: "var(--s-4) 0" }}
      >
        <span aria-hidden>⚠️</span>{" "}
        {t(
          "选择偏差声明：样本 = 本站 alert 触发时点的市场价格观察（大额/聪明钱活动时刻，非随机抽样），市场范围 = 本站覆盖过的市场。结论只主张到这个样本；置信区间按市场数聚簇（同市场多条 alert 是同一次随机事件的复制品）。",
        )}
      </div>

      {!report && !error && <div className="ds-empty">{t("加载中…")}</div>}

      {report && report.totalN === 0 && (
        <div className="ds-empty">
          <div>{t("尚无已结算的观察样本 —— 结算回填持续积累中。")}</div>
          <div style={{ marginTop: "var(--s-2)" }}>
            <a href="/record">{t("去看公开信号战绩")}</a>
          </div>
        </div>
      )}

      {report && report.totalN > 0 && (
        <>
          {/* 筛选条 —— 一排 32px 描边钮,当前项蓝描边 */}
          <div className="filter-bar" role="group" aria-label={t("分组")}>
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                className={
                  group === o.value ? "ds-btn ds-btn--active" : "ds-btn"
                }
                aria-pressed={group === o.value}
                onClick={() => setGroup(o.value)}
              >
                {o.label}
              </button>
            ))}
            <span className="filter-bar__right ds-hint">
              {t("偏差 = 实际发生率 − 隐含均值")}
            </span>
          </div>

          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead>
                <tr>
                  <th>{t("赔率带")}</th>
                  <th className="is-right">{t("观察数")}</th>
                  <th className="is-right">{t("市场数")}</th>
                  <th className="is-right">{t("隐含均值")}</th>
                  <th className="is-right">{t("实际发生率")}</th>
                  <th className="is-right">{t("95% 区间（聚簇）")}</th>
                  <th>{t("偏差 · 被低估 / 被高估")}</th>
                </tr>
              </thead>
              <tbody>
                {bands.map((b) => (
                  <tr key={b.band}>
                    <td>{b.band}</td>
                    <td className="is-right" data-label={t("观察数")}>
                      {b.n.toLocaleString("en-US")}
                    </td>
                    <td className="is-right" data-label={t("市场数")}>
                      {b.markets.toLocaleString("en-US")}
                    </td>
                    <td className="is-right" data-label={t("隐含均值")}>
                      {pct(b.implied)}
                    </td>
                    <td className="is-right" data-label={t("实际发生率")}>
                      {pct(b.observed)}
                    </td>
                    <td
                      className="is-right muted"
                      data-label={t("95% 区间（聚簇）")}
                    >
                      {pct(b.ciLo)}–{pct(b.ciHi)}
                    </td>
                    <td data-label={t("偏差")}>
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "var(--s-3)",
                        }}
                      >
                        <span
                          className={gapTone(b.gap)}
                          style={{ minWidth: 64, textAlign: "right" }}
                        >
                          {gapText(b.gap)}
                        </span>
                        {isSignificant(b) ? (
                          <Tag variant="down">{t("显著")}</Tag>
                        ) : (
                          <Tag>{t("区间内")}</Tag>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* 卡底说明条 —— 「偏差 = 实际发生率 − 隐含均值」的定义已经写在
                筛选条右侧,这里只讲读法与显著性判据,不复读公式。 */}
            <div className="note-strip">
              {t(
                "正 = 该价位历史上被低估（便宜），负 = 被高估。只有隐含均值落在聚簇 95% 区间之外才算统计显著 —— 上表已按此标出，其余为区间内。样本随结算回填每日增长。",
              )}
            </div>
          </div>
        </>
      )}
    </main>
  );
}
