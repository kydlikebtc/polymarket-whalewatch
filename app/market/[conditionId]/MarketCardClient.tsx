"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { MarketSlugActions, StatCard, Tag, WalletLink } from "../../ui";
import { useLang } from "../../i18n";

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
  totalNetShares: number;
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
    /** 市场已终局结算 → 服务端已把 smartFlow 的敞口全部归零(见 lib/marketBrief)。 */
    settled: boolean;
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
const fmtShares = (v: number) => Math.round(v).toLocaleString("en-US");
const fmtCents = (p: number) => `${+(p * 100).toFixed(1)}¢`;
const fmtTime = (sec: number, locale: string) =>
  new Date(sec * 1000).toLocaleString(locale, { hour12: false });
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
  const { lang, t } = useLang();
  // 日期本地化:zh 沿用 zh-CN,en 用 en-US(格式随语言,数值不变)。
  const dtLocale = lang === "en" ? "en-US" : "zh-CN";

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
        <div className="ds-callout">
          {t("加载失败：")}
          {error}
        </div>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="ds-main">
        <div className="ds-empty">
          {t("聚合中…（拉取该市场 24h 成交并跑全部检测器）")}
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
          <Link href="/market">{t("🎯 市场信号卡")}</Link> ·{" "}
          {t("窗口近 {h}h · {n} 笔 ≥$500 成交", {
            h: win.hours,
            n: win.trades,
          })}
          {win.truncated ? t("（窗口触顶截断，指标为下界）") : ""}
        </div>
        <h1 style={{ fontSize: "var(--t-2xl)", marginBottom: "var(--s-1)" }}>
          {identity?.title ?? data.conditionId}
          {meta?.closed ? <Tag> {t("已结算")}</Tag> : null}
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
            <>{t("24h 量 ${v} · ", { v: fmtUsd(meta.volume24hr) })}</>
          )}
          {meta?.liquidity != null && (
            <>{t("流动性 ${v} · ", { v: fmtUsd(meta.liquidity) })}</>
          )}
          {hoursToEnd != null && hoursToEnd > 0 && (
            <>
              {t("距结算")}{" "}
              {hoursToEnd < 48
                ? `${Math.round(hoursToEnd)}h`
                : t("{n}天", { n: Math.round(hoursToEnd / 24) })}
            </>
          )}
        </div>
      </header>

      {/* Current prices */}
      {meta && meta.outcomes.length > 0 && (
        <section className="kpi" style={{ marginBottom: "var(--s-4)" }}>
          {meta.outcomes.slice(0, 4).map((o, i) => (
            <StatCard key={o} label={t("现价 · {o}", { o })}>
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
            🔥 <b>{t("聪明钱共识")}</b>
            {t("：{n} 个白名单钱包买入 ", { n: cls.group.walletCount })}
            <b>{cls.group.outcome}</b>
            {t(" · 合计净买入 ${v} · 均价 {p}", {
              v: fmtUsd(cls.group.totalNetUsd),
              p: fmtCents(cls.group.avgBuyPrice),
            })}
          </div>
        )}
        {cls.kind === "disagreement" && (
          <div className="ds-callout">
            ⚖️ <b>{t("聪明钱分歧")}</b>
            {t("（{tilt}）：", {
              tilt: t(cls.market.tilt === "lopsided" ? "一边倒" : "势均力敌"),
            })}
            {/* 结算后这个金额仍是真话,但只在「窗口内投入了多少」这层为真 ——
                裸 $ 会被读成「现在还押着这么多」,所以补上口径词。检测器本身
                不动(与告警链路共用),只改称谓。 */}
            {cls.market.sides.map((s) => (
              <span key={s.outcome} style={{ marginRight: "var(--s-3)" }}>
                {brief.settled
                  ? t("{o} {n} 钱包 · 窗口净买入 ${v}", {
                      o: s.outcome,
                      n: s.walletCount,
                      v: fmtUsd(s.netUsd),
                    })
                  : t("{o} {n} 钱包 ${v}", {
                      o: s.outcome,
                      n: s.walletCount,
                      v: fmtUsd(s.netUsd),
                    })}
              </span>
            ))}
          </div>
        )}
        {cls.kind === "none" && (
          <div className="ds-hint">
            {t("窗口内无聪明钱共识/分歧（阈值：≥2 白名单钱包各 ≥$5k 敞口）")}
          </div>
        )}
      </section>

      {/* Smart-money retained exposure — 结算后标题与口径都改写为「台账」,
          因为「留存」在结算后不成立(见 lib/marketBrief 结算闸门)。 */}
      <section style={{ marginBottom: "var(--s-4)" }}>
        <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
          {brief.settled
            ? t("🏆 聪明钱窗口台账（近 {h}h · 市场已结算）", { h: win.hours })
            : t("🏆 聪明钱留存敞口（近 {h}h · 净股数 × 买入均价）", {
                h: win.hours,
              })}
        </div>
        {brief.settled && (
          <div className="ds-hint" style={{ marginBottom: "var(--s-2)" }}>
            {t(
              "市场已结算——敞口一律归零。赎回（REDEEM）不走成交流水，无法从买卖推算，故不再声称任何仓位「仍持有」；下方净股数与买入均价仍是窗口内的成交事实。",
            )}
          </div>
        )}
        {brief.smartFlow.length === 0 ? (
          <div className="ds-empty">{t("窗口内无白名单钱包留仓")}</div>
        ) : (
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead>
                <tr>
                  <th>{t("结果")}</th>
                  <th>{t("钱包")}</th>
                  {/* 结算后这一列若还印 $0 就是一排废数字;换成净股数,
                      台账才留得住「谁押得最大」这个唯一还成立的事实。 */}
                  <th className="is-right">
                    {brief.settled ? t("窗口净股数") : t("敞口")}
                  </th>
                  <th className="is-right">{t("买入均价")}</th>
                  <th className="is-right">{t("评分/胜率")}</th>
                </tr>
              </thead>
              <tbody>
                {brief.smartFlow.flatMap((f) =>
                  f.wallets.map((w, i) => (
                    <tr key={`${f.outcome}:${w.wallet}`}>
                      <td>
                        {i === 0 ? (
                          <b>
                            {f.outcome} ·{" "}
                            {brief.settled
                              ? fmtShares(f.totalNetShares)
                              : `$${fmtUsd(f.totalExposureUsd)}`}
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
                            title={t(
                              "做市机器人：池内保留但不计入共识/分歧投票",
                            )}
                          >
                            {" "}
                            🤖
                          </span>
                        )}
                      </td>
                      <td className="mono is-right">
                        {brief.settled
                          ? fmtShares(w.netShares)
                          : `$${fmtUsd(w.exposureUsd)}`}
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

      {/* Split-buy accumulators — 结算后只是改称谓:「拆单买入」是窗口内的
          行为观察,结算改变不了它;不成立的只有「敞口(still held)」这个词。 */}
      <section style={{ marginBottom: "var(--s-4)" }}>
        <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
          {brief.settled
            ? t("🧩 拆单累计（≥3 笔 · 单笔 <$10k · 窗口净买入 ≥$2k）")
            : t("🧩 拆单累计（≥3 笔 · 单笔 <$10k · 敞口 ≥$2k）")}
        </div>
        {brief.accum.length === 0 ? (
          <div className="ds-empty">{t("窗口内无拆单累计")}</div>
        ) : (
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead>
                <tr>
                  <th>{t("钱包")}</th>
                  <th>{t("结果")}</th>
                  <th className="is-right">
                    {brief.settled ? t("窗口净买入") : t("敞口")}
                  </th>
                  <th className="is-right">{t("笔数")}</th>
                  <th className="is-right">{t("均价")}</th>
                  <th>{t("标记")}</th>
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
                      {g.hedgeSuspect ? t("对冲? ") : ""}
                      {g.mmSuspect ? t("做市?") : ""}
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
          {t("🆕 新钱包异常流（账龄 ≤7 天 · 单笔 ≥$5k 买入）")}
        </div>
        {freshFlow.length === 0 ? (
          <div className="ds-empty">{t("窗口内无新钱包大额买入")}</div>
        ) : (
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead>
                <tr>
                  <th>{t("钱包")}</th>
                  <th className="is-right">{t("账龄")}</th>
                  <th>{t("结果")}</th>
                  <th className="is-right">{t("金额")}</th>
                  <th className="is-right">{t("价格")}</th>
                  <th className="is-right">{t("时间")}</th>
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
                        ? t("{n}小时", { n: Math.round(f.ageDays * 24) })
                        : t("{n}天", { n: Math.round(f.ageDays) })}
                    </td>
                    <td>{f.outcome}</td>
                    <td className="mono is-right">${fmtUsd(f.usd)}</td>
                    <td className="mono is-right">{fmtCents(f.price)}</td>
                    <td className="mono is-right muted">
                      {fmtTime(f.ts, dtLocale)}
                    </td>
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
          {t("📐 本工具告警史（90 天内 · 含验证结果）")}
        </div>
        {history.length === 0 ? (
          <div className="ds-empty">{t("该市场暂无本工具告警")}</div>
        ) : (
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead>
                <tr>
                  <th>{t("时间")}</th>
                  <th>{t("类型")}</th>
                  <th>{t("方向")}</th>
                  <th className="is-right">{t("金额")}</th>
                  <th className="is-right">{t("价格")}</th>
                  <th className="is-right" title={t("信号后 1h / 24h 市场价")}>
                    1h / 24h
                  </th>
                  <th
                    className="is-right"
                    title={t("结算验证：✅ 命中 ❌ 反向 ➖ 平")}
                  >
                    {t("结算")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={i}>
                    <td className="mono muted">
                      {fmtTime(h.createdAt, dtLocale)}
                    </td>
                    <td>
                      {TYPE_ICON[h.type] ?? ""} {h.type}
                    </td>
                    <td>
                      {h.side === "SELL" ? t("🔴卖") : t("🟢买")} {h.outcome}
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

      {/* 🕰 复盘(2026-08-28 八件套):点击才拉曲线 —— 市场卡自身零上游的
          纪律不被稀释;曲线不可变,服务端 10 分钟缓存按市场去重。 */}
      <ReplaySection conditionId={conditionId} />
    </main>
  );
}

type ReplayMarkerView = {
  ts: number;
  type: string;
  side: "BUY" | "SELL";
  price: number;
  usd: number;
  outcome: string | null;
  mappedFromOtherSide: boolean;
};
type ReplayData = {
  outcome: string | null;
  binary: boolean;
  closed: boolean;
  resolutionPrice: number | null;
  startTs: number;
  endTs: number;
  series: { t: number; p: number }[];
  markers: ReplayMarkerView[];
  error?: string;
};

const MARKER_COLOR: Record<string, string> = {
  large: "#8a8a8a",
  smart: "#d99a2b",
  consensus: "#d0454c",
  cohort: "#3f9d63",
};

function ReplaySection({ conditionId }: { conditionId: string }) {
  const { t } = useLang();
  const [state, setState] = useState<{
    loading: boolean;
    data: ReplayData | null;
    error: string | null;
  }>({ loading: false, data: null, error: null });

  const load = async () => {
    setState({ loading: true, data: null, error: null });
    try {
      const res = await fetch(`/api/market/${conditionId}/replay`);
      const json = (await res.json()) as ReplayData;
      if (!res.ok || json.error) {
        setState({
          loading: false,
          data: null,
          error: json.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      setState({ loading: false, data: json, error: null });
    } catch (e) {
      setState({
        loading: false,
        data: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const d = state.data;
  return (
    <section style={{ marginTop: "var(--s-5)" }}>
      <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
        {t("🕰 复盘（价格曲线 × 本站告警 × 结算）")}
      </div>
      {!d && (
        <div>
          <button
            className="ds-btn ds-btn--sm"
            disabled={state.loading}
            onClick={() => void load()}
          >
            {state.loading ? t("加载中…") : t("加载复盘（拉一次价格曲线）")}
          </button>
          {state.error && (
            <span
              className="ds-hint"
              style={{ marginLeft: "var(--s-3)", color: "var(--warn-700)" }}
            >
              {t("加载失败：{err}", { err: state.error })}
            </span>
          )}
        </div>
      )}
      {d && d.series.length > 0 && (
        <>
          <ReplayChart d={d} />
          <div className="ds-hint muted" style={{ marginTop: "var(--s-2)" }}>
            {t("曲线为 {o} 一侧的价格。", { o: d.outcome ?? "index 0" })}{" "}
            {d.binary
              ? t("另一侧的告警按 1−p 精确映射到同一坐标（标记带 ↔）。")
              : t(
                  "非二元市场：只显示第一结果一侧的告警，其余边无等价映射。",
                )}{" "}
            {d.closed && d.resolutionPrice != null ? t("虚线为结算价。") : ""}
            {t("标记色：💰大单 🏆聪明钱 🔥共识 🐣同批新钱包。")}
          </div>
        </>
      )}
      {d && d.series.length === 0 && (
        <div className="ds-hint">
          {t("该区间没有价格历史点（市场太新或曲线不可用）。")}
        </div>
      )}
    </section>
  );
}

function ReplayChart({ d }: { d: ReplayData }) {
  const W = 720;
  const H = 220;
  const PAD = { l: 42, r: 10, t: 10, b: 22 };
  const t0 = d.startTs;
  const t1 = Math.max(d.endTs, t0 + 1);
  const ys = [
    ...d.series.map((s) => s.p),
    ...d.markers.map((m) => m.price),
    ...(d.resolutionPrice != null ? [d.resolutionPrice] : []),
  ];
  const yMin = Math.max(0, Math.min(...ys) - 0.05);
  const yMax = Math.min(1, Math.max(...ys) + 0.05);
  const x = (ts: number) =>
    PAD.l + ((ts - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (p: number) =>
    PAD.t +
    (1 - (p - yMin) / Math.max(1e-9, yMax - yMin)) * (H - PAD.t - PAD.b);
  const points = d.series
    .map((s) => `${x(s.t).toFixed(1)},${y(s.p).toFixed(1)}`)
    .join(" ");
  const dayLabel = (ts: number) => {
    const dt = new Date(ts * 1000);
    return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
  };
  const ticks = [t0, t0 + (t1 - t0) / 3, t0 + (2 * (t1 - t0)) / 3, t1];
  return (
    <div className="ds-table-wrap">
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="market replay"
      >
        {[yMin, (yMin + yMax) / 2, yMax].map((p) => (
          <g key={p}>
            <line
              x1={PAD.l}
              y1={y(p)}
              x2={W - PAD.r}
              y2={y(p)}
              stroke="currentColor"
              opacity={0.12}
            />
            <text
              x={PAD.l - 6}
              y={y(p) + 4}
              textAnchor="end"
              fontSize={11}
              fill="currentColor"
              opacity={0.6}
            >
              {(p * 100).toFixed(0)}¢
            </text>
          </g>
        ))}
        {ticks.map((ts) => (
          <text
            key={ts}
            x={x(ts)}
            y={H - 6}
            textAnchor="middle"
            fontSize={11}
            fill="currentColor"
            opacity={0.6}
          >
            {dayLabel(ts)}
          </text>
        ))}
        {d.resolutionPrice != null && (
          <line
            x1={PAD.l}
            y1={y(d.resolutionPrice)}
            x2={W - PAD.r}
            y2={y(d.resolutionPrice)}
            stroke="currentColor"
            strokeDasharray="4 4"
            opacity={0.5}
          />
        )}
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          opacity={0.85}
        />
        {d.markers.map((m, i) => (
          <circle
            key={i}
            cx={x(Math.min(Math.max(m.ts, t0), t1))}
            cy={y(m.price)}
            r={4}
            fill={MARKER_COLOR[m.type] ?? "#8a8a8a"}
            stroke="white"
            strokeWidth={1}
          >
            <title>
              {`${m.type} · ${m.side} · ${(m.price * 100).toFixed(1)}¢ · $${Math.round(m.usd).toLocaleString("en-US")}${m.mappedFromOtherSide ? " · ↔" : ""}`}
            </title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
