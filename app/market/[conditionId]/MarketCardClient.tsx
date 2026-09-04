"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { MarketSlugActions, StatCard, Tag, WalletLink } from "../../ui";
import { useLang } from "../../i18n";
import { catLabel, subLabel } from "../../../lib/categoryLabel";
import type { PulseBoardTag } from "../../../lib/marketPulse";

// 市场脉搏标签条(2026-08-31)。与 /pulse 的榜单行同一套视觉语言,刻意不另起
// 一套:分类用 --brand、本站的判断用 --warn、涨跌色 --up/--down 谁都不占。
// 读者在脉搏页看到的 chip 和在这里点进来看到的必须长一样,否则「同一个市场」
// 这件事就得靠标题去对。
//
// ⚠️ 时间口径与卡片其余部分不同:卡片其余字段是**此刻**的成交窗口,榜单标记是
// `day` 那个**已收盘的完整 UTC 日**。这个差别写在 title 里,不靠读者猜。
function PulseTags({ pulse }: { pulse: NonNullable<Payload["pulse"]> }) {
  const { t } = useLang();
  const primary = pulse.category != null ? t(catLabel(pulse.category)) : null;
  const sub = pulse.subcategory != null ? t(subLabel(pulse.subcategory)) : null;
  const boardLabel = (k: PulseBoardTag): string =>
    k === "anomaly"
      ? t("异常")
      : k === "divergence"
        ? t("分歧")
        : k === "ghost"
          ? t("无鲸")
          : t("洗量");
  if (primary == null && pulse.boards.length === 0) return null;
  // 返回片段而不是自带包裹:对齐交给外层那一行 flex 统一管。带 title 的
  // tooltip 包裹层必须也是 inline-flex —— 普通 span 作为 flex item 会按自己的
  // 行盒撑高,与直接放进去的 <Tag> 差出几像素(实测三种对齐上下文差 6.5px)。
  const tip = (key: string, title: string, node: ReactNode) => (
    <span key={key} title={title} style={{ display: "inline-flex" }}>
      {node}
    </span>
  );
  return (
    <>
      {primary != null && <Tag variant="brand">{primary}</Tag>}
      {sub != null && sub !== primary && <Tag>{sub}</Tag>}
      {pulse.boards.map((k) =>
        tip(
          k,
          t("{d}（UTC）的市场脉搏日榜判定，不是此刻窗口", { d: pulse.day }),
          <Tag variant="warn">{boardLabel(k)}</Tag>,
        ),
      )}
      {pulse.anomalyScore != null &&
        tip(
          "score",
          t("{d}（UTC）异常分 {s}/100", {
            d: pulse.day,
            s: pulse.anomalyScore,
          }),
          <Tag variant="warn">
            {t("异常分 {s}", { s: pulse.anomalyScore })}
          </Tag>,
        )}
    </>
  );
}

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
  /** 市场脉搏视角(2026-08-31 additive)。旧缓存/旧部署可能没有这个键,
   *  故标可选 —— 与 /pulse 对 ghosts/washTop 同一套渲染侧防御。 */
  pulse?: {
    day: string;
    category: string | null;
    subcategory: string | null;
    boards: PulseBoardTag[];
    anomalyScore: number | null;
  } | null;
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
// 变化写成 `41.9 → 44.1¢`(§1 数字格式):区间里只有末位带单位,前一位裸数字。
const fmtCentsNum = (p: number) => `${+(p * 100).toFixed(1)}`;
const fmtTime = (sec: number, locale: string) =>
  new Date(sec * 1000).toLocaleString(locale, { hour12: false });
const shortWallet = (w: string) =>
  w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;

// 信号类型的中文名 —— emoji 不裸放在正文里,收进灰底名称标签(§1)。
// 措辞与译文沿用 /wallet 档案页的同一张表(键已在 wallet 分片),两页说同
// 一件事就不该有两套说法;未知类型回退原始 type 串,不编造名字。
const TYPE_LABEL: Record<string, string> = {
  large: "💰 大单",
  smart: "🏆 聪明钱",
  consensus: "🔥 共识",
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
        <div className="ds-callout ds-callout--error">
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
  // 窗口留存敞口 KPI —— 就是下面 02 表按结果分组的合计,没有第二个口径。
  // 结算后服务端已把敞口归零(见 lib/marketBrief),那时这一格不出现。
  const exposureTotal = brief.smartFlow.reduce(
    (s, f) => s + f.totalExposureUsd,
    0,
  );
  const showExposureKpi = !brief.settled && exposureTotal > 0;
  // KPI 用的几个只读投影 —— 只为把 meta 的可空性收在一处,取值口径不变。
  const outcomes = meta?.outcomes ?? [];
  const prices = meta?.outcomePrices ?? [];
  const vol24h = meta?.volume24hr ?? null;
  const liquidity = meta?.liquidity ?? null;
  // 现价格里哪一侧是聪明钱站的那一侧 —— 蓝 = 当前选中(§2.1),纯展示派生。
  const smartSide = cls.kind === "consensus" ? cls.group.outcome : null;
  // 24h 量那一格的副行(设计稿 12 第 52 行:「流动性 $412,300 · 距结算 9 天」)。
  // 三个读数各自独立成条件、在这里拼:gamma 常见 volume24hr 为空而 liquidity
  // 有值(新市场/低活跃市场),把副行挂在主值上会让流动性与距结算一起消失 ——
  // 那是改版前没有的信息损失。主值缺就印「—」(判不了,不是 0,§1.2)。
  const volSubBits = [
    liquidity != null ? t("流动性 ${v}", { v: fmtUsd(liquidity) }) : null,
    hoursToEnd != null && hoursToEnd > 0
      ? `${t("距结算")} ${
          hoursToEnd < 48
            ? `${Math.round(hoursToEnd)}h`
            : t("{n}天", { n: Math.round(hoursToEnd / 24) })
        }`
      : null,
  ].filter((s): s is string => s != null);
  const showVolCell = vol24h != null || volSubBits.length > 0;
  const pulseBoardTagged =
    data.pulse != null &&
    (data.pulse.boards.length > 0 || data.pulse.anomalyScore != null);

  return (
    <main className="ds-main">
      {/* 页头 —— 12px 小标(带 emoji 前缀)· 24/600 标题 · 标签与 slug 同一行。
          align-items 覆盖成 flex-start:这一页的页头左栏会长到三四行(市场名
          可能换行),底对齐会把小标推得离标题很远。 */}
      <header className="page-head" style={{ alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div className="page-head__eyebrow">
            <Link href="/market">{t("🎯 市场信号卡")}</Link>
            <span aria-hidden>·</span>
            <span>
              {t("窗口近 {h}h · {n} 笔 ≥$500 成交", {
                h: win.hours,
                n: win.trades,
              })}
            </span>
          </div>
          {/* 市场名永不截断(§1.1):换行,顶对齐 */}
          <h1 className="page-head__title" style={{ overflowWrap: "anywhere" }}>
            {identity?.title ?? data.conditionId}
          </h1>
          {/* 标签自成一行,不塞进 h1。h1 是 24px 字号,而 .ds-tag 固定 22px 高:
              塞进去就有三套并存的对齐上下文(裸 Tag 按基线、包裹层按
              vertical-align、tooltip 那层又按 flex item),实测垂直中心差 6.5px。
              单独一行 + align-items:center 一次性消掉。slug 与口径句一并收进
              这一行(设计稿 12):页头下面紧跟 KPI,不再留一条孤零零的灰行。 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "var(--s-2)",
              marginTop: "var(--s-2)",
              fontSize: "var(--t-sm)",
              color: "var(--ww-text-muted)",
            }}
          >
            {meta?.closed && <Tag>{t("已结算")}</Tag>}
            {data.pulse && <PulseTags pulse={data.pulse} />}
            {/* 口径先行:榜单标记是已收盘那个 UTC 日的判定,不是此刻窗口。
                原来只写在 tooltip 里,触屏读者看不到 —— 提到明面上。 */}
            {pulseBoardTagged && data.pulse && (
              <span>
                {t("{d}（UTC）的市场脉搏日榜判定，不是此刻窗口", {
                  d: data.pulse.day,
                })}
              </span>
            )}
            {identity && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--s-1)",
                  minWidth: 0,
                  color: "var(--ww-link)",
                  overflowWrap: "anywhere",
                }}
              >
                {identity.slug}
                <MarketSlugActions
                  slug={identity.slug}
                  eventSlug={identity.eventSlug}
                />
              </span>
            )}
          </div>
        </div>
        {/* 页头右侧动作钮(设计稿 12 第 27 行 / readme §5 页壳第 2 条:页头带
            右侧动作)—— 32px 描边钮,去 Polymarket 看原市场。地址走全站同一条
            约定 polymarket.com/event/ + eventSlug(扫描页/共识页/钱包档案都是
            它),不新造链接口径。刻意不是主按钮:本屏唯一那颗蓝底主按钮是 01 段
            的「拉一次价格曲线」(每屏至多一个)。 */}
        {identity?.eventSlug && (
          <a
            className="ds-btn"
            href={`https://polymarket.com/event/${identity.eventSlug}`}
            target="_blank"
            rel="noreferrer"
            title={t("在 Polymarket 打开这个市场")}
            style={{ textDecoration: "none", flex: "0 0 auto" }}
          >
            Polymarket ↗
          </a>
        )}
      </header>

      {/* 统计声明放数据前面(§5 口径条),不放脚注 */}
      {win.truncated && (
        <div
          className="ds-callout ds-callout--warn"
          style={{ marginBottom: "var(--s-5)" }}
        >
          {t(
            "窗口触顶截断：该市场窗口内的成交超过分页上限，下方所有计数与金额都是下界。",
          )}
        </div>
      )}

      {/* KPI 分格卡 —— 现价各一格 + 24h 量 + 窗口留存敞口 */}
      {(outcomes.length > 0 || showVolCell || showExposureKpi) && (
        <section className="kpi" style={{ marginBottom: "var(--s-4)" }}>
          {outcomes.slice(0, 4).map((o, i) => {
            const isSmart = smartSide != null && smartSide === o;
            return (
              <StatCard
                key={o}
                icon={isSmart ? "🔵" : "⚪"}
                label={t("现价 · {o}", { o })}
              >
                <div
                  className="kpi-value"
                  style={isSmart ? { color: "var(--ww-link)" } : undefined}
                >
                  {prices[i] != null ? (
                    fmtCents(prices[i])
                  ) : (
                    // 「—」是判不了(缺 asset 不可取价),不是 0（§1.2）
                    <span className="faint">—</span>
                  )}
                </div>
                {isSmart && <div className="kpi-sub">{t("聪明钱这一侧")}</div>}
              </StatCard>
            );
          })}
          {showVolCell && (
            <StatCard icon="💰" label={t("24h 量")}>
              <div className="kpi-value">
                {vol24h != null ? (
                  `$${fmtUsd(vol24h)}`
                ) : (
                  <span className="faint">—</span>
                )}
              </div>
              {volSubBits.length > 0 && (
                <div className="kpi-sub">{volSubBits.join(" · ")}</div>
              )}
            </StatCard>
          )}
          {showExposureKpi && (
            <StatCard icon="🏆" label={t("窗口留存敞口")}>
              <div className="kpi-value">${fmtUsd(exposureTotal)}</div>
              <div className="kpi-sub">
                {brief.smartFlow
                  .map(
                    (f) =>
                      `${f.outcome} ${Math.round(
                        (f.totalExposureUsd / exposureTotal) * 100,
                      )}%`,
                  )
                  .join(" / ")}
              </div>
            </StatCard>
          )}
        </section>
      )}

      {/* 共识 / 分歧判定条 —— 一张白卡:徽章担语义色,句子担事实,
          右侧灰底名称标签列出参与的钱包与评分。 */}
      <section style={{ marginBottom: "var(--s-4)" }}>
        <div
          className="ds-card"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--s-3)",
            flexWrap: "wrap",
            padding: "14px var(--s-4)",
            fontSize: "var(--t-md)",
          }}
        >
          {cls.kind === "consensus" && (
            <>
              <Tag variant="up">{t("🔥 共识")}</Tag>
              <span>
                <span style={{ fontWeight: 600 }}>
                  {t("{n} 个白名单钱包买入 {o}", {
                    n: cls.group.walletCount,
                    o: cls.group.outcome,
                  })}
                </span>
                {t(" · 合计净买入 ${v} · 均价 {p}", {
                  v: fmtUsd(cls.group.totalNetUsd),
                  p: fmtCents(cls.group.avgBuyPrice),
                })}
              </span>
              <span
                style={{
                  display: "flex",
                  gap: "var(--s-1)",
                  marginLeft: "auto",
                  flexWrap: "wrap",
                }}
              >
                {cls.group.wallets.map((w) =>
                  w.score != null ? (
                    <Tag key={w.wallet}>
                      {shortWallet(w.wallet)} · {Math.round(w.score)}
                    </Tag>
                  ) : (
                    // 没有评分的那一枚整枚压暗(设计稿 12)。灰底标签本身不表示
                    // 状态,这里压暗的是字:「—」是判不了、不是 0 分,与旁边那些
                    // 真有分数的标签同亮度会被读成「评分等于 —」。
                    <span
                      key={w.wallet}
                      className="ds-tag"
                      style={{ color: "var(--ww-text-muted)" }}
                    >
                      {shortWallet(w.wallet)} · —
                    </span>
                  ),
                )}
              </span>
            </>
          )}
          {cls.kind === "disagreement" && (
            <>
              <Tag>{t("⚖️ 分歧")}</Tag>
              <span>
                <span style={{ fontWeight: 600 }}>
                  {cls.market.tilt === "lopsided" ? t("一边倒") : t("势均力敌")}
                </span>
                {" · "}
                {/* 结算后这个金额仍是真话,但只在「窗口内投入了多少」这层为真
                    —— 裸 $ 会被读成「现在还押着这么多」,所以补上口径词。
                    检测器本身不动(与告警链路共用),只改称谓。 */}
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
              </span>
            </>
          )}
          {cls.kind === "none" && (
            <span className="muted">
              {t("窗口内无聪明钱共识/分歧（阈值：≥2 白名单钱包各 ≥$5k 敞口）")}
            </span>
          )}
        </div>
        {cls.kind !== "none" && (
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            {t("🤖 做市机器人不计入共识投票")}
          </div>
        )}
      </section>

      {/* 01 复盘 —— 点击才拉曲线,市场卡自身零上游的纪律不被稀释;
          曲线不可变,服务端 10 分钟缓存按市场去重。 */}
      <ReplaySection conditionId={conditionId} />

      {/* 02 Smart-money retained exposure — 结算后标题与口径都改写为「台账」,
          因为「留存」在结算后不成立(见 lib/marketBrief 结算闸门)。 */}
      <section style={{ marginBottom: "var(--s-4)" }}>
        {/* 口径条放数据前面(§5),不放脚注 */}
        {brief.settled && (
          <div
            className="ds-callout ds-callout--warn"
            style={{ marginBottom: "var(--s-3)" }}
          >
            {t(
              "市场已结算——敞口一律归零。赎回（REDEEM）不走成交流水，无法从买卖推算，故不再声称任何仓位「仍持有」；下方净股数与买入均价仍是窗口内的成交事实。",
            )}
          </div>
        )}
        <div className="ds-card" style={{ overflow: "hidden" }}>
          <SectionBar
            n="02"
            title={brief.settled ? t("聪明钱窗口台账") : t("聪明钱留存敞口")}
            note={
              brief.settled
                ? t("近 {h}h · 市场已结算", { h: win.hours })
                : t("近 {h}h · 净股数 × 买入均价", { h: win.hours })
            }
          />
          {brief.smartFlow.length === 0 ? (
            <div className="ds-empty" style={{ border: 0, borderRadius: 0 }}>
              {t("窗口内无白名单钱包留仓")}
            </div>
          ) : (
            <div
              className="ds-table-wrap"
              style={{ border: 0, borderRadius: 0, boxShadow: "none" }}
            >
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
                        {/* 组首行才印结果与合计;行内不加粗,层级靠分格线 */}
                        <td data-label={t("结果")}>
                          {i === 0 ? (
                            <>
                              {f.outcome}{" "}
                              <span className="muted">
                                {brief.settled
                                  ? fmtShares(f.totalNetShares)
                                  : `$${fmtUsd(f.totalExposureUsd)}`}
                              </span>
                            </>
                          ) : (
                            ""
                          )}
                        </td>
                        <td data-label={t("钱包")}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "var(--s-2)",
                            }}
                          >
                            <WalletLink address={w.wallet}>
                              {shortWallet(w.wallet)}
                            </WalletLink>
                            {w.isMarketMaker && (
                              <span
                                title={t(
                                  "做市机器人：池内保留但不计入共识/分歧投票",
                                )}
                                style={{ display: "inline-flex" }}
                              >
                                <Tag variant="warn">{t("🤖 做市")}</Tag>
                              </span>
                            )}
                          </span>
                        </td>
                        <td
                          className="mono is-right"
                          data-label={
                            brief.settled ? t("窗口净股数") : t("敞口")
                          }
                        >
                          {brief.settled
                            ? fmtShares(w.netShares)
                            : `$${fmtUsd(w.exposureUsd)}`}
                        </td>
                        <td
                          className="mono is-right"
                          data-label={t("买入均价")}
                        >
                          {fmtCents(w.avgBuyPrice)}
                        </td>
                        {/* 评分/胜率与敞口、买入均价同亮度(设计稿 12 第 79-82
                            行是 #081d35 正文色):这一列是「这个钱包值不值得
                            跟」的判断依据,压暗会让它比左边的数字弱一档。 */}
                        <td
                          className="mono is-right"
                          data-label={t("评分/胜率")}
                        >
                          {w.score != null ? (
                            Math.round(w.score)
                          ) : (
                            <span className="faint">—</span>
                          )}
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
        </div>
      </section>

      {/* 03 Split-buy accumulators — 结算后只是改称谓:「拆单买入」是窗口内的
          行为观察,结算改变不了它;不成立的只有「敞口(still held)」这个词。 */}
      <section style={{ marginBottom: "var(--s-4)" }}>
        <div className="ds-card" style={{ overflow: "hidden" }}>
          <SectionBar
            n="03"
            title={t("拆单累计")}
            note={
              brief.settled
                ? t("≥3 笔 · 单笔 <$10k · 窗口净买入 ≥$2k")
                : t("≥3 笔 · 单笔 <$10k · 敞口 ≥$2k")
            }
          />
          {brief.accum.length === 0 ? (
            <div className="ds-empty" style={{ border: 0, borderRadius: 0 }}>
              {t("窗口内无拆单累计")}
            </div>
          ) : (
            <div
              className="ds-table-wrap"
              style={{ border: 0, borderRadius: 0, boxShadow: "none" }}
            >
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
                    <th className="is-right">{t("标记")}</th>
                  </tr>
                </thead>
                <tbody>
                  {brief.accum.map((g) => (
                    <tr key={`${g.wallet}:${g.outcome}`}>
                      <td data-label={t("钱包")}>
                        <WalletLink address={g.wallet}>
                          {shortWallet(g.wallet)}
                        </WalletLink>
                      </td>
                      <td data-label={t("结果")}>{g.outcome}</td>
                      <td
                        className="mono is-right"
                        data-label={brief.settled ? t("窗口净买入") : t("敞口")}
                      >
                        ${fmtUsd(g.exposureUsd)}
                      </td>
                      <td className="mono is-right" data-label={t("笔数")}>
                        {g.buyCount}
                      </td>
                      <td className="mono is-right" data-label={t("均价")}>
                        {fmtCents(g.avgBuyPrice)}
                      </td>
                      {/* 标记 = 需留神的口径 → 琥珀描边(§2.1) */}
                      <td className="is-right" data-label={t("标记")}>
                        <span
                          style={{
                            display: "inline-flex",
                            gap: "var(--s-1)",
                            justifyContent: "flex-end",
                            flexWrap: "wrap",
                          }}
                        >
                          {g.hedgeSuspect && (
                            <Tag variant="warn">{t("疑似对冲")}</Tag>
                          )}
                          {g.mmSuspect && (
                            <Tag variant="warn">{t("🤖 疑似做市")}</Tag>
                          )}
                          {!g.hedgeSuspect && !g.mmSuspect && (
                            <span className="faint">·</span>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* 04 Fresh-wallet unusual flow */}
      <section style={{ marginBottom: "var(--s-4)" }}>
        <div className="ds-card" style={{ overflow: "hidden" }}>
          <SectionBar
            n="04"
            title={t("新钱包异常流")}
            note={t("账龄 ≤7 天 · 单笔 ≥$5k 买入")}
          />
          {freshFlow.length === 0 ? (
            <div className="ds-empty" style={{ border: 0, borderRadius: 0 }}>
              {t("窗口内无新钱包大额买入")}
            </div>
          ) : (
            <div
              className="ds-table-wrap"
              style={{ border: 0, borderRadius: 0, boxShadow: "none" }}
            >
              <table className="ds-table">
                <thead>
                  <tr>
                    <th>{t("钱包")}</th>
                    <th>{t("账龄")}</th>
                    <th>{t("结果")}</th>
                    <th className="is-right">{t("金额")}</th>
                    <th className="is-right">{t("价格")}</th>
                    <th className="is-right">{t("时间")}</th>
                  </tr>
                </thead>
                <tbody>
                  {freshFlow.map((f) => (
                    <tr key={`${f.wallet}:${f.ts}`}>
                      <td data-label={t("钱包")}>
                        <WalletLink address={f.wallet}>
                          {shortWallet(f.wallet)}
                        </WalletLink>
                      </td>
                      {/* 新钱包 = 需留神的口径 → 琥珀描边,emoji 收在标签内 */}
                      <td data-label={t("账龄")}>
                        <Tag variant="warn">
                          🆕{" "}
                          {f.ageDays < 1
                            ? t("{n}小时", { n: Math.round(f.ageDays * 24) })
                            : t("{n}天", { n: Math.round(f.ageDays) })}
                        </Tag>
                      </td>
                      <td data-label={t("结果")}>{f.outcome}</td>
                      <td className="mono is-right" data-label={t("金额")}>
                        ${fmtUsd(f.usd)}
                      </td>
                      <td className="mono is-right" data-label={t("价格")}>
                        {fmtCents(f.price)}
                      </td>
                      <td
                        className="mono is-right muted"
                        data-label={t("时间")}
                      >
                        {fmtTime(f.ts, dtLocale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* 05 Tool's own alert history */}
      <section style={{ marginBottom: "var(--s-4)" }}>
        <div className="ds-card" style={{ overflow: "hidden" }}>
          <SectionBar
            n="05"
            title={t("本工具告警史")}
            note={t("90 天内 · 含验证结果")}
          />
          {history.length === 0 ? (
            <div className="ds-empty" style={{ border: 0, borderRadius: 0 }}>
              {t("该市场暂无本工具告警")}
            </div>
          ) : (
            <>
              <div
                className="ds-table-wrap"
                style={{ border: 0, borderRadius: 0, boxShadow: "none" }}
              >
                <table className="ds-table">
                  <thead>
                    <tr>
                      <th>{t("时间")}</th>
                      <th>{t("类型")}</th>
                      <th>{t("方向")}</th>
                      <th className="is-right">{t("金额")}</th>
                      <th className="is-right">{t("价格")}</th>
                      <th
                        className="is-right"
                        title={t("信号后 1h / 24h 市场价")}
                      >
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
                        <td className="mono muted" data-label={t("时间")}>
                          {fmtTime(h.createdAt, dtLocale)}
                        </td>
                        {/* 信号类型 = 名称标签(灰底，不表示状态)，emoji 收在标签内 */}
                        <td data-label={t("类型")}>
                          <Tag>{t(TYPE_LABEL[h.type] ?? h.type)}</Tag>
                        </td>
                        {/* 方向是金融含义：BUY 绿 / SELL 红（§2.1） */}
                        <td data-label={t("方向")}>
                          <span className={h.side === "SELL" ? "down" : "up"}>
                            {h.side} · {h.outcome}
                          </span>
                        </td>
                        <td className="mono is-right" data-label={t("金额")}>
                          ${fmtUsd(h.usd)}
                        </td>
                        <td className="mono is-right" data-label={t("价格")}>
                          {h.price != null ? (
                            fmtCents(h.price)
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                        {/* 变化写成 41.9 → 44.1¢（§1 数字格式）。这一列不上
                            涨绿跌红：它是「信号发出后市场怎么走」的读数，
                            方向判定归右边的结算徽章。 */}
                        <td className="mono is-right" data-label="1h / 24h">
                          {h.price1h != null ? (
                            fmtCentsNum(h.price1h)
                          ) : (
                            <span className="faint">—</span>
                          )}
                          {" → "}
                          {h.price24h != null ? (
                            fmtCents(h.price24h)
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                        <td className="is-right" data-label={t("结算")}>
                          {!h.resolved ? (
                            // 「还没到结果」不是一种判定 —— 压暗的灰底标签,
                            // 与 ✅/❌ 那两枚有语义色的判定分开(设计稿 12)。
                            <span
                              className="ds-tag"
                              style={{ color: "var(--ww-text-muted)" }}
                            >
                              {t("待结算")}
                            </span>
                          ) : h.won == null ? (
                            <Tag>{t("➖ 平")}</Tag>
                          ) : h.won ? (
                            <Tag variant="up">{t("✅ 命中")}</Tag>
                          ) : (
                            <Tag variant="down">{t("❌ 反向")}</Tag>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* 「—」是判不了，不是 0 —— 三种成因写在表下方的琥珀条里（§1.2） */}
              <div className="note-strip note-strip--warn">
                {t(
                  "「—」是判不了，不是 0：价格一栏为空表示该信号缺 asset、当时取不到价；1h / 24h 为空表示那个时点还没有价格历史（信号太新或曲线不可用）。",
                )}
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

// 卡内标题条 —— 「段号 段名」（14/600 主文字色，段号与段名同级）+ 口径后缀
// （14/400 muted，带「·」前导）。五段共用一个,编号是设计稿「五段式信号卡」
// 的骨架:读者数得清自己看到第几段。设计稿 12 第 77/85/91/96 行是一整串 600
// 的「02 聪明钱留存敞口」,只有口径后缀嵌套成 400 muted —— 段号不压暗,压暗
// 会把一个标题读成「灰 02」+「黑 段名」两级。
// 口径不并进段名:段名是这一段叫什么,口径是它按什么口径算,两件事在设计稿里
// 就是 600 与 400 两个字重(层级不靠字号跳档)。
// 段名不带 emoji —— emoji 只收在灰底名称标签 / KPI 图标位 / 12px 小标前缀
// 三处(readme §1),14px 标题条不在其中;这五段的 emoji 在落地页的 KPI 图标位。
function SectionBar({
  n,
  title,
  note,
}: {
  n: string;
  title: string;
  note?: string;
}) {
  return (
    <div className="card-bar" style={{ gap: "var(--s-2)" }}>
      <span style={{ fontWeight: 600 }}>
        {n} {title}
      </span>
      {note ? <span className="muted">· {note}</span> : null}
    </div>
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

// 标记点色 —— 四类信号的分类编码(不是状态)。一律走 --ww-* 令牌,不写死点值:
// 令牌一调,曲线上的点跟着走(全站其余 SVG 图表都是这么写的)。
// ⚠️ 色相与「涨绿跌红」撞车这件事未决:共识用了红、同批新钱包用了绿,画在
// 一条价格曲线上有被读成「跌/涨」的风险。设计系统 §9 明说「图内构造未确认」,
// 四类分类编码在五类徽章语义里没有对应色,重新配色需要人裁决 —— 本轮先把
// 「色→类型」的对照表画进卡底图例(原来只列 emoji,颜色根本无从解码)。
const MARKER_COLOR: Record<string, string> = {
  large: "var(--ww-text-muted)",
  smart: "var(--ww-warn)",
  consensus: "var(--ww-down)",
  cohort: "var(--ww-up)",
};
const MARKER_FALLBACK = "var(--ww-text-faint)";

// 卡底图例的一枚:色点 + 类型名。名字不带 emoji —— 正文句子里不放 emoji
// (readme §1),这里要的是「这个颜色是哪一类」,emoji 帮不上忙。
function MarkerKey({ type, label }: { type: string; label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--s-1)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: 99,
          flex: "0 0 auto",
          background: MARKER_COLOR[type] ?? MARKER_FALLBACK,
        }}
      />
      {label}
    </span>
  );
}

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
    <section style={{ marginBottom: "var(--s-4)" }}>
      <div className="ds-card" style={{ overflow: "hidden" }}>
        <SectionBar
          n="01"
          title={t("复盘")}
          note={t("价格曲线 × 本站告警 × 结算")}
        />
        {!d && (
          // 未加载态:灰底居中带 —— 一个主按钮 + 为什么要点它 + 点完能看到什么。
          // 空态必须给内容和出路,不返回 null。
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "10px",
              padding: "var(--s-5) var(--s-4)",
              background: "var(--ww-surface-muted)",
              textAlign: "center",
            }}
          >
            <button
              className="ds-btn ds-btn--primary"
              disabled={state.loading}
              onClick={() => void load()}
            >
              {state.loading ? t("加载中…") : t("拉一次价格曲线")}
            </button>
            <span className="ds-hint">
              {t("点一下才拉曲线 —— 这页对上游仍是零请求")}
            </span>
            <span
              style={{
                display: "flex",
                gap: "var(--s-1)",
                flexWrap: "wrap",
                justifyContent: "center",
                marginTop: "var(--s-1)",
              }}
            >
              <Tag>{t("💰 大单")}</Tag>
              <Tag>{t("🏆 聪明钱")}</Tag>
              <Tag>{t("🔥 共识")}</Tag>
              <Tag>{t("🐣 同批新钱包")}</Tag>
            </span>
            <span className="ds-label" style={{ textTransform: "none" }}>
              {t("曲线为第一结果一侧 · 另一侧按 1−p 映射（标记带 ↔）")}
            </span>
            {state.error && (
              <span className="ds-hint" style={{ color: "var(--ww-down)" }}>
                {t("加载失败：{err}", { err: state.error })}
              </span>
            )}
          </div>
        )}
        {d && d.series.length > 0 && (
          <>
            <div style={{ padding: "var(--s-4)" }}>
              <ReplayChart d={d} />
            </div>
            <div className="note-strip">
              <div>
                {t("曲线为 {o} 一侧的价格。", { o: d.outcome ?? "index 0" })}{" "}
                {d.binary
                  ? t("另一侧的告警按 1−p 精确映射到同一坐标（标记带 ↔）。")
                  : t(
                      "非二元市场：只显示第一结果一侧的告警，其余边无等价映射。",
                    )}{" "}
                {d.closed && d.resolutionPrice != null
                  ? t("虚线为结算价。")
                  : ""}
              </div>
              {/* 图例 —— 原来是一句「标记色：💰大单 🏆聪明钱…」:emoji 摆在
                  正文句子中间(readme §1 不允许),而且自称「标记色」却不带一个
                  色样,读者无法把图上的点映射回类型。改成真的色样对照。 */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--s-3)",
                  flexWrap: "wrap",
                  marginTop: "var(--s-2)",
                }}
              >
                <span className="ds-label">{t("标记色")}</span>
                <MarkerKey type="large" label={t("大单")} />
                <MarkerKey type="smart" label={t("聪明钱")} />
                <MarkerKey type="consensus" label={t("共识")} />
                <MarkerKey type="cohort" label={t("同批新钱包")} />
              </div>
            </div>
          </>
        )}
        {d && d.series.length === 0 && (
          <div className="ds-empty" style={{ border: 0, borderRadius: 0 }}>
            {t("该区间没有价格历史点（市场太新或曲线不可用）。")}
          </div>
        )}
      </div>
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
    // 图表区:1px 边 + 圆角 8(§4),不再套一层卡 —— 外面已经是 01 段那张卡了
    <div
      style={{
        overflowX: "auto",
        border: "1px solid var(--ww-border)",
        borderRadius: "var(--r-btn)",
        background: "var(--ww-surface)",
      }}
    >
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
            fill={MARKER_COLOR[m.type] ?? MARKER_FALLBACK}
            stroke="var(--ww-surface)"
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
