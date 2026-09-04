"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CopyButton,
  fmtSignedUsdCompact,
  MarketSlugActions,
  Modal,
  Segmented,
  StatCard,
  Tag,
  WalletLink,
} from "../ui";
import { WalletTagChips, tagVariant } from "../walletTagChips";
import { WALLET_TAGS } from "../glossary";
import { useLang } from "../i18n";
import type {
  ChannelScorecard,
  ScorecardGroup,
} from "../../lib/channelScorecard";
import type { WalletTag } from "../../lib/walletTags";

// -------------------------------------------------------------- read model

interface EvidenceDetail {
  channel: string;
  conditionId: string;
  ts: number;
  usd: number;
  price: number;
  note: string;
  // Full market context; null on legacy rows written before the columns
  // existed (they self-heal when the behavior is re-observed).
  title: string | null;
  slug: string | null;
  eventSlug: string | null;
  outcome: string | null;
}
interface ChannelStat {
  channel: string;
  markets: number;
}
interface CandidateRow {
  address: string;
  channels: ChannelStat[];
  totalMarkets: number;
  lastTs: number;
  latestNote: string;
  status: "candidate" | "bot";
  tags: WalletTag[];
  evidence: EvidenceDetail[];
}
interface MemberRow {
  address: string;
  source: string | null;
  isWhitelist: boolean;
  score: number | null;
  winRate: number | null;
  netPnl: number | null;
  updatedAt: number | null;
  tags: WalletTag[];
  styleTags?: string[];
  evidence: EvidenceDetail[];
}

// 交易风格标签译名(lib/walletFingerprint 的 ASCII 键;lib 中文常量不被
// coverage 闸看见,页面逐键写死 —— scorecardLabel 同一原因)。
function styleLabel(key: string, t: TFn2): string {
  switch (key) {
    case "longshot":
      return t("🎯 冷门猎手");
    case "midrange":
      return t("⚖️ 中盘");
    case "favorite":
      return t("🛡️ 热门守卫");
    case "lastcall":
      return t("⏱️ 临场");
    case "intraday":
      return t("📅 隔日");
    case "longhaul":
      return t("🗓️ 长线");
    case "hammer":
      return t("🔨 重锤");
    case "twoway":
      return t("↔️ 双向");
    default:
      return key;
  }
}
type TFn2 = (zh: string, params?: Record<string, string | number>) => string;

interface DiscoveryPayload {
  candidates: CandidateRow[];
  members: MemberRow[];
  counts: {
    evidenceRows: number;
    candidateWallets: number;
    poolTotal: number;
    poolGlobal: number;
    poolDiscovery: number;
  };
  /** 渠道效果记分卡(additive;旧部署/错误兜底可能缺失,渲染侧防御)。 */
  scorecard?: ChannelScorecard;
  /** 名人堂/反指(2026-08-28 八件套;additive,渲染侧防御)。 */
  league?: LeagueView;
  error?: string;
}

type LeagueAlertRef = {
  title: string | null;
  createdAt: number | null;
  contrib: number;
};
type LeagueRowView = {
  wallet: string;
  codename: string;
  n: number;
  markets: number;
  winRate: number;
  netEdge: number;
  seC: number;
  verdict: "pos" | "neg";
  channel: string;
  isMarketMaker: boolean;
  best: LeagueAlertRef | null;
  worst: LeagueAlertRef | null;
};
type LeagueView = {
  hall: LeagueRowView[];
  fade: LeagueRowView[];
  testedWallets: number;
  disclosures: {
    gradedAlerts: number;
    rows: number;
    feeUnknownDropped: number;
    malformedDropped: number;
  };
};

type View = "candidates" | "members" | "scorecard" | "league";

// Daily consensus-cycle aggregates from /api/cycle-metrics (P0.9): the
// signal-density dial that separates "market cooled" from "thresholds drifted".
interface DailyDensity {
  day: string;
  cycles: number;
  avgWindowTrades: number;
  avgWindowUsd: number;
  rawGroups: number;
  contestedDropped: number;
  fired: number;
  perM: number;
  evidenceNew: number;
}

// ------------------------------------------------------------- formatting

const CHANNEL_META: Record<string, { icon: string; label: string }> = {
  echo: { icon: "🔁", label: "共识同行" },
  splitter: { icon: "🧩", label: "拆单建仓" },
  insider: { icon: "🕵️", label: "内幕签名" },
  early_winner: { icon: "🎯", label: "早期赢家" },
};

// useLang().t 的签名 —— 下面几个模块级辅助函数在组件树之外,由调用方把
// 当前语言的 t 穿进来(中文键在 zh 下原样返回,逻辑零变化)。
type TFn = (zh: string, params?: Record<string, string | number>) => string;

function channelLabel(channel: string, t: TFn): string {
  const m = CHANNEL_META[channel];
  return m ? `${m.icon} ${t(m.label)}` : channel;
}

function shortWallet(w: string): string {
  if (!w) return "";
  return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

function fmtAgo(tsSec: number, t: TFn): string {
  const mins = Math.max(0, Math.round(Date.now() / 1000 - tsSec) / 60);
  if (mins < 60) return t("{n} 分钟前", { n: Math.round(mins) });
  const h = mins / 60;
  if (h < 48) return t("{n} 小时前", { n: Math.round(h) });
  return t("{n} 天前", { n: Math.round(h / 24) });
}

// Pool members graduate OUT of this list into the pool tab, so the funnel
// statuses are binary: still watching, or permanently disqualified.
// 徽章语义(readme §2.1):琥珀 = 需留神的口径 / 机器人;灰底 = 名称标签。
function statusTag(status: CandidateRow["status"], t: TFn) {
  if (status === "bot")
    return <Tag variant="warn">🤖 {t("做市机器人 · 硬拒")}</Tag>;
  return <Tag>{t("候选中")}</Tag>;
}

// Generic (per-wallet-count-free) chip label for the filter bar.
function filterChipLabel(key: string, sample: WalletTag, t: TFn): string {
  if (key.startsWith("ch:")) return channelLabel(key.slice(3), t);
  return t(sample.label.replace(/ ×\d+$/, ""));
}

// ------------------------------------------------------- expandable detail

function EvidenceDetailRows({
  evidence,
  colSpan,
}: {
  evidence: EvidenceDetail[];
  colSpan: number;
}) {
  const { t } = useLang();
  return (
    <tr>
      <td colSpan={colSpan} style={{ background: "var(--ww-surface-muted)" }}>
        {evidence.length === 0 ? (
          <div className="ds-empty">
            {t(
              "近 30 天无渠道证据 —— 经榜单播种入池（全局榜/分类榜），或证据已滚出 30 天窗口",
            )}
          </div>
        ) : (
          // 展开明细走嵌套紧凑表（13px 单元格）—— 它是主行的下一级，
          // 与主表同字号会读成两张并列的表。
          <table
            className="ds-table ds-table--compact"
            style={{ margin: "var(--s-2) 0" }}
          >
            <thead>
              <tr>
                <th style={{ width: 130 }}>{t("渠道")}</th>
                <th>{t("证据")}</th>
                <th>{t("市场 · 结果")}</th>
                <th className="is-right" style={{ width: 110 }}>
                  {t("金额")}
                </th>
                <th className="is-right" style={{ width: 90 }}>
                  {t("价格")}
                </th>
                <th className="is-right" style={{ width: 110 }}>
                  {t("时间")}
                </th>
              </tr>
            </thead>
            <tbody>
              {evidence.map((e) => (
                <tr key={`${e.channel}:${e.conditionId}`}>
                  <td style={{ whiteSpace: "nowrap" }} data-label={t("渠道")}>
                    <Tag variant="default">{channelLabel(e.channel, t)}</Tag>
                  </td>
                  <td className="cell-wrap" data-label={t("证据")}>
                    {e.note}
                  </td>
                  {/* Full market title + outcome with the standard ⧉↗ pair —
                      the note above only carries a 40-char truncated title.
                      Legacy rows (no stored market context) fall back to a
                      muted em-dash and self-heal on re-observation. */}
                  <td
                    className="cell-wrap"
                    style={{ maxWidth: 300 }}
                    data-label={t("市场 · 结果")}
                  >
                    {e.title ? (
                      <>
                        {e.eventSlug ? (
                          <a
                            href={`https://polymarket.com/event/${e.eventSlug}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {e.title}
                          </a>
                        ) : (
                          e.title
                        )}
                        <div
                          style={{
                            marginTop: 5,
                            fontSize: "var(--t-sm)",
                            color: "var(--ww-text-muted)",
                          }}
                        >
                          {e.outcome ?? ""}
                          <MarketSlugActions
                            slug={e.slug}
                            eventSlug={e.eventSlug}
                            conditionId={e.conditionId}
                          />
                        </div>
                      </>
                    ) : (
                      <span
                        className="muted"
                        title={t(
                          "旧证据行未存市场详情 — 引擎会从 gamma 自动回填（启动后约 1 分钟），个别已下架市场保持空缺",
                        )}
                      >
                        —
                      </span>
                    )}
                  </td>
                  <td className="mono is-right" data-label={t("金额")}>
                    ${Math.round(e.usd).toLocaleString("en-US")}
                  </td>
                  <td className="mono is-right" data-label={t("价格")}>
                    {(e.price * 100).toFixed(1)}¢
                  </td>
                  <td
                    className="mono is-right"
                    style={{ whiteSpace: "nowrap" }}
                    data-label={t("时间")}
                  >
                    {fmtAgo(e.ts, t)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------- channel scorecard

// 渠道键 → 展示名走页面侧 t()(lib 的 channelLabel 是中文常量,直接渲染会让
// 英文界面漏中文;coverage 闸只扫静态字面量,所以逐键写死)。
function scorecardLabel(
  key: string,
  t: (s: string, v?: Record<string, string | number>) => string,
): string {
  if (key.startsWith("category:")) {
    return t("分类榜·{cat}", { cat: key.slice("category:".length) });
  }
  switch (key) {
    case "leaderboard":
      return t("全局榜");
    case "echo":
      return t("回声(echo)");
    case "splitter":
      return t("拆单(splitter)");
    case "insider":
      return t("新钱包(insider)");
    case "early_winner":
      return t("早期赢家");
    case "manual":
      return t("手动白名单");
    case "unattributed":
      return t("未归因");
    case "departed":
      return t("已离池(来源失联)");
    case "leaderboard:mm":
      return t("全局榜·做市商");
    case "leaderboard:human":
      return t("全局榜·非做市商");
    default:
      return key;
  }
}

function ScorecardTable({
  groups,
  t,
}: {
  groups: ScorecardGroup[];
  t: (s: string, v?: Record<string, string | number>) => string;
}) {
  const pts = (v: number) => (v * 100).toFixed(2);
  // 徽章五类语义(readme §2.1):绿 = 通过/命中,红 = 反向,琥珀 = 样本不足,
  // 灰底 = 名称标签(「不显著」是一个结论名,不是状态)。
  const verdictBadge = (g: ScorecardGroup) =>
    g.verdict === "pos" ? (
      <Tag variant="up">{t("✅ 显著为正")}</Tag>
    ) : g.verdict === "neg" ? (
      <Tag variant="down">{t("❌ 显著为负")}</Tag>
    ) : g.verdict === "flat" ? (
      <Tag>{t("○ 不显著")}</Tag>
    ) : (
      <Tag variant="warn">{t("· 市场数不足")}</Tag>
    );
  return (
    // 记分卡是「渠道记分卡」视图的主表，不是谁的展开明细 —— 主表走 14px
    // 的 .ds-table。--compact（13px）只留给嵌套的展开明细子表，两者都用它
    // 就把「主表 / 明细」这一级层级抹平了。
    <div className="ds-table-wrap">
      <table className="ds-table">
        <thead>
          <tr>
            <th>{t("渠道")}</th>
            <th className="is-right">{t("告警行")}</th>
            <th className="is-right">{t("钱包")}</th>
            <th className="is-right">{t("市场")}</th>
            <th className="is-right">{t("胜率")}</th>
            <th className="is-right">{t("隐含")}</th>
            <th className="is-right">{t("费用")}</th>
            <th className="is-right">{t("净 edge ±95%(聚类)")}</th>
            <th className="is-right">{t("判定")}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key}>
              <td className="cell-wrap" data-label={t("渠道")}>
                {scorecardLabel(g.key, t)}
              </td>
              <td
                className="mono is-right"
                data-label={t("告警行")}
                title={t("smart {s} 条 · 共识成员 {c} 条", {
                  s: g.smartN,
                  c: g.consensusN,
                })}
              >
                {g.n}
              </td>
              <td className="mono is-right" data-label={t("钱包")}>
                {g.wallets}
              </td>
              <td className="mono is-right" data-label={t("市场")}>
                {g.markets}
              </td>
              <td className="mono is-right" data-label={t("胜率")}>
                {pts(g.winRate)}%
              </td>
              <td className="mono is-right" data-label={t("隐含")}>
                {pts(g.implied)}%
              </td>
              <td className="mono is-right" data-label={t("费用")}>
                {pts(g.feePts)}
              </td>
              <td
                className="mono is-right"
                data-label={t("净 edge ±95%(聚类)")}
              >
                {pts(g.netEdge)} ±{" "}
                {Number.isFinite(g.seC) ? pts(1.96 * g.seC) : "∞"}
              </td>
              <td className="is-right" data-label={t("判定")}>
                {verdictBadge(g)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScorecardSection({
  sc,
  t,
}: {
  sc: ChannelScorecard | undefined;
  t: (s: string, v?: Record<string, string | number>) => string;
}) {
  if (!sc) {
    return (
      <div className="ds-empty">
        {t("记分卡数据不可用(旧部署或接口错误)。")}
      </div>
    );
  }
  const d = sc.disclosures;
  return (
    <div>
      {/* 口径先行 —— 统计声明放在数据「前面」,不放脚注(readme §1)。
          灰框 = 口径定义;琥珀框 = 读前必看的统计警告。 */}
      <div className="ds-callout" style={{ marginBottom: "var(--s-3)" }}>
        {t(
          "每渠道的向前战绩:smart/共识告警只对在池钱包触发,每条已结算告警天然是该钱包在池期间的一次前向实验;按首发渠道(source)归组。逐行贡献 = 结算胜负 − 入场隐含 − 协议费(概率点/行),区间为市场聚类稳健口径。",
        )}
      </div>
      <div
        className="ds-callout ds-callout--warn"
        style={{ marginBottom: "var(--s-4)" }}
      >
        ⚠️{" "}
        {t(
          "多重比较提醒:本表共 {g} 个分组,α=0.05 下期望假阳性 ≈ {e} 个 —— 单组「显著」在独立时间段复现之前只是候选假设;判定不接任何自动清退,动手走既有准入/重审路径。",
          { g: sc.groupCount, e: (sc.groupCount * 0.05).toFixed(1) },
        )}
      </div>
      <ScorecardTable groups={sc.groups} t={t} />
      {sc.mmSplit.length > 0 && (
        <>
          <div
            className="ds-label"
            style={{ margin: "var(--s-5) 0 var(--s-2)" }}
          >
            {t("全局榜 × 做市商横切(官方榜不区分做市商,该不该留由数据说话)")}
          </div>
          <ScorecardTable groups={sc.mmSplit} t={t} />
        </>
      )}
      <div className="ds-callout" style={{ marginTop: "var(--s-4)" }}>
        {t(
          "已打分告警 {a} 条 → 展开 {r} 行;费用不可定价剔除 {f} 行(绝不当 0);「已离池」桶 {o} 行 —— 30 天老化与清退会删除钱包行,来源失联的历史告警不丢弃、单独成桶,桶的大小本身就是幸存者盲区的读数。",
          {
            a: d.gradedAlerts,
            r: d.rows,
            f: d.feeUnknownDropped,
            o: d.orphanRows,
          },
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ page

// 名人堂 + 反指名单(2026-08-28 八件套):逐钱包前向战绩两榜。判定纪律与
// 记分卡同源(CRVE + 扣费 + nc≥10);多重比较只披露不校正,页脚写明分母。
function LeagueSection({
  lg,
  t,
}: {
  lg: LeagueView | undefined;
  t: (zh: string, params?: Record<string, string | number>) => string;
}) {
  if (!lg) {
    return (
      <div className="ds-empty" style={{ marginBottom: "var(--s-4)" }}>
        {t("名人堂数据缺失（接口错误兜底）。")}
      </div>
    );
  }
  const pts = (v: number) =>
    `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}`;
  // 名人堂 / 反指是「名人堂」视图的两张主表 —— 同上，主表 14px，
  // --compact 只归展开明细子表所有。
  const leagueTable = (rows: LeagueRowView[]) => (
    <div className="ds-table-wrap" style={{ marginBottom: "var(--s-4)" }}>
      <table className="ds-table">
        <thead>
          <tr>
            <th>{t("代号 / 钱包")}</th>
            <th>{t("渠道")}</th>
            <th className="is-right">{t("样本 n（市场）")}</th>
            <th className="is-right">{t("胜率")}</th>
            <th className="is-right">{t("净 edge（点/仓）")}</th>
            <th>{t("最佳 / 最惨一战")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.wallet}>
              {/* 行没有任何行级强调:代号不加粗、净 edge 不跳字重 ——
                  轻重只靠徽章颜色(readme §4)。 */}
              <td className="cell-wrap" data-label={t("代号 / 钱包")}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "var(--s-2)",
                    flexWrap: "wrap",
                  }}
                >
                  {r.codename}
                  {r.isMarketMaker && (
                    <Tag variant="warn">🤖 {t("做市机器人")}</Tag>
                  )}
                </span>
                <div
                  className="mono"
                  style={{ marginTop: 5, fontSize: "var(--t-sm)" }}
                >
                  <WalletLink address={r.wallet}>
                    {r.wallet.slice(0, 6)}…{r.wallet.slice(-4)}
                  </WalletLink>
                </div>
              </td>
              <td className="cell-wrap muted" data-label={t("渠道")}>
                {scorecardLabel(r.channel, t)}
              </td>
              <td className="mono is-right" data-label={t("样本 n（市场）")}>
                {r.n}（{r.markets}）
              </td>
              <td className="mono is-right" data-label={t("胜率")}>
                {Math.round(r.winRate * 100)}%
              </td>
              <td className="mono is-right" data-label={t("净 edge（点/仓）")}>
                {pts(r.netEdge)} ±{(r.seC * 100).toFixed(1)}
              </td>
              <td className="cell-wrap" data-label={t("最佳 / 最惨一战")}>
                {r.best && (
                  <div>
                    <span style={{ color: "var(--ww-up)" }}>
                      ▲ {pts(r.best.contrib)}
                    </span>{" "}
                    <span className="muted">{r.best.title ?? ""}</span>
                  </div>
                )}
                {r.worst && (
                  <div style={{ marginTop: 4 }}>
                    <span style={{ color: "var(--ww-down)" }}>
                      ▼ {pts(r.worst.contrib)}
                    </span>{" "}
                    <span className="muted">{r.worst.title ?? ""}</span>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <section style={{ marginBottom: "var(--s-5)" }}>
      {/* 统计声明放在数据「前面」,不放脚注(readme §1)。 */}
      <div
        className="ds-callout ds-callout--warn"
        style={{ marginBottom: "var(--s-4)" }}
      >
        ⚠️{" "}
        {t(
          "口径：逐行贡献 = 结算(0/1) − 入场隐含 − 每股协议费；区间按市场聚簇（CRVE）；代号是确定性哈希的纯趣味展示，地址才是身份。多重比较：本页共检验 {w} 个 ≥10 市场的钱包，区间未做 Bonferroni 校正——两张名单是研究线索，不是交易结论。",
          { w: lg.testedWallets },
        )}
      </div>
      <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
        {t("👑 名人堂 · 前向净 edge 显著为正")}
      </div>
      {lg.hall.length === 0 ? (
        <div className="ds-empty" style={{ marginBottom: "var(--s-4)" }}>
          {t("暂无净 edge 显著为正的钱包（≥10 市场才发判定）。")}
        </div>
      ) : (
        leagueTable(lg.hall)
      )}
      <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
        {t("🪞 反指名单 · 前向净 edge 显著为负")}
      </div>
      {lg.fade.length === 0 ? (
        <div className="ds-empty">
          {t("暂无净 edge 显著为负的钱包——逆势少数边暂时还是孤例。")}
        </div>
      ) : (
        leagueTable(lg.fade)
      )}
    </section>
  );
}

export default function DiscoveryPage() {
  const { t } = useLang();
  const [data, setData] = useState<DiscoveryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("candidates");
  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tagHelpOpen, setTagHelpOpen] = useState(false);
  const [density, setDensity] = useState<DailyDensity[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/discovery");
      const json = (await res.json()) as DiscoveryPayload;
      if (json.error) setError(json.error);
      else setError(null);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Signal-density trend (P0.9) — independent fetch so a metrics failure
  // never blocks the funnel view.
  useEffect(() => {
    let active = true;
    fetch("/api/cycle-metrics")
      .then((r) => r.json())
      .then((j) => {
        if (active) setDensity((j.days as DailyDensity[]) ?? []);
      })
      .catch(() => {
        if (active) setDensity([]);
      });
    return () => {
      active = false;
    };
  }, []);

  // Tag filter chips for the ACTIVE view: union of row tag keys with the
  // number of wallets carrying each. Selecting several = AND (a wallet must
  // carry every selected tag — "echo AND splitter" is the interesting query).
  const rows: Array<CandidateRow | MemberRow> = useMemo(
    () =>
      view === "candidates" ? (data?.candidates ?? []) : (data?.members ?? []), // league/scorecard 沿 members
    [data, view],
  );
  const chipStats = useMemo(() => {
    const byKey = new Map<string, { sample: WalletTag; wallets: number }>();
    for (const r of rows) {
      for (const t of r.tags) {
        const prev = byKey.get(t.key);
        if (prev) prev.wallets++;
        else byKey.set(t.key, { sample: t, wallets: 1 });
      }
    }
    return [...byKey.entries()].sort((a, b) => b[1].wallets - a[1].wallets);
  }, [rows]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        for (const k of activeTags) {
          // Funnel-segment pseudo filters (set by clicking a pool segment in
          // the funnel strip): group across every category/discovered source.
          if (k === "grp:discovery") {
            if (
              !r.tags.some(
                (t) =>
                  t.key.startsWith("src:category:") ||
                  t.key.startsWith("src:discovered:"),
              )
            ) {
              return false;
            }
            continue;
          }
          if (!r.tags.some((t) => t.key === k)) return false;
        }
        if (!q) return true;
        if (r.address.includes(q)) return true;
        if (r.tags.some((t) => t.label.toLowerCase().includes(q))) return true;
        return r.evidence.some((e) => e.note.toLowerCase().includes(q));
      }),
    [rows, activeTags, q],
  );

  const switchView = (v: View, presetTags?: string[]) => {
    setView(v);
    setActiveTags(new Set(presetTags ?? [])); // chips are view-specific
    setExpanded(new Set());
  };
  const toggleTag = (key: string) => {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleExpand = (address: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  };

  // 地址是全站唯一做首尾省略的东西 —— 后面跟一枚 13px ⧉ 把完整地址交回给
  // 读者（与 /wallet 档案页页头同一枚）。间距由 .copy-btn 自带的 4px 左外
  // 边距给，不再叠 gap。CopyButton 自带 stopPropagation，点它不会展开行。
  const walletCell = (address: string) => (
    <span style={{ display: "inline-flex", alignItems: "center", minWidth: 0 }}>
      <WalletLink address={address}>{shortWallet(address)}</WalletLink>
      <CopyButton text={address} />
    </span>
  );

  // 降级态两个符号分家(readme §1.2 / 说明页「…」词条):`…` = 还在取数,
  // `—` = 取到了但判不了。首屏 data 尚为 null 时四格 KPI 全写 `—` 会把
  // 「加载中」冒充成「判不了」—— 主表早就用 ds-empty 区分了这两件事。
  const kpiNum = (v: number | null | undefined): number | string =>
    v ?? (loading ? "…" : "—");

  // 漏斗末段的比例条 —— 纯展示派生量(在池 = 全局榜 + 发现渠道)。
  const poolTotal = data?.counts.poolTotal ?? null;
  const poolGlobal = data?.counts.poolGlobal ?? null;
  const poolDiscovery = data?.counts.poolDiscovery ?? null;
  const globalPct =
    poolTotal != null && poolTotal > 0 && poolGlobal != null
      ? Math.min(100, Math.max(0, Math.round((poolGlobal / poolTotal) * 100)))
      : null;
  // 漏斗末段两个分支的可点文字(蓝 = 可点,readme §2.1)。
  const poolLinkStyle = {
    border: 0,
    background: "none",
    padding: 0,
    font: "inherit",
    color: "var(--ww-link)",
    cursor: "pointer",
  };

  return (
    <main className="ds-main">
      {/* 页头区 —— 12px 小标(emoji 前缀)+ 24/600 标题 + 14px muted 描述。 */}
      <header className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="page-head__eyebrow">
            🔭 {t("白名单之外的候选漏斗")}
          </div>
          <h1 className="page-head__title">{t("聪明钱发现")}</h1>
          <p className="page-head__desc">
            {t(
              "候选须 30 天内证据广度 ≥3 且通过战绩审查才入池。点击行展开证据明细。",
            )}
          </p>
        </div>
        {/* 页头右侧动作钮（页头标准形的第四件）—— 页内琥珀条只写得下漏斗
            口径的摘要，全文在说明书的「聪明钱发现」一节。站内跳转用 →，
            ↗ 全站留给站外链接。 */}
        <div className="page-head__actions">
          <Link className="ds-btn" href="/guide#discovery">
            {t("漏斗规则全文")} →
          </Link>
        </div>
      </header>

      {error && (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-4)" }}
        >
          {t("加载失败：{msg}", { msg: error })}
        </div>
      )}

      {/* 口径条 —— 琥珀框紧跟页头，放在数据「前面」，不放脚注。 */}
      <div
        className="ds-callout ds-callout--warn"
        style={{ marginBottom: "var(--s-5)" }}
      >
        ⚠️{" "}
        {t(
          "入池口径：成交流涌现（共识同行 / 拆单建仓 / 内幕签名）+ 已结算市场早期赢家 + 分类榜专家 → 复发广度 ≥3 → 战绩审查（胜率 ≥55% 且 ≥10 结算，或盈利且 ROI ≥5% 且 ≥5 结算）→ 做市机器人硬拒。分类榜旁路：六类 × 周/月榜前 25 免复发直接进闸门，只过战绩审查；在池成员每日按战绩重新认证，30 天不再合格自动出池——行为再现即可重新成为候选。",
        )}
      </div>

      {/* KPI 分格卡 —— 漏斗四段按 01–04 编号，一张白卡内 1px 竖线分格。
          箭头没了：编号本身就是顺序，分格线负责层级(readme §4/§5)。
          02 / 04 两格仍是原来的入口，点击切视图并预置筛选。 */}
      <section className="kpi" aria-label={t("发现漏斗")}>
        <StatCard label={t("01 · 30 天证据")} icon="🔍">
          <div className="kpi-value">{kpiNum(data?.counts.evidenceRows)}</div>
          <div className="kpi-sub">{t("成交流涌现 + 结算回溯")}</div>
        </StatCard>

        <div
          className="kpi-card"
          role="button"
          tabIndex={0}
          onClick={() => switchView("candidates")}
          onKeyDown={(e) => e.key === "Enter" && switchView("candidates")}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "var(--s-3)",
            cursor: "pointer",
          }}
          title={t("查看候选漏斗列表")}
        >
          <span
            aria-hidden
            style={{ flex: "0 0 auto", fontSize: 20, lineHeight: 1.1 }}
          >
            👀
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="ds-label">{t("02 · 候选钱包")}</div>
            <div className="kpi-value">
              {kpiNum(data?.counts.candidateWallets)}
            </div>
            <div className="kpi-sub">{t("纯观察 · 不进任何信号")}</div>
          </div>
        </div>

        <StatCard label={t("03 · 准入闸门")} icon="🛡️">
          <div className="kpi-value">{t("复发 ≥3")}</div>
          <div className="kpi-sub">{t("机器人硬拒 · 分类榜旁路")}</div>
        </StatCard>

        <div
          className="kpi-card"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "var(--s-3)",
          }}
        >
          <span
            aria-hidden
            style={{ flex: "0 0 auto", fontSize: 20, lineHeight: 1.1 }}
          >
            🏆
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="ds-label">{t("04 · 共识白名单池")}</div>
            <div className="kpi-value" style={{ color: "var(--ww-link)" }}>
              {kpiNum(poolTotal)}{" "}
              <span
                style={{
                  fontSize: "var(--t-base)",
                  color: "var(--ww-text-muted)",
                }}
              >
                ={" "}
                <button
                  type="button"
                  style={poolLinkStyle}
                  onClick={() => switchView("members", ["src:leaderboard"])}
                  title={t("查看全局榜成员（top-100 自带门槛，免审查）")}
                >
                  {t("{n} 榜", { n: kpiNum(poolGlobal) })}
                </button>{" "}
                +{" "}
                <button
                  type="button"
                  style={poolLinkStyle}
                  onClick={() => switchView("members", ["grp:discovery"])}
                  title={t("查看发现渠道产出的成员（分类榜专家 + 漏斗毕业生）")}
                >
                  {t("{n} 发现", { n: kpiNum(poolDiscovery) })}
                </button>
              </span>
            </div>
            {globalPct != null && (
              <div className="split-bar" style={{ marginTop: "var(--s-2)" }}>
                <span
                  style={{
                    flex: `0 0 ${globalPct}%`,
                    background: "var(--ww-border-dashed)",
                  }}
                />
                <span style={{ flex: 1, background: "var(--ww-link)" }} />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* 筛选条 —— 一行：视图切换(互斥,Segmented) │ 标签筛选(任选子集的
          24px 芯片) …… 右对齐的搜索与「标签说明」。设计稿把三者收在同一
          行，中间用 1px 竖线分隔；筛选条不是卡，它是主表卡的参数，加一层
          框会被读成第二块内容。 */}
      <div className="filter-bar" style={{ marginTop: "var(--s-5)" }}>
        <Segmented<View>
          ariaLabel={t("视图切换")}
          value={view}
          onChange={switchView}
          options={[
            {
              label: t("候选漏斗 ({n})", {
                n: data?.counts.candidateWallets ?? 0,
              }),
              value: "candidates",
            },
            {
              label: t("白名单池 ({n})", { n: data?.counts.poolTotal ?? 0 }),
              value: "members",
            },
            {
              label: t("渠道记分卡"),
              value: "scorecard",
            },
            {
              // emoji 不放在按钮上（readme §1）—— 👑 留给下面的 12px 小标。
              label: t("名人堂"),
              value: "league",
            },
          ]}
        />
        {/* 标签筛选 —— 任选子集（多选 = AND）。名称标签形态保留标签自身的
            语义色（琥珀 = 机器人），选中态走蓝描边（readme §2.1）；与左侧
            互斥的 Segmented 之间隔一条 1px 竖线，形态不同不会读成同一族。 */}
        {chipStats.length > 0 && (
          <>
            <span
              aria-hidden
              style={{
                flex: "0 0 auto",
                width: 1,
                height: 20,
                background: "var(--ww-border)",
                margin: "0 var(--s-1)",
              }}
            />
            <span
              role="group"
              aria-label={t("标签筛选")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "var(--s-2)",
                minWidth: 0,
              }}
            >
              {chipStats.map(([key, s]) => {
                const active = activeTags.has(key);
                return (
                  <button
                    key={key}
                    onClick={() => toggleTag(key)}
                    aria-pressed={active}
                    style={{
                      border: "none",
                      background: "none",
                      padding: 0,
                      cursor: "pointer",
                      lineHeight: 0,
                    }}
                    title={`${t("{label} — {n} 个钱包", { label: filterChipLabel(key, s.sample, t), n: s.wallets })}${active ? t("（点击取消）") : ""}`}
                  >
                    <Tag variant={active ? "brand" : tagVariant(s.sample)}>
                      {filterChipLabel(key, s.sample, t)} {s.wallets}
                    </Tag>
                  </button>
                );
              })}
            </span>
          </>
        )}
        <span className="filter-bar__right">
          {(activeTags.size > 0 || q) && (
            <span
              className="ds-hint"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--s-2)",
              }}
            >
              {t("{shown}/{total} 条匹配", {
                shown: filtered.length,
                total: rows.length,
              })}
              <button
                className="ds-btn ds-btn--sm"
                onClick={() => {
                  setActiveTags(new Set());
                  setQuery("");
                }}
              >
                {t("清除")}
              </button>
            </span>
          )}
          <input
            className="ds-input"
            style={{ width: 240, maxWidth: "100%" }}
            placeholder={t("搜索地址 / 市场 / 标签…")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("搜索")}
          />
          {/* 「标签说明」是一个次要入口，蓝字即可点 —— 按钮上不放 emoji。 */}
          <button
            type="button"
            onClick={() => setTagHelpOpen(true)}
            title={t("查看全部钱包标签的定义（与说明页同一数据源）")}
            style={{
              border: 0,
              background: "none",
              padding: 0,
              font: "inherit",
              fontSize: "var(--t-md)",
              color: "var(--ww-link)",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {t("标签说明")}
          </button>
        </span>
      </div>

      {/* Active view table */}
      {view === "scorecard" && <ScorecardSection sc={data?.scorecard} t={t} />}
      {view === "league" && <LeagueSection lg={data?.league} t={t} />}
      {view === "candidates" ? (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th style={{ width: 150 }}>{t("钱包")}</th>
                <th>{t("标签")}</th>
                <th
                  className="is-right"
                  style={{ width: 90 }}
                  title={t(
                    "各渠道去重市场数之和（同一市场被两个渠道命中计两次——两种独立行为签名强于一种）",
                  )}
                >
                  {t("复发广度")}
                </th>
                <th>{t("最近证据")}</th>
                <th className="is-right" style={{ width: 170 }}>
                  {t("状态")}
                </th>
              </tr>
            </thead>
            <tbody>
              {(filtered as CandidateRow[]).map((c) => (
                <Fragment key={c.address}>
                  {/* 行没有任何行级强调：没有左边线、没有字号跳档、没有整行
                      染色 —— 轻重全靠状态徽章的颜色。 */}
                  <tr
                    onClick={() => toggleExpand(c.address)}
                    style={{ cursor: "pointer" }}
                    title={t("点击展开证据明细")}
                  >
                    <td data-label={t("钱包")}>{walletCell(c.address)}</td>
                    <td className="cell-wrap" data-label={t("标签")}>
                      <WalletTagChips tags={c.tags} max={4} />
                    </td>
                    <td className="mono is-right" data-label={t("复发广度")}>
                      {c.totalMarkets}
                    </td>
                    {/* 市场名 / 证据说明永不截断：换行、顶对齐，时间落到副行。 */}
                    <td
                      className="cell-wrap"
                      style={{ maxWidth: 380 }}
                      data-label={t("最近证据")}
                    >
                      {c.latestNote}
                      <div
                        style={{
                          marginTop: 5,
                          fontSize: "var(--t-sm)",
                          color: "var(--ww-text-muted)",
                        }}
                      >
                        {fmtAgo(c.lastTs, t)}
                      </div>
                    </td>
                    <td className="is-right" data-label={t("状态")}>
                      {statusTag(c.status, t)}
                    </td>
                  </tr>
                  {expanded.has(c.address) && (
                    <EvidenceDetailRows evidence={c.evidence} colSpan={5} />
                  )}
                </Fragment>
              ))}
              {loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="ds-empty">{t("加载中…")}</div>
                  </td>
                </tr>
              )}
              {/* 空态给内容也给出路，绝不留一片空白。 */}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="ds-empty">
                      {rows.length === 0
                        ? t(
                            "暂无候选 —— 证据由共识循环（每 5 分钟）与每日已结算市场扫描持续积累",
                          )
                        : t("无匹配 —— 试试清除搜索或标签筛选")}
                      {(activeTags.size > 0 || q) && (
                        <div style={{ marginTop: "var(--s-3)" }}>
                          <button
                            className="ds-btn ds-btn--sm"
                            onClick={() => {
                              setActiveTags(new Set());
                              setQuery("");
                            }}
                          >
                            {t("清除")}
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {/* 卡底说明条 —— 灰 = 口径 / 装载上限说明。 */}
          {data && data.counts.candidateWallets > data.candidates.length && (
            <div className="note-strip">
              {t("仅加载复发广度前 {n} 名（30 天窗口内共 {m} 个候选钱包）", {
                n: data.candidates.length,
                m: data.counts.candidateWallets,
              })}
            </div>
          )}
        </div>
      ) : view === "members" ? (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th style={{ width: 130 }}>{t("钱包")}</th>
                <th>{t("标签")}</th>
                <th className="is-right" style={{ width: 80 }}>
                  {t("评分")}
                </th>
                <th className="is-right" style={{ width: 80 }}>
                  {t("胜率")}
                </th>
                <th className="is-right" style={{ width: 110 }}>
                  {t("净盈亏")}
                </th>
                <th
                  className="is-right"
                  style={{ width: 110 }}
                  title={t(
                    "最近一次通过播种/重认证确认资格的时间；30 天不再合格自动出池",
                  )}
                >
                  {t("最近确认")}
                </th>
              </tr>
            </thead>
            <tbody>
              {(filtered as MemberRow[]).map((a) => (
                <Fragment key={a.address}>
                  <tr
                    onClick={() => toggleExpand(a.address)}
                    style={{ cursor: "pointer" }}
                    title={t("点击展开证据明细")}
                  >
                    <td data-label={t("钱包")}>{walletCell(a.address)}</td>
                    <td className="cell-wrap" data-label={t("标签")}>
                      <WalletTagChips tags={a.tags} max={4} />
                      {(a.styleTags ?? []).length > 0 && (
                        <span
                          style={{
                            display: "block",
                            marginTop: 5,
                            fontSize: "var(--t-sm)",
                            color: "var(--ww-text-muted)",
                          }}
                        >
                          {(a.styleTags ?? [])
                            .map((k) => styleLabel(k, t))
                            .join(" · ")}
                        </span>
                      )}
                    </td>
                    {/* `—` 是「判不了」，不是零 —— 用 muted 与真实 0 分家。 */}
                    <td className="mono is-right" data-label={t("评分")}>
                      {a.score != null ? (
                        Math.round(a.score)
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="mono is-right" data-label={t("胜率")}>
                      {a.winRate != null ? (
                        `${Math.round(a.winRate * 100)}%`
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    {/* 净盈亏是真正的盈亏方向，涨绿跌红成立（成本类才中性）。 */}
                    <td
                      className="mono is-right"
                      data-label={t("净盈亏")}
                      style={
                        a.netPnl != null
                          ? {
                              color:
                                a.netPnl >= 0
                                  ? "var(--ww-up)"
                                  : "var(--ww-down)",
                            }
                          : undefined
                      }
                    >
                      {a.netPnl != null ? (
                        fmtSignedUsdCompact(a.netPnl)
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="mono is-right" data-label={t("最近确认")}>
                      {a.updatedAt != null ? (
                        fmtAgo(a.updatedAt, t)
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                  {expanded.has(a.address) && (
                    <EvidenceDetailRows evidence={a.evidence} colSpan={6} />
                  )}
                </Fragment>
              ))}
              {loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="ds-empty">{t("加载中…")}</div>
                  </td>
                </tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="ds-empty">
                      {rows.length === 0
                        ? t(
                            "暂无 —— 候选通过准入审查（复发 ≥3 + 战绩闸）或分类榜播种后出现在这里",
                          )
                        : t("无匹配 —— 试试清除搜索或标签筛选")}
                      {(activeTags.size > 0 || q) && (
                        <div style={{ marginTop: "var(--s-3)" }}>
                          <button
                            className="ds-btn ds-btn--sm"
                            onClick={() => {
                              setActiveTags(new Set());
                              setQuery("");
                            }}
                          >
                            {t("清除")}
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {/* 卡底琥珀条 —— `—` 的三种成因写在数据旁边，不写在脚注里。 */}
          <div className="note-strip note-strip--warn">
            ⚠️{" "}
            {t(
              "评分 / 胜率 / 净盈亏 的 — 是「判不了」，不是零：该钱包还没有回填战绩快照（榜单播种的成员在首次重认证后补齐）。最近确认 的 — 表示来源未记录确认时间。",
            )}
          </div>
        </div>
      ) : null}

      {/* Signal-density trend (P0.9): fired ÷ avg window volume per day.
          Falling density under stable heat = thresholds drifted out of tune;
          falling heat with stable density = the market itself cooled.
          位置：漏斗页的骨架是「KPI → 筛选条 → 主表卡」，密度趋势是主表
          之外的第二块数据，因此移到主表下方，不再插在筛选条之前。 */}
      {density && density.length > 0 && (
        <section
          aria-label={t("信号密度")}
          style={{ marginTop: "var(--s-6)", marginBottom: "var(--s-4)" }}
        >
          <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
            📈 {t("信号密度（14 天） · 共识推送 ÷ 平均窗口量 + 发现渠道日产出")}
          </div>
          {/* 口径先行：原本只挂在小标的 title 上，触屏读不到 —— 提成常驻灰框。 */}
          <div className="ds-callout" style={{ marginBottom: "var(--s-3)" }}>
            {t(
              "左侧列 = 共识信号引擎（每日推送 ÷ 当日平均 6h 窗口成交量，$1M 归一——窗口滚动重叠不能求和，平均窗口量是热度的无偏代理）；「新证据」列 = 发现渠道当日首次入账的候选证据行。密度随热度同跌 = 市场降温；热度稳定密度独跌 = 阈值需重校",
            )}
          </div>
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead>
                <tr>
                  <th>{t("日期")}</th>
                  <th className="is-right">{t("共识轮")}</th>
                  <th className="is-right">{t("平均窗口量")}</th>
                  <th className="is-right">{t("原始组")}</th>
                  <th className="is-right">{t("分歧剔除")}</th>
                  <th className="is-right">{t("推送")}</th>
                  <th
                    className="is-right"
                    title={t("推送 ÷ 平均窗口量（条/$1M）")}
                  >
                    {t("密度")}
                  </th>
                  <th
                    className="is-right"
                    title={t(
                      "发现渠道（共识同行/拆单建仓/内幕签名/早期赢家）当日首次入账的证据行数",
                    )}
                  >
                    {t("新证据")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {density.map((d) => (
                  <tr key={d.day}>
                    <td className="mono" data-label={t("日期")}>
                      {d.day}
                    </td>
                    <td className="mono is-right" data-label={t("共识轮")}>
                      {d.cycles}
                    </td>
                    <td className="mono is-right" data-label={t("平均窗口量")}>
                      ${(d.avgWindowUsd / 1_000_000).toFixed(2)}M
                    </td>
                    <td className="mono is-right" data-label={t("原始组")}>
                      {d.rawGroups}
                    </td>
                    <td
                      className="mono is-right muted"
                      data-label={t("分歧剔除")}
                    >
                      {d.contestedDropped}
                    </td>
                    <td className="mono is-right" data-label={t("推送")}>
                      {d.fired}
                    </td>
                    <td className="mono is-right" data-label={t("密度")}>
                      {t("{n} 条/$1M", { n: d.perM.toFixed(2) })}
                    </td>
                    <td className="mono is-right" data-label={t("新证据")}>
                      {d.evidenceNew}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Tag definitions dialog — same data source as /glossary (WALLET_TAGS) */}
      <Modal
        open={tagHelpOpen}
        onClose={() => setTagHelpOpen(false)}
        title={
          <>
            <span className="ds-label" style={{ display: "block" }}>
              🏷 {t("标签说明")}
            </span>
            <span style={{ display: "block", marginTop: 4 }}>
              {t("钱包标签说明")}
            </span>
          </>
        }
        width={720}
      >
        {/* 说明文字里原来写着「点击下方标签可直接按其筛选当前列表」，
            但这张表从来不可点 —— 改成实际成立的一句。 */}
        <div className="ds-callout" style={{ marginBottom: "var(--s-4)" }}>
          {t(
            "与「说明」页同一数据源；列表与筛选条里的任意标签，悬停都能看到同一句提示。",
          )}
        </div>
        {/* 弹窗里不套第二层卡（readme §5：弹窗只有标题条 + 内容区两层）——
            与白名单弹窗同一处理，只留横向滚动兜底。 */}
        <div style={{ overflowX: "auto" }}>
          <table className="ds-table">
            <thead>
              <tr>
                <th style={{ width: 150 }}>{t("标签")}</th>
                <th style={{ width: 86 }}>{t("类别")}</th>
                <th>{t("定义")}</th>
              </tr>
            </thead>
            <tbody>
              {/* 词表串（name/kind/detail）过 t()，译文由 glossary 分片统一供给。 */}
              {WALLET_TAGS.map((w) => (
                <tr key={w.keyPrefix}>
                  <td style={{ whiteSpace: "nowrap" }} data-label={t("标签")}>
                    <Tag>
                      {w.icon} {t(w.name)}
                    </Tag>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }} data-label={t("类别")}>
                    {t(w.kind)}
                  </td>
                  <td className="cell-wrap" data-label={t("定义")}>
                    {t(w.detail)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    </main>
  );
}
