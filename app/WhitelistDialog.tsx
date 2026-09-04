"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal, Tag, WalletLink, fmtSignedUsdCompact } from "./ui";
import { useLang } from "./i18n";

type Row = {
  address: string;
  score: number | null;
  winRate: number | null;
  netPnl: number | null;
  isWhitelist: boolean;
  // MM-tagged pool members keep membership but never vote in consensus /
  // disagreement (P0.5) — badged so the pool count stays explainable.
  isMarketMaker?: boolean;
};

function shortWallet(w: string): string {
  return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

// Clickable smart-money whitelist: searchable list of addresses (each links to
// the wallet dossier) with score / win-rate / realized PnL. Fetched once on
// first open and kept for the session.
export function WhitelistDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useLang();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open || rows) return;
    let active = true;
    fetch("/api/whitelist")
      .then((r) => r.json())
      .then((j) => {
        if (active) setRows((j.wallets as Row[]) ?? []);
      })
      .catch(() => {
        if (active) setRows([]);
      });
    return () => {
      active = false;
    };
  }, [open, rows]);

  const filtered = useMemo(() => {
    const list = rows ?? [];
    const s = q.trim().toLowerCase();
    return s ? list.filter((r) => r.address.includes(s)) : list;
  }, [rows, q]);

  // 标题条副行的读数 —— 纯展示派生量，不改任何取数逻辑。
  const mmCount = (rows ?? []).filter((r) => r.isMarketMaker).length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={640}
      // 标题条：12px 大写小标（emoji 前缀）+ 20/600 主行 + 14px muted 副行。
      title={
        <>
          <span className="ds-label" style={{ display: "block" }}>
            🏆 {t("共识白名单池")}
          </span>
          <span style={{ display: "block", marginTop: 4 }}>
            {rows ? t("{n} 个钱包", { n: rows.length }) : t("聪明钱白名单")}
            {mmCount > 0 && (
              <span
                style={{
                  marginLeft: 6,
                  fontSize: "var(--t-md)",
                  fontWeight: 400,
                  color: "var(--ww-text-muted)",
                }}
              >
                {t("其中 {n} 个无投票权", { n: mmCount })}
              </span>
            )}
          </span>
        </>
      }
    >
      {/* 工具条：240px 搜索框 + 右对齐的匹配读数。 */}
      <div className="filter-bar" style={{ marginBottom: "var(--s-4)" }}>
        <input
          className="ds-input"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("搜索地址…（0x…）")}
          aria-label={t("搜索白名单地址")}
          style={{ width: 240, maxWidth: "100%" }}
        />
        {rows != null && q.trim() !== "" && (
          <span className="filter-bar__right ds-hint">
            {t("{shown}/{total} 条匹配", {
              shown: filtered.length,
              total: rows.length,
            })}
          </span>
        )}
      </div>
      {rows == null ? (
        <div className="ds-empty">{t("加载中…")}</div>
      ) : filtered.length === 0 ? (
        // 空态给内容也给出路：搜不到时给一个回到全量的按钮。
        <div className="ds-empty">
          {rows.length === 0
            ? t("白名单为空（引擎首次播种约需 1 分钟）")
            : t("无匹配地址")}
          {q.trim() !== "" && (
            <div style={{ marginTop: "var(--s-3)" }}>
              <button className="ds-btn ds-btn--sm" onClick={() => setQ("")}>
                {t("清除")}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th>{t("地址")}</th>
                <th className="is-right" style={{ width: 80 }}>
                  {t("评分")}
                </th>
                <th className="is-right" style={{ width: 80 }}>
                  {t("胜率")}
                </th>
                <th className="is-right" style={{ width: 130 }}>
                  {t("净盈亏")}
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.address}>
                  {/* 地址是唯一做首尾省略的东西；来源与投票权是常驻徽章，
                      不再是只有桌面 hover 才读得到的 title。 */}
                  <td data-label={t("地址")}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "var(--s-2)",
                        flexWrap: "wrap",
                      }}
                    >
                      <WalletLink address={r.address}>
                        {shortWallet(r.address)}
                      </WalletLink>
                      {/* 灰底名称标签 = 「这个地址是谁」，不表示状态：手动
                          白名单行(is_whitelist=1)不参与 30 天老化清退，
                          「永不过期」是它与其余池成员的实际区别。 */}
                      {r.isWhitelist ? <Tag>{t("手动 · 永不过期")}</Tag> : null}
                      {r.isMarketMaker ? (
                        <Tag variant="warn">🤖 {t("无投票权")}</Tag>
                      ) : null}
                    </span>
                  </td>
                  {/* `—` 是「判不了」，不是零 —— muted 与真实 0 分家。 */}
                  <td className="is-right" data-label={t("评分")}>
                    {r.score != null ? (
                      Math.round(r.score)
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="is-right" data-label={t("胜率")}>
                    {r.winRate != null ? (
                      `${Math.round(r.winRate * 100)}%`
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  {/* 净盈亏是真正的盈亏方向 —— 涨绿跌红成立（成本类才中性）。
                      判不了的行不染色：原来 null 会落进 `>= 0` 分支拿到绿。 */}
                  <td
                    className="is-right"
                    data-label={t("净盈亏")}
                    style={
                      r.netPnl != null
                        ? {
                            color:
                              r.netPnl >= 0 ? "var(--ww-up)" : "var(--ww-down)",
                          }
                        : undefined
                    }
                  >
                    {r.netPnl != null ? (
                      fmtSignedUsdCompact(r.netPnl)
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* 卡底琥珀条 —— 投票权口径与 `—` 的含义，触屏也读得到。 */}
          <div className="note-strip note-strip--warn">
            ⚠️{" "}
            {t(
              "「🤖 无投票权」= 做市机器人（成交市场数 ≥1000）：保留池成员资格以积累战绩数据，但做市流是库存再平衡、不是方向性观点，因此不计入共识 / 分歧投票。评分 / 胜率的 — 是「判不了」，不是零。",
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
