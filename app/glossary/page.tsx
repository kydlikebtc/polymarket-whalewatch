"use client";

import { ICONS, TERMS, WALLET_TAGS } from "../glossary";
import { useLang } from "../i18n";

// Static reference page — every symbol and term the dashboard uses, from the
// same data source that powers the hover tooltips (app/glossary.ts).
//
// 双语化:词表数据(app/glossary.ts)是中文唯一源,页面只在渲染处过
// t(中文串) —— 键即中文原文,译文全部在 lib/i18n/dict/glossary.ts。
// 所以 name/tip/detail 与各页悬停提示走同一批键,永不漂移;缺译回退中文。
export default function GlossaryPage() {
  const { t } = useLang();
  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-5)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", marginBottom: "var(--s-1)" }}>
          {t("📖 图标与名词说明")}
        </h1>
        <div className="ds-hint">
          {t(
            "全站所有符号和术语的定义 — 鼠标悬停在任意页面的图标上也能看到同样的解释",
          )}
        </div>
      </header>

      {/* Icons */}
      <section style={{ marginBottom: "var(--s-6)" }}>
        <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
          {t("图标标识")}
        </div>
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th style={{ width: 56 }}>{t("符号")}</th>
                <th style={{ width: 140 }}>{t("名称")}</th>
                <th>{t("含义")}</th>
              </tr>
            </thead>
            <tbody>
              {ICONS.map((e) => (
                <tr key={e.symbol}>
                  <td style={{ fontSize: "var(--t-lg)", textAlign: "center" }}>
                    {e.symbol}
                  </td>
                  <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                    {t(e.name)}
                  </td>
                  <td style={{ whiteSpace: "normal", lineHeight: 1.6 }}>
                    {t(e.detail)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Wallet tags — same data source as the /discovery tag dialog and
          every tag chip's hover tip (app/glossary.ts WALLET_TAGS) */}
      <section style={{ marginBottom: "var(--s-6)" }}>
        <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
          {t("钱包标签（聪明钱发现 / 钱包档案页）")}
        </div>
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th style={{ width: 56 }}>{t("符号")}</th>
                <th style={{ width: 150 }}>{t("标签")}</th>
                <th style={{ width: 90 }}>{t("类别")}</th>
                <th>{t("定义")}</th>
              </tr>
            </thead>
            <tbody>
              {WALLET_TAGS.map((w) => (
                <tr key={w.keyPrefix}>
                  <td style={{ fontSize: "var(--t-lg)", textAlign: "center" }}>
                    {w.icon}
                  </td>
                  <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                    {t(w.name)}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{t(w.kind)}</td>
                  <td style={{ whiteSpace: "normal", lineHeight: 1.6 }}>
                    {t(w.detail)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Terms */}
      <section style={{ marginBottom: "var(--s-6)" }}>
        <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
          {t("核心名词")}
        </div>
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th style={{ width: 190 }}>{t("名词")}</th>
                <th>{t("解释")}</th>
              </tr>
            </thead>
            <tbody>
              {TERMS.map((e) => (
                <tr key={e.term}>
                  <td style={{ fontWeight: 600, whiteSpace: "normal" }}>
                    {t(e.term)}
                  </td>
                  <td style={{ whiteSpace: "normal", lineHeight: 1.6 }}>
                    {t(e.detail)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Signal types quick map */}
      <section>
        <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
          {t("信号强度速查（由弱到强）")}
        </div>
        <div
          className="ds-card"
          style={{ padding: "var(--s-4)", lineHeight: 2 }}
        >
          <div>
            💰 <strong>{t("大额成交")}</strong> — {t("有人下了重注（最基础）")}
          </div>
          <div>
            🧩 <strong>{t("拆单累计")}</strong> —{" "}
            {t("有人在刻意隐藏地建仓（绕过单笔监控）")}
          </div>
          <div>
            🆕 ＋ {t("甜区赔率")} — <strong>{t("内幕猎杀组合")}</strong> —{" "}
            {t("新钱包在有利赔率上下重注（可疑）")}
          </div>
          <div>
            🏆 <strong>{t("聪明钱出手")}</strong> —{" "}
            {t("历史高胜率的钱包在买（有战绩背书）")}
          </div>
          <div>
            🔥 <strong>{t("聪明钱共识")}</strong> —{" "}
            {t("多个高胜率钱包独立得出同一结论（最强单一信号）")}
          </div>
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            {t("无论哪一层，📐 验证列都会在事后告诉你：这个信号最终准不准。")}
          </div>
        </div>
      </section>
    </main>
  );
}
