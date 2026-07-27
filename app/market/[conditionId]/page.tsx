"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { MarketSlugActions, StatCard, Tag, WalletLink } from "../../ui";

// ---- API payload types (server truth lives in /api/market/[conditionId]) --

interface FlowWallet {
  wallet: string;
  exposureUsd: number;
  netShares: number;
  avgBuyPrice: number;
  score: number | null;
  winRate: number | null;
  isMarketMaker: boolean;
}
interface OutcomeFlow {
  outcome: string;
  totalExposureUsd: number;
  wallets: FlowWallet[];
}
interface AccumRow {
  wallet: string;
  outcome: string;
  buyCount: number;
  exposureUsd: number;
  avgBuyPrice: number;
  hedgeSuspect: boolean;
  mmSuspect: boolean;
}
interface ConsensusInfo {
  outcome: string;
  walletCount: number;
  totalNetUsd: number;
  avgBuyPrice: number;
  wallets: { wallet: string; netUsd: number; score: number | null }[];
}
interface DisagreementSideInfo {
  outcome: string;
  walletCount: number;
  netUsd: number;
  weightedUsd: number;
}
interface Payload {
  conditionId: string;
  identity: { title: string; slug: string; eventSlug: string } | null;
  meta: {
    volume24hr: number | null;
    liquidity: number | null;
    endDate: string | null;
    closed: boolean;
    outcomes: string[];
    outcomePrices: number[];
  } | null;
  brief: {
    classification:
      | { kind: "consensus"; group: ConsensusInfo }
      | {
          kind: "disagreement";
          market: { sides: DisagreementSideInfo[]; tilt: string };
        }
      | { kind: "none" };
    smartFlow: OutcomeFlow[];
    accum: AccumRow[];
  };
  freshFlow: {
    wallet: string;
    ageDays: number;
    usd: number;
    price: number;
    outcome: string;
    ts: number;
  }[];
  history: {
    type: string;
    createdAt: number;
    outcome: string;
    side: string;
    usd: number;
    price: number | null;
    won: number | null;
    price1h: number | null;
    price24h: number | null;
    resolved: boolean;
  }[];
  window: { trades: number; truncated: boolean; hours: number };
  error?: string;
}

const fmtUsd = (v: number) => Math.round(v).toLocaleString("en-US");
const fmtCents = (p: number) => `${+(p * 100).toFixed(1)}¢`;
const fmtTime = (sec: number) =>
  new Date(sec * 1000).toLocaleString("zh-CN", { hour12: false });
const shortWallet = (w: string) =>
  w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;

const TYPE_ICON: Record<string, string> = {
  large: "💰",
  smart: "🏆",
  consensus: "🔥",
};

export default function MarketCard() {
  const { conditionId } = useParams<{ conditionId: string }>();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/market/${conditionId}`)
      .then((r) => r.json())
      .then((j: Payload) => {
        if (!active) return;
        if (j.error) setError(j.error);
        else setData(j);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [conditionId]);

  if (error) {
    return (
      <main className="ds-main">
        <div className="ds-callout">加载失败：{error}</div>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="ds-main">
        <div className="ds-empty">
          聚合中…（拉取该市场 24h 成交并跑全部检测器）
        </div>
      </main>
    );
  }

  const { identity, meta, brief, freshFlow, history, window: win } = data;
  const cls = brief.classification;
  const hoursToEnd =
    meta?.endDate != null
      ? (Date.parse(meta.endDate) - Date.now()) / 3_600_000
      : null;

  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-4)" }}>
        <div className="ds-hint" style={{ marginBottom: "var(--s-1)" }}>
          <Link href="/market">🎯 市场信号卡</Link> · 窗口近 {win.hours}h ·{" "}
          {win.trades} 笔 ≥$500 成交
          {win.truncated ? "（窗口触顶截断，指标为下界）" : ""}
        </div>
        <h1 style={{ fontSize: "var(--t-2xl)", marginBottom: "var(--s-1)" }}>
          {identity?.title ?? data.conditionId}
          {meta?.closed ? <Tag> 已结算</Tag> : null}
        </h1>
        <div className="ds-hint mono">
          {identity && (
            <>
              {identity.slug}{" "}
              <MarketSlugActions
                slug={identity.slug}
                eventSlug={identity.eventSlug}
              />{" "}
              ·{" "}
            </>
          )}
          {meta?.volume24hr != null && (
            <>24h 量 ${fmtUsd(meta.volume24hr)} · </>
          )}
          {meta?.liquidity != null && <>流动性 ${fmtUsd(meta.liquidity)} · </>}
          {hoursToEnd != null && hoursToEnd > 0 && (
            <>
              距结算{" "}
              {hoursToEnd < 48
                ? `${Math.round(hoursToEnd)}h`
                : `${Math.round(hoursToEnd / 24)}天`}
            </>
          )}
        </div>
      </header>

      {/* Current prices */}
      {meta && meta.outcomes.length > 0 && (
        <section className="kpi" style={{ marginBottom: "var(--s-4)" }}>
          {meta.outcomes.slice(0, 4).map((o, i) => (
            <StatCard key={o} label={`现价 · ${o}`}>
              <div className="kpi-value">
                {meta.outcomePrices[i] != null
                  ? fmtCents(meta.outcomePrices[i])
                  : "—"}
              </div>
            </StatCard>
          ))}
        </section>
      )}

      {/* Classification */}
      <section style={{ marginBottom: "var(--s-4)" }}>
        {cls.kind === "consensus" && (
          <div className="ds-callout">
            🔥 <b>聪明钱共识</b>：{cls.group.walletCount} 个白名单钱包买入{" "}
            <b>{cls.group.outcome}</b> · 合计净买入 $
            {fmtUsd(cls.group.totalNetUsd)} · 均价{" "}
            {fmtCents(cls.group.avgBuyPrice)}
          </div>
        )}
        {cls.kind === "disagreement" && (
          <div className="ds-callout">
            ⚖️ <b>聪明钱分歧</b>（
            {cls.market.tilt === "lopsided" ? "一边倒" : "势均力敌"}）：
            {cls.market.sides.map((s) => (
              <span key={s.outcome} style={{ marginRight: "var(--s-3)" }}>
                {s.outcome} {s.walletCount} 钱包 ${fmtUsd(s.netUsd)}
              </span>
            ))}
          </div>
        )}
        {cls.kind === "none" && (
          <div className="ds-hint">
            窗口内无聪明钱共识/分歧（阈值：≥2 白名单钱包各 ≥$5k 敞口）
          </div>
        )}
      </section>

      {/* Smart-money retained exposure */}
      <section style={{ marginBottom: "var(--s-4)" }}>
        <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
          🏆 聪明钱留存敞口（近 {win.hours}h · 净股数 × 买入均价）
        </div>
        {brief.smartFlow.length === 0 ? (
          <div className="ds-empty">窗口内无白名单钱包留仓</div>
        ) : (
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead>
                <tr>
                  <th>结果</th>
                  <th>钱包</th>
                  <th className="is-right">敞口</th>
                  <th className="is-right">买入均价</th>
                  <th className="is-right">评分/胜率</th>
                </tr>
              </thead>
              <tbody>
                {brief.smartFlow.flatMap((f) =>
                  f.wallets.map((w, i) => (
                    <tr key={`${f.outcome}:${w.wallet}`}>
                      <td>
                        {i === 0 ? (
                          <b>
                            {f.outcome} · ${fmtUsd(f.totalExposureUsd)}
                          </b>
                        ) : (
                          ""
                        )}
                      </td>
                      <td>
                        <WalletLink address={w.wallet}>
                          {shortWallet(w.wallet)}
                        </WalletLink>
                        {w.isMarketMaker && (
                          <span
                            className="muted"
                            title="做市机器人：池内保留但不计入共识/分歧投票"
                          >
                            {" "}
                            🤖
                          </span>
                        )}
                      </td>
                      <td className="mono is-right">
                        ${fmtUsd(w.exposureUsd)}
                      </td>
                      <td className="mono is-right">
                        {fmtCents(w.avgBuyPrice)}
                      </td>
                      <td className="mono is-right muted">
                        {w.score != null ? Math.round(w.score) : "—"}
                        {w.winRate != null
                          ? ` / ${Math.round(w.winRate * 100)}%`
                          : ""}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Split-buy accumulators */}
      <section style={{ marginBottom: "var(--s-4)" }}>
        <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
          🧩 拆单累计（≥3 笔 · 单笔 &lt;$10k · 敞口 ≥$2k）
        </div>
        {brief.accum.length === 0 ? (
          <div className="ds-empty">窗口内无拆单累计</div>
        ) : (
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead>
                <tr>
                  <th>钱包</th>
                  <th>结果</th>
                  <th className="is-right">敞口</th>
                  <th className="is-right">笔数</th>
                  <th className="is-right">均价</th>
                  <th>标记</th>
                </tr>
              </thead>
              <tbody>
                {brief.accum.map((g) => (
                  <tr key={`${g.wallet}:${g.outcome}`}>
                    <td>
                      <WalletLink address={g.wallet}>
                        {shortWallet(g.wallet)}
                      </WalletLink>
                    </td>
                    <td>{g.outcome}</td>
                    <td className="mono is-right">${fmtUsd(g.exposureUsd)}</td>
                    <td className="mono is-right">{g.buyCount}</td>
                    <td className="mono is-right">{fmtCents(g.avgBuyPrice)}</td>
                    <td className="muted">
                      {g.hedgeSuspect ? "对冲? " : ""}
                      {g.mmSuspect ? "做市?" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Fresh-wallet unusual flow */}
      <section style={{ marginBottom: "var(--s-4)" }}>
        <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
          🆕 新钱包异常流（账龄 ≤7 天 · 单笔 ≥$5k 买入）
        </div>
        {freshFlow.length === 0 ? (
          <div className="ds-empty">窗口内无新钱包大额买入</div>
        ) : (
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead>
                <tr>
                  <th>钱包</th>
                  <th className="is-right">账龄</th>
                  <th>结果</th>
                  <th className="is-right">金额</th>
                  <th className="is-right">价格</th>
                  <th className="is-right">时间</th>
                </tr>
              </thead>
              <tbody>
                {freshFlow.map((f) => (
                  <tr key={`${f.wallet}:${f.ts}`}>
                    <td>
                      <WalletLink address={f.wallet}>
                        {shortWallet(f.wallet)}
                      </WalletLink>
                    </td>
                    <td className="mono is-right">
                      🆕{" "}
                      {f.ageDays < 1
                        ? `${Math.round(f.ageDays * 24)}小时`
                        : `${Math.round(f.ageDays)}天`}
                    </td>
                    <td>{f.outcome}</td>
                    <td className="mono is-right">${fmtUsd(f.usd)}</td>
                    <td className="mono is-right">{fmtCents(f.price)}</td>
                    <td className="mono is-right muted">{fmtTime(f.ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Tool's own alert history */}
      <section style={{ marginBottom: "var(--s-4)" }}>
        <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
          📐 本工具告警史（90 天内 · 含验证结果）
        </div>
        {history.length === 0 ? (
          <div className="ds-empty">该市场暂无本工具告警</div>
        ) : (
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类型</th>
                  <th>方向</th>
                  <th className="is-right">金额</th>
                  <th className="is-right">价格</th>
                  <th className="is-right" title="信号后 1h / 24h 市场价">
                    1h / 24h
                  </th>
                  <th
                    className="is-right"
                    title="结算验证：✅ 命中 ❌ 反向 ➖ 平"
                  >
                    结算
                  </th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={i}>
                    <td className="mono muted">{fmtTime(h.createdAt)}</td>
                    <td>
                      {TYPE_ICON[h.type] ?? ""} {h.type}
                    </td>
                    <td>
                      {h.side === "SELL" ? "🔴卖" : "🟢买"} {h.outcome}
                    </td>
                    <td className="mono is-right">${fmtUsd(h.usd)}</td>
                    <td className="mono is-right">
                      {h.price != null ? fmtCents(h.price) : "—"}
                    </td>
                    <td className="mono is-right">
                      {h.price1h != null ? fmtCents(h.price1h) : "—"} /{" "}
                      {h.price24h != null ? fmtCents(h.price24h) : "—"}
                    </td>
                    <td className="is-right">
                      {!h.resolved
                        ? "…"
                        : h.won == null
                          ? "➖"
                          : h.won
                            ? "✅"
                            : "❌"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
