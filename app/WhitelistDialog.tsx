"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal, fmtSignedUsdCompact } from "./ui";

type Row = {
  address: string;
  score: number | null;
  winRate: number | null;
  netPnl: number | null;
  isWhitelist: boolean;
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={640}
      title={`🏆 聪明钱白名单${rows ? ` · ${rows.length} 个钱包` : ""}`}
    >
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索地址…（0x…）"
        aria-label="搜索白名单地址"
        style={{
          width: "100%",
          marginBottom: "var(--s-3)",
          padding: "var(--s-2) var(--s-3)",
          border: "1px solid var(--n-200, #e5e7eb)",
          borderRadius: "var(--radius, 6px)",
          background: "var(--n-50, #f9fafb)",
          color: "inherit",
          fontSize: "inherit",
          fontFamily: "inherit",
        }}
      />
      {rows == null ? (
        <div className="ds-empty">加载中…</div>
      ) : filtered.length === 0 ? (
        <div className="ds-empty">
          {rows.length === 0
            ? "白名单为空（引擎首次播种约需 1 分钟）"
            : "无匹配地址"}
        </div>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th>地址</th>
                <th className="is-right">评分</th>
                <th className="is-right">胜率</th>
                <th className="is-right">净盈亏</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.address}>
                  <td>
                    <a
                      className="mono"
                      href={`/wallet/${r.address}`}
                      target="_blank"
                      rel="noreferrer"
                      title={`${r.address} · 新标签打开钱包档案`}
                    >
                      🏆 {shortWallet(r.address)}
                    </a>
                    {r.isWhitelist ? (
                      <span className="muted"> · 手动</span>
                    ) : null}
                  </td>
                  <td className="mono is-right" data-label="评分">
                    {r.score != null ? Math.round(r.score) : "—"}
                  </td>
                  <td className="mono is-right" data-label="胜率">
                    {r.winRate != null
                      ? `${Math.round(r.winRate * 100)}%`
                      : "—"}
                  </td>
                  <td
                    className={`mono is-right ${
                      (r.netPnl ?? 0) >= 0 ? "up" : "down"
                    }`}
                    data-label="净盈亏"
                  >
                    {r.netPnl != null ? fmtSignedUsdCompact(r.netPnl) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
