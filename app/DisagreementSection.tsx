"use client";

import { Fragment, useState } from "react";
import {
  HoldingCell,
  MarketSlugActions,
  Tag,
  WalletLink,
  catLabelFineT,
} from "./ui";
import { useLang } from "./i18n";
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
  slug: string;
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
  // 二级分类(可选以对旧响应宽容),标签合成「体育·NBA」。
  subcategory?: string | null;
  closed: boolean;
};

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

// Quality-weighted balance across a market's sides. Pure fact: how the smart
// money's weight leans — no follow/skip advice.
//
// 设计稿版式:两侧金额直接落在条的两端(领先侧左、落后侧右),条 6px 直角、
// 深浅灰区分 —— 于是不需要色块图例,也不需要蓝色(全站蓝只表示可点击)。
function BalanceBar({
  sides,
  total,
}: {
  sides: DisagreementSide[];
  total: number;
}) {
  const { t } = useLang();
  // 侧序 = 质量加权降序,所以 [0] 是领先侧。
  const lead = sides[0];
  const rest = sides.slice(1);
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "var(--s-3)",
          fontSize: "var(--t-base)",
          lineHeight: "var(--lh-snug)",
        }}
      >
        <span style={{ color: "var(--ww-text)", overflowWrap: "anywhere" }}>
          {lead?.outcome}{" "}
          <span style={{ fontWeight: 600 }}>
            ${fmtUsd(lead?.weightedUsd ?? 0)}
          </span>
        </span>
        <span
          style={{
            color: "var(--ww-text-muted)",
            textAlign: "right",
            overflowWrap: "anywhere",
          }}
        >
          {rest
            .map((s) => `${s.outcome} $${fmtUsd(s.weightedUsd)}`)
            .join(" · ")}
        </span>
      </div>
      <div
        className="split-bar"
        style={{ marginTop: 6, borderRadius: 0 }}
        aria-hidden
      >
        {sides.map((s, i) => {
          const pct = total > 0 ? (s.weightedUsd / total) * 100 : 0;
          return (
            <div
              key={s.outcome}
              title={t("{outcome} · 质量加权 ${usd}", {
                outcome: s.outcome,
                usd: fmtUsd(s.weightedUsd),
              })}
              style={{
                width: `${pct}%`,
                background:
                  i === 0 ? "var(--ww-text)" : "var(--ww-border-dashed)",
              }}
            />
          );
        })}
      </div>
    </>
  );
}

// Expanded per-side wallet detail. Rendered only when a market row is open, so
// mounting it triggers the lazy current-position fetch (window net-buy = "flow";
// the added 当前持仓 column = "stock", i.e. what each wallet holds right now).
function MarketDetail({ market }: { market: DisagreementMarket }) {
  const { t } = useLang();
  const wallets = market.sides.flatMap((s) => s.wallets.map((w) => w.wallet));
  const { positions, loading } = useMarketPositions(
    market.conditionId,
    wallets,
    true,
  );
  return (
    <>
      {market.sides.map((s, i) => (
        // 每一侧一张卡:标题条(14/600 + 400 灰续写)+ 紧凑表 —— 与设计稿里
        // 跟在主表卡下面的「NO 一侧展开」同一版式。行内不再有色块与 🏆:
        // 这张表里每一行都是白名单钱包,前缀不携带信息。
        <div
          key={s.outcome}
          style={{
            marginTop: i ? "var(--s-3)" : 0,
            border: "1px solid var(--ww-border)",
            borderRadius: "var(--r-md)",
            overflow: "hidden",
            background: "var(--ww-surface)",
          }}
        >
          {/* 标题条是「MOROCCO 一侧展开␣· 4 个钱包 · …」的一句连写:粗标题与
              灰色续写包在同一个 flex 子项里,否则 .card-bar 的 12px gap 会加在
              「· 」前面变成双重间隔,窄屏 flex-wrap 时灰续写还会整段掉到第二
              行、以一个孤零零的「· 」开头。 */}
          <div className="card-bar">
            <span style={{ minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>
                {t("{outcome} 一侧展开", { outcome: s.outcome })}
              </span>
              <span className="ds-hint">
                {t(
                  " · {n} 个钱包 · 净买 ${net} · 质量加权 ${weighted} · 建仓均价 {avg}",
                  {
                    n: s.walletCount,
                    net: fmtUsd(s.netUsd),
                    weighted: fmtUsd(s.weightedUsd),
                    avg: s.avgBuyPrice.toFixed(3),
                  },
                )}
                {s.currentPrice != null
                  ? t(" · 现价 {cur}", { cur: s.currentPrice.toFixed(3) })
                  : ""}
              </span>
            </span>
          </div>
          <table className="ds-table--compact">
            <thead>
              <tr>
                <th>{t("钱包")}</th>
                <th className="is-right">{t("评分")}</th>
                <th className="is-right">{t("胜率")}</th>
                <th className="is-right">{t("净买入")}</th>
                <th className="is-right">{t("建仓均价")}</th>
                <th
                  className="is-right"
                  title={t("该钱包当前在此结果的持仓市值与浮动盈亏")}
                >
                  {t("当前持仓")}
                </th>
              </tr>
            </thead>
            <tbody>
              {s.wallets.map((w) => (
                <tr key={`${s.outcome}-${w.wallet}`}>
                  <td>
                    <WalletLink address={w.wallet}>
                      {shortWallet(w.wallet)}
                    </WalletLink>
                  </td>
                  <td className="is-right" data-label={t("评分")}>
                    {w.score != null ? (
                      Math.round(w.score)
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  <td className="is-right" data-label={t("胜率")}>
                    {w.winRate != null ? (
                      `${Math.round(w.winRate * 100)}%`
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  <td className="is-right" data-label={t("净买入")}>
                    ${fmtUsd(w.netUsd)}
                  </td>
                  <td className="is-right" data-label={t("建仓均价")}>
                    {w.avgBuyPrice.toFixed(3)}
                  </td>
                  <td className="is-right" data-label={t("当前持仓")}>
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
  const { t } = useLang();
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
        {t("窗口内暂无聪明钱分歧 — 白名单钱包没有在同一市场对立建仓")}
        {/* 空态只留出路:「为什么少」主句已经说了(没有对立建仓),再解释一遍
            门槛构造是重复。 */}
        <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
          {t("把最少钱包降到 ≥2 个、时间窗放宽到 12h 再看一次。")}
        </div>
      </div>
    );
  }

  return (
    <div className="ds-card" style={{ overflow: "hidden" }}>
      {/* 标题条只留计数 —— 「对立结果都有聪明钱、与共识互斥」页头已说过,
          「按质量加权称」是列头自己的名字与 title。 */}
      <div className="card-bar">
        <span style={{ fontWeight: 600 }}>
          {t("共 {n} 个分歧市场", { n: markets.length })}
        </span>
      </div>
      <div
        className="ds-table-wrap"
        style={{ border: 0, borderRadius: 0, boxShadow: "none" }}
      >
        <table className="ds-table">
          <thead>
            <tr>
              {/* 列宽照设计稿:市场自适应 · 天平 280 · 倾斜 110 · 合计加权 120
                  · 最新 90。表头永远 nowrap(全局 .ds-table th 已给)。 */}
              <th style={{ width: 28, padding: "var(--s-2) var(--s-1)" }} />
              <th>{t("市场")}</th>
              {/* 加权口径与「两边押剔除」规则写在列头 title 里,不占卡底。 */}
              <th
                style={{ width: 280 }}
                title={t(
                  "净买入 × 钱包评分权重，不是原始金额；同时在两边都净买入的钱包按对冲 / 做市从两侧一起剔除。",
                )}
              >
                {t("质量加权天平")}
              </th>
              <th
                style={{ width: 110 }}
                title={t(
                  "质量加权后领先侧的占比；两侧接近时转琥珀（天平不倾斜，读不出方向）。已结算的市场不谈倾斜，只标胜出的结果。",
                )}
              >
                {t("倾斜")}
              </th>
              <th className="is-right" style={{ width: 120 }}>
                {t("合计加权")}
              </th>
              <th className="is-right" style={{ width: 90 }}>
                {t("最新时间")}
              </th>
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => {
              const key = m.conditionId;
              const isOpen = expanded.has(key);
              const tiltPctLabel = Math.round(m.tiltPct * 100);
              // A settled market's tilt is moot — show the resolved winner
              // instead (mirrors the consensus board's 已结算 badge). Settled =
              // gamma's `closed` flag OR a side price pinned to 0/1; winner =
              // the side that resolved toward 1 (null if a third outcome won —
              // both sides at ~0).
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
                    title={
                      isOpen ? t("点击收起各侧明细") : t("点击展开各侧明细")
                    }
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
                    {/* 市场名永不截断:换行,最多两行,顶对齐。 */}
                    <td className="cell-wrap" style={{ maxWidth: 320 }}>
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
                      {/* 对立的两个结果名已经落在天平列的两端,这一行只留分类
                          与「剔除两边押」的灰底名称标签(灰底不表示状态);
                          ⧉ 复制 market slug、↗ 开交易页、🎯 开市场信号卡。 */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          flexWrap: "wrap",
                          gap: "var(--s-2)",
                          marginTop: "var(--s-1)",
                          fontSize: "var(--t-sm)",
                          color: "var(--ww-text-muted)",
                        }}
                      >
                        {m.category ? (
                          <span>
                            {catLabelFineT(t, m.category, m.subcategory)}
                          </span>
                        ) : null}
                        {m.excludedWallets > 0 ? (
                          <Tag>
                            {t("剔除 {n} 个两边押", { n: m.excludedWallets })}
                          </Tag>
                        ) : null}
                        <span>
                          <MarketSlugActions
                            slug={m.slug}
                            eventSlug={m.eventSlug}
                            conditionId={m.conditionId}
                          />
                        </span>
                      </div>
                    </td>
                    <td
                      className="col-block cell-wrap"
                      data-label={t("质量加权天平")}
                      style={{ minWidth: 200, maxWidth: 280 }}
                    >
                      <BalanceBar sides={m.sides} total={m.totalWeightedUsd} />
                    </td>
                    {/* 倾斜是结论文字,不是徽章:蓝色在全站只表示可点击。
                        「倒向 63%」「势均力敌 52%」是定长文案,照设计稿 nowrap
                        钉在 110px 列里;已结算那一支里带的是结果名,结果名永不
                        截断也不许被禁折行(否则会把 110px 顶宽、挤扁自适应的
                        市场列),所以这一支改走 .cell-wrap 让它换行。 */}
                    <td
                      className={settled ? "cell-wrap" : undefined}
                      data-label={t("倾斜")}
                    >
                      {settled ? (
                        <span>
                          🏁 {t("已结算")}
                          {winnerOutcome
                            ? t(" · {outcome} 胜", { outcome: winnerOutcome })
                            : ""}
                        </span>
                      ) : m.tilt === "lopsided" ? (
                        <span style={{ whiteSpace: "nowrap" }}>
                          {t("⬛ 倒向 {pct}%", { pct: tiltPctLabel })}
                        </span>
                      ) : (
                        <span
                          style={{
                            whiteSpace: "nowrap",
                            color: "var(--ww-warn)",
                          }}
                        >
                          {t("⚠️ 势均力敌 {pct}%", { pct: tiltPctLabel })}
                        </span>
                      )}
                    </td>
                    <td className="is-right" data-label={t("合计加权")}>
                      ${fmtUsd(m.totalWeightedUsd)}
                    </td>
                    <td className="muted is-right" data-label={t("最新时间")}>
                      {fmtTime(m.lastTs)}
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr>
                      <td
                        colSpan={6}
                        style={{
                          padding: "0 var(--s-4) var(--s-4)",
                          background: "var(--ww-surface)",
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
      {/* 卡底只留「—」的成因(判不了 ≠ 零),而且要列全、不能穷举一半:评分 /
          胜率的 — 与「当前持仓」的 —(ui.tsx HoldingCell 无仓位时也渲染 —)
          含义不同。天平的加权口径已进「质量加权天平」列头 title。 */}
      <div className="note-strip note-strip--warn">
        {t(
          "— 两种成因，都不是 0：评分 / 胜率栏＝该钱包无已结算样本 · 当前持仓栏＝此刻在该结果已无持仓。",
        )}
      </div>
    </div>
  );
}
