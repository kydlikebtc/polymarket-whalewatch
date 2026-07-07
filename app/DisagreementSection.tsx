"use client";

import { Fragment, useState } from "react";
import { HoldingCell, Icon, Tag, catLabel } from "./ui";
import { useMarketPositions } from "./useMarketPositions";

export type DisagreementWallet = {
  wallet: string;
  netUsd: number;
  score: number | null;
  winRate: number | null;
  avgBuyPrice: number;
};

export type DisagreementSide = {
  outcome: string;
  outcomeIndex: number;
  asset: string;
  walletCount: number;
  netUsd: number;
  weightedUsd: number;
  avgBuyPrice: number;
  wallets: DisagreementWallet[];
  currentPrice: number | null;
};

export type DisagreementMarket = {
  conditionId: string;
  title: string;
  eventSlug: string;
  sides: DisagreementSide[];
  totalNetUsd: number;
  totalWeightedUsd: number;
  tiltPct: number;
  tilt: "lopsided" | "balanced";
  excludedWallets: number;
  firstTs: number;
  lastTs: number;
  category: string | null;
  closed: boolean;
};

// Distinct segment colors for the balance bar (fallbacks so a missing design
// token still paints). Side order = weighted desc, so [0] is the leading side.
const SIDE_COLORS = [
  "var(--brand-500, #6366f1)",
  "var(--warn-600, #d97706)",
  "var(--n-400, #9ca3af)",
  "var(--n-300, #d1d5db)",
];

function fmtUsd(usd: number): string {
  return usd.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function shortWallet(w: string): string {
  if (!w) return "";
  return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

function fmtTime(tsSec: number): string {
  return new Date(tsSec * 1000).toLocaleTimeString("zh-CN", { hour12: false });
}

const sideColor = (i: number) =>
  SIDE_COLORS[i] ?? SIDE_COLORS[SIDE_COLORS.length - 1];

// Quality-weighted balance across a market's sides. Pure fact: how the smart
// money's weight leans — no follow/skip advice.
function BalanceBar({
  sides,
  total,
}: {
  sides: DisagreementSide[];
  total: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        height: 10,
        borderRadius: 5,
        overflow: "hidden",
        background: "var(--n-100, #f3f4f6)",
      }}
      aria-hidden
    >
      {sides.map((s, i) => {
        const pct = total > 0 ? (s.weightedUsd / total) * 100 : 0;
        return (
          <div
            key={s.outcome}
            title={`${s.outcome} · 质量加权 $${fmtUsd(s.weightedUsd)}`}
            style={{ width: `${pct}%`, background: sideColor(i) }}
          />
        );
      })}
    </div>
  );
}

// Dot legend chip for a side (colored square + outcome + weighted $).
function SideChip({ side, i }: { side: DisagreementSide; i: number }) {
  return (
    <span className="mono">
      <span
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: 2,
          marginRight: 4,
          background: sideColor(i),
        }}
      />
      {side.outcome} ${fmtUsd(side.weightedUsd)}
    </span>
  );
}

// Expanded per-side wallet detail. Rendered only when a market row is open, so
// mounting it triggers the lazy current-position fetch (window net-buy = "flow";
// the added 当前持仓 column = "stock", i.e. what each wallet holds right now).
function MarketDetail({ market }: { market: DisagreementMarket }) {
  const wallets = market.sides.flatMap((s) => s.wallets.map((w) => w.wallet));
  const { positions, loading } = useMarketPositions(
    market.conditionId,
    wallets,
    true,
  );
  return (
    <>
      {market.sides.map((s, i) => (
        <div key={s.outcome} style={{ margin: "var(--s-3) 0" }}>
          <div className="ds-hint" style={{ marginBottom: "var(--s-1)" }}>
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: 2,
                marginRight: 6,
                background: sideColor(i),
              }}
            />
            <strong>{s.outcome}</strong> · {s.walletCount} 个钱包 · 净买 $
            {fmtUsd(s.netUsd)} · 质量加权 ${fmtUsd(s.weightedUsd)} · 建仓均价{" "}
            {s.avgBuyPrice.toFixed(3)}
            {s.currentPrice != null
              ? ` · 现价 ${s.currentPrice.toFixed(3)}`
              : ""}
          </div>
          <table className="ds-table--compact" style={{ maxWidth: 720 }}>
            <thead>
              <tr>
                <th>钱包</th>
                <th className="is-right">评分</th>
                <th className="is-right">胜率</th>
                <th className="is-right">净买入</th>
                <th className="is-right">建仓均价</th>
                <th
                  className="is-right"
                  title="该钱包当前在此结果的持仓市值与浮动盈亏"
                >
                  当前持仓
                </th>
              </tr>
            </thead>
            <tbody>
              {s.wallets.map((w) => (
                <tr key={`${s.outcome}-${w.wallet}`}>
                  <td>
                    <a
                      className="mono"
                      href={`/wallet/${w.wallet}`}
                      target="_blank"
                      rel="noreferrer"
                      title={`${w.wallet} · 新标签打开钱包档案`}
                    >
                      <Icon s="🏆" /> {shortWallet(w.wallet)}
                    </a>
                  </td>
                  <td className="mono is-right" data-label="评分">
                    {w.score != null ? Math.round(w.score) : "—"}
                  </td>
                  <td className="mono is-right" data-label="胜率">
                    {w.winRate != null
                      ? `${Math.round(w.winRate * 100)}%`
                      : "—"}
                  </td>
                  <td className="mono is-right" data-label="净买入">
                    ${fmtUsd(w.netUsd)}
                  </td>
                  <td
                    className="mono is-right"
                    data-label="建仓均价"
                    style={{ color: "var(--warn-700)" }}
                  >
                    {w.avgBuyPrice.toFixed(3)}
                  </td>
                  <td className="mono is-right" data-label="当前持仓">
                    <HoldingCell
                      pos={
                        positions?.[w.wallet.toLowerCase()]?.[
                          s.outcome.toLowerCase()
                        ]
                      }
                      loading={loading}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

// The ⚖️ disagreement table: markets where whitelisted smart money net-buys
// opposing outcomes. Mutually exclusive with the consensus list above it.
export function DisagreementSection({
  markets,
}: {
  markets: DisagreementMarket[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (markets.length === 0) {
    return (
      <div className="ds-empty">
        窗口内暂无聪明钱分歧 — 白名单钱包没有在同一市场对立建仓
      </div>
    );
  }

  return (
    <div className="ds-table-wrap">
      <table className="ds-table">
        <thead>
          <tr>
            <th style={{ width: 28, padding: "var(--s-2) var(--s-1)" }} />
            <th>市场</th>
            <th>质量加权天平</th>
            <th className="is-right">倾斜</th>
            <th className="is-right">合计加权</th>
            <th className="is-right">最新时间</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m) => {
            const key = m.conditionId;
            const isOpen = expanded.has(key);
            const tiltPctLabel = Math.round(m.tiltPct * 100);
            const lead = m.sides[0];
            // A settled market's tilt is moot — show the resolved winner instead
            // (mirrors the consensus board's 已结算 badge). Settled = gamma's
            // `closed` flag OR a side price pinned to 0/1; winner = the side that
            // resolved toward 1 (null if a third outcome won — both sides at ~0).
            const settled =
              m.closed ||
              m.sides.some(
                (s) =>
                  s.currentPrice != null &&
                  (s.currentPrice >= 0.999 || s.currentPrice <= 0.001),
              );
            const topSide = settled
              ? [...m.sides]
                  .filter((s) => s.currentPrice != null)
                  .sort(
                    (a, b) => (b.currentPrice ?? 0) - (a.currentPrice ?? 0),
                  )[0]
              : null;
            const winnerOutcome =
              topSide &&
              topSide.currentPrice != null &&
              topSide.currentPrice > 0.5
                ? topSide.outcome
                : null;
            return (
              <Fragment key={key}>
                <tr
                  onClick={() => toggle(key)}
                  style={{ cursor: "pointer" }}
                  title={isOpen ? "点击收起各侧明细" : "点击展开各侧明细"}
                >
                  <td
                    className="muted col-expand"
                    style={{
                      padding: "var(--s-3) var(--s-1)",
                      textAlign: "center",
                      userSelect: "none",
                    }}
                  >
                    {isOpen ? "▾" : "▸"}
                  </td>
                  <td style={{ whiteSpace: "normal", maxWidth: 320 }}>
                    {m.eventSlug ? (
                      <a
                        href={`https://polymarket.com/event/${m.eventSlug}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {m.title}
                      </a>
                    ) : (
                      m.title
                    )}
                    <div className="kpi-sub">
                      {m.sides.map((s) => s.outcome).join(" ⚔ ")}
                      {m.category ? ` · ${catLabel(m.category)}` : ""}
                      {m.excludedWallets > 0
                        ? ` · 已剔除 ${m.excludedWallets} 个两边押`
                        : ""}
                    </div>
                  </td>
                  <td
                    className="col-block"
                    data-label="质量加权天平"
                    style={{ minWidth: 180, maxWidth: 260 }}
                  >
                    <BalanceBar sides={m.sides} total={m.totalWeightedUsd} />
                    <div
                      className="kpi-sub"
                      style={{ display: "flex", gap: "var(--s-2)" }}
                    >
                      {m.sides.map((s, i) => (
                        <SideChip key={s.outcome} side={s} i={i} />
                      ))}
                    </div>
                  </td>
                  <td className="is-right" data-label="倾斜">
                    {settled ? (
                      <Tag variant="default">
                        已结算{winnerOutcome ? ` · ${winnerOutcome} 胜` : ""}
                      </Tag>
                    ) : m.tilt === "lopsided" ? (
                      <Tag variant="brand">
                        {lead?.outcome} 倒向 {tiltPctLabel}%
                      </Tag>
                    ) : (
                      <Tag variant="warn">势均力敌 {tiltPctLabel}%</Tag>
                    )}
                  </td>
                  <td
                    className="mono is-right"
                    data-label="合计加权"
                    style={{ fontWeight: 700 }}
                  >
                    ${fmtUsd(m.totalWeightedUsd)}
                  </td>
                  <td className="mono muted is-right" data-label="最新时间">
                    {fmtTime(m.lastTs)}
                  </td>
                </tr>
                {isOpen ? (
                  <tr>
                    <td
                      colSpan={6}
                      style={{
                        padding: "0 var(--s-3) var(--s-3) var(--s-10)",
                        borderBottom: "1px solid var(--n-150)",
                        background: "var(--n-50)",
                      }}
                    >
                      <MarketDetail market={m} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
