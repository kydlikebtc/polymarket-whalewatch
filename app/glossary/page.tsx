"use client";

import { ICONS, TERMS, WALLET_TAGS } from "../glossary";

// Static reference page — every symbol and term the dashboard uses, from the
// same data source that powers the hover tooltips (app/glossary.ts).
export default function GlossaryPage() {
  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-5)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", marginBottom: "var(--s-1)" }}>
          📖 图标与名词说明
        </h1>
        <div className="ds-hint">
          全站所有符号和术语的定义 —
          鼠标悬停在任意页面的图标上也能看到同样的解释
        </div>
      </header>

      {/* Icons */}
      <section style={{ marginBottom: "var(--s-6)" }}>
        <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
          图标标识
        </div>
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th style={{ width: 56 }}>符号</th>
                <th style={{ width: 140 }}>名称</th>
                <th>含义</th>
              </tr>
            </thead>
            <tbody>
              {ICONS.map((e) => (
                <tr key={e.symbol}>
                  <td style={{ fontSize: "var(--t-lg)", textAlign: "center" }}>
                    {e.symbol}
                  </td>
                  <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                    {e.name}
                  </td>
                  <td style={{ whiteSpace: "normal", lineHeight: 1.6 }}>
                    {e.detail}
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
          钱包标签（聪明钱发现 / 钱包档案页）
        </div>
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th style={{ width: 56 }}>符号</th>
                <th style={{ width: 150 }}>标签</th>
                <th style={{ width: 90 }}>类别</th>
                <th>定义</th>
              </tr>
            </thead>
            <tbody>
              {WALLET_TAGS.map((t) => (
                <tr key={t.keyPrefix}>
                  <td style={{ fontSize: "var(--t-lg)", textAlign: "center" }}>
                    {t.icon}
                  </td>
                  <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                    {t.name}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{t.kind}</td>
                  <td style={{ whiteSpace: "normal", lineHeight: 1.6 }}>
                    {t.detail}
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
          核心名词
        </div>
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th style={{ width: 190 }}>名词</th>
                <th>解释</th>
              </tr>
            </thead>
            <tbody>
              {TERMS.map((t) => (
                <tr key={t.term}>
                  <td style={{ fontWeight: 600, whiteSpace: "normal" }}>
                    {t.term}
                  </td>
                  <td style={{ whiteSpace: "normal", lineHeight: 1.6 }}>
                    {t.detail}
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
          信号强度速查（由弱到强）
        </div>
        <div
          className="ds-card"
          style={{ padding: "var(--s-4)", lineHeight: 2 }}
        >
          <div>
            💰 <strong>大额成交</strong> — 有人下了重注（最基础）
          </div>
          <div>
            🧩 <strong>拆单累计</strong> — 有人在刻意隐藏地建仓（绕过单笔监控）
          </div>
          <div>
            🆕 ＋ 甜区赔率 — <strong>内幕猎杀组合</strong> —
            新钱包在有利赔率上下重注（可疑）
          </div>
          <div>
            🏆 <strong>聪明钱出手</strong> — 历史高胜率的钱包在买（有战绩背书）
          </div>
          <div>
            🔥 <strong>聪明钱共识</strong> —
            多个高胜率钱包独立得出同一结论（最强单一信号）
          </div>
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            无论哪一层，📐 验证列都会在事后告诉你：这个信号最终准不准。
          </div>
        </div>
      </section>
    </main>
  );
}
