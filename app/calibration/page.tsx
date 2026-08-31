"use client";

import { useEffect, useMemo, useState } from "react";
import { useLang } from "../i18n";
import { catLabel } from "../../lib/categoryLabel";
import type { CalibrationReport } from "../../lib/calibration";
import { Segmented } from "../ui";

// /calibration 市场校准研究:这不是我们的战绩页 —— 样本是「alert 时点的市场
// 隐含概率 vs 最终结算」,回答的是 Polymarket 价格本身准不准。选择偏差声明
// 是本页的可信度底线(observations 不是随机抽样),砍谁不能砍它。

const pct = (p: number): string => `${(p * 100).toFixed(1)}%`;

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

  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-5)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", margin: 0 }}>{t("市场校准")}</h1>
        <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
          {t(
            "Polymarket 的价格本身准不准：按赔率带对比「市场隐含概率」与「实际发生率」。这不是本站信号的战绩页。",
          )}
        </div>
      </header>

      <div
        className="ds-callout ds-callout--warn"
        style={{ marginBottom: "var(--s-4)" }}
      >
        {t(
          "选择偏差声明：样本 = 本站 alert 触发时点的市场价格观察（大额/聪明钱活动时刻，非随机抽样），市场范围 = 本站覆盖过的市场。结论只主张到这个样本；置信区间按市场数聚簇（同市场多条 alert 是同一次随机事件的复制品）。",
        )}
      </div>

      {error && (
        <div className="ds-callout ds-callout--error">
          {t("加载失败：{err}", { err: error })}
        </div>
      )}
      {!report && !error && <div className="ds-hint">{t("加载中…")}</div>}

      {report && report.totalN === 0 && (
        <div className="ds-callout">
          {t("尚无已结算的观察样本 —— 结算回填持续积累中。")}
        </div>
      )}

      {report && report.totalN > 0 && (
        <>
          <div style={{ marginBottom: "var(--s-4)" }}>
            <Segmented
              options={options}
              value={group}
              onChange={setGroup}
              ariaLabel={t("分组")}
            />
          </div>

          <div className="ds-hint" style={{ marginBottom: "var(--s-3)" }}>
            {t("{n} 条观察 · {m} 个去重市场", {
              n: active?.n ?? 0,
              m: active?.markets ?? 0,
            })}
          </div>

          <div className="ds-table-wrap" style={{ marginBottom: "var(--s-4)" }}>
            <table className="ds-table">
              <thead>
                <tr>
                  <th>{t("赔率带")}</th>
                  <th className="is-right">{t("观察数")}</th>
                  <th className="is-right">{t("市场数")}</th>
                  <th className="is-right">{t("隐含均值")}</th>
                  <th className="is-right">{t("实际发生率")}</th>
                  <th className="is-right">{t("95% 区间（聚簇）")}</th>
                  <th className="is-right">{t("偏差")}</th>
                </tr>
              </thead>
              <tbody>
                {bands.map((b) => (
                  <tr key={b.band}>
                    <td className="mono">{b.band}</td>
                    <td className="is-right num mono">{b.n}</td>
                    <td className="is-right num mono">{b.markets}</td>
                    <td className="is-right num mono">{pct(b.implied)}</td>
                    <td className="is-right num mono">{pct(b.observed)}</td>
                    <td className="is-right num mono muted">
                      {pct(b.ciLo)}–{pct(b.ciHi)}
                    </td>
                    <td
                      className={`is-right num mono ${b.gap >= 0 ? "up" : "down"}`}
                    >
                      {b.gap >= 0 ? "+" : ""}
                      {pct(b.gap)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="ds-hint">
            {t(
              "读法：偏差 = 实际发生率 − 隐含均值。正 = 该价位历史上被低估（便宜），负 = 被高估；只有当隐含均值落在聚簇 95% 区间之外时，偏差才谈得上统计显著。样本随结算回填每日增长。",
            )}
          </div>
        </>
      )}
    </main>
  );
}
