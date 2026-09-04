"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useParams } from "next/navigation";
import {
  AgeBadge,
  CopyButton,
  MarketSlugActions,
  SideTag,
  StatCard,
  Tag,
  WalletLink,
  catLabel,
  fmtSignedUsdCompact,
  type SmartInfoLite,
  type WalletStatsLite,
} from "../../ui";
import { useLang } from "../../i18n";
import { WalletTagChips } from "../../walletTagChips";
import SelfTestBlock from "./SelfTestBlock";
import { subLabel } from "../../../lib/categoryLabel";
import type { WalletTag } from "../../../lib/walletTags";

type PriceBand = { from: number; to: number; buyUsd: number; buyCount: number };
type MarketFocus = {
  conditionId: string;
  title: string;
  eventSlug: string;
  buyUsd: number;
  sellUsd: number;
  netUsd: number;
  trades: number;
  lastTs: number;
  category: string | null;
  // 二级分类(可选以对旧响应宽容)。市场行标签合成「体育·NBA」;上面的
  // 类别集中度 chips 保持一级聚合(评分/画像键稳定,见二级分类设计 §2)。
  subcategory?: string | null;
};
type Profile = {
  tradeCount: number;
  buyUsd: number;
  sellUsd: number;
  avgTradeUsd: number;
  smallBuyShare: number | null;
  priceBands: PriceBand[];
  topMarkets: MarketFocus[];
  firstTs: number | null;
  lastTs: number | null;
};
type AlertHit = {
  type: string;
  createdAt: number;
  title: string;
  outcome: string;
  side: string;
  usd: number;
  price: number | null;
  // "" when the recorded payload carried no event slug (very old rows).
  eventSlug: string;
};
type RecentTrade = {
  timestamp: number;
  side: "BUY" | "SELL";
  usdcSize: number;
  price: number;
  title: string;
  outcome: string;
  eventSlug: string;
};
type Holding = {
  title: string;
  conditionId: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  endDate: string | null;
};
type HoldingsSummary = {
  holdings: Holding[];
  totalValue: number;
  totalCashPnl: number;
  count: number;
  truncated: boolean;
};
type WalletResponse = {
  address: string;
  firstTs: number | null;
  ageDays: number | null;
  stats: WalletStatsLite | null;
  smart: SmartInfoLite | null;
  // Derived tags (lib/walletTags): pool source, discovery-channel evidence, bot.
  tags?: WalletTag[];
  // Live PUSD (Polymarket cash) balance in USD; null = RPC unavailable.
  pusdBalance: number | null;
  // null = 降级响应里没有实时画像(内存缓存也不温)。本地区块照常渲染。
  profile: Profile | null;
  // Current live (unresolved) positions — the wallet's active book.
  holdings: HoldingsSummary;
  categories: { category: string; usd: number; share: number }[];
  alertHits: AlertHit[];
  // Coverage window of alertHits in days (the API bounds the LIKE scan).
  alertHitsWindowDays?: number;
  // 价格影响持久性(2026-08-28 八件套,lib/priceImpact 的本地统计;
  // null/缺失 = 现算降级或旧响应,整块省略)。
  impact?: {
    n: number;
    measured: number;
    retained: number;
    rate: number | null;
    ciLo: number | null;
    ciHi: number | null;
    markets: number;
    medImpactCents: number | null;
    med24hCents: number | null;
    verdict: "followed" | "faded" | "mixed" | "insufficient";
  } | null;
  // 交易风格(2026-08-28 八件套):池内钱包的规则型标签 + 池内最近邻。
  style?: { tags: string[]; alerts: number; similar: string[] } | null;
  recent: RecentTrade[];
  // 降级标志(见 route.localOnlyDossier):被限流/上游故障时仍回 200 + 本地
  // 档案,客户端按 retryAfterSec 倒计时自动重试实时层。
  degraded?: "rate_limited" | "upstream_error";
  retryAfterSec?: number;
  error?: string;
};

function fmtUsd(usd: number): string {
  return usd.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// 表内时间走设计稿口径 `06-28 14:02`（月-日 时:分，24 小时制）—— 年份与秒对
// 一行成交没有信息量，挤在表格里只会把「市场名」的宽度吃掉。完整时间戳仍在
// title 里悬停可得（下面的 fmtDateTimeFull），信息一点不丢。
// 分隔符必须手拼：toLocaleString 的日期分隔符随 locale 变（zh-CN 出
// `06/28 22:02`、en-US 还多一个逗号），拿不到设计稿的短横线。
function fmtDateTime(sec: number): string {
  const d = new Date(sec * 1000);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 页头「分析窗口」是页面级口径，不是表格里的一行 —— 钱包首笔成交可能在几年
// 前，年份丢了读者就分不出这个窗口是一个月还是十三个月。14px 描述行没有宽度
// 压力，年份写在正文里，不靠悬停找回。
function fmtDateTimeWithYear(sec: number): string {
  return `${new Date(sec * 1000).getFullYear()}-${fmtDateTime(sec)}`;
}

function fmtDateTimeFull(sec: number, locale: string): string {
  return new Date(sec * 1000).toLocaleString(locale, { hour12: false });
}

// 「判不了」的破折号 —— 与 0 严格分家(globals 的 .faint)。成因写在各表
// 下方的琥珀说明条里。
function Dash() {
  return <span className="faint">—</span>;
}

// 结果名的灰底名称标签(Etherscan name tag,设计稿里的 `NO` / `UNDER`)——
// 名称标签走标准 .ds-tag（22px / 12px，§3 把 11px 留给徽章内、12px 给名称
// 标签），与同页告警类型标签同号。
// 结果名永不截断 —— 定高的 .ds-tag 是 nowrap 的,这里放开高度让长结果名
// 换行(最多两行,line-height 1.35),几何上与 22px 标签基本同高。
function OutcomeTag({ children }: { children: ReactNode }) {
  return (
    <span
      className="ds-tag"
      style={{
        height: "auto",
        minHeight: "var(--h-tag)",
        padding: "2px var(--s-2)",
        whiteSpace: "normal",
        overflowWrap: "anywhere",
        lineHeight: "var(--lh-snug)",
      }}
    >
      {children}
    </span>
  );
}

// 双栏概览卡里的一格。`.kpi` 靠 gap:1px + 容器底色画分格线,所以每一格都得
// 铺满自己的轨道(display:grid 让 .kpi-card 撑满),否则空轨道会露出边框色。
// 奇数格时最后一格跨满两列 —— 与设计稿「更多信息」栏的第三格同一处理。
function KpiSlot({ full, children }: { full?: boolean; children: ReactNode }) {
  return (
    <div
      style={{ display: "grid", ...(full ? { gridColumn: "1 / -1" } : null) }}
    >
      {children}
    </div>
  );
}

// 概览卡的一栏:12px 大写小标条 + 2 列分格网格。
function OverviewColumn({
  title,
  cells,
}: {
  title: string;
  cells: { id: string; node: ReactNode }[];
}) {
  return (
    <div style={{ background: "var(--ww-surface)", minWidth: 0 }}>
      <div
        className="ds-label"
        style={{
          padding: "var(--s-3) var(--s-5)",
          borderBottom: "1px solid var(--ww-border)",
        }}
      >
        {title}
      </div>
      <div
        className="kpi"
        style={{
          border: 0,
          borderRadius: 0,
          boxShadow: "none",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        }}
      >
        {cells.map((c, i) => (
          <KpiSlot
            key={c.id}
            full={cells.length % 2 === 1 && i === cells.length - 1}
          >
            {c.node}
          </KpiSlot>
        ))}
      </div>
    </div>
  );
}

// 交易风格标签译名(lib/walletFingerprint 的 ASCII 键;coverage 闸只认页面
// 静态 t() 字面量,故逐键写死 —— /discovery 的 styleLabel 同一套词表)。
function styleTagLabel(
  key: string,
  t: (zh: string, params?: Record<string, string | number>) => string,
): string {
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

const ALERT_TYPE_LABEL: Record<string, string> = {
  large: "💰 大单",
  smart: "🏆 聪明钱",
  consensus: "🔥 共识",
};

export default function WalletPage() {
  const params = useParams<{ address: string }>();
  const address = (params?.address ?? "").toLowerCase();
  const [data, setData] = useState<WalletResponse | null>(null);
  const [error, setError] = useState<string>("");
  const { lang, t } = useLang();
  // 日期本地化:zh 沿用 zh-CN,en 用 en-US(格式随语言,数值不变)。
  const dtLocale = lang === "en" ? "en-US" : "zh-CN";
  // catLabelFine 的翻译版:一级/二级各自过 t()后按原规则合成(「体育·NBA」),
  // 合成串不进字典 —— 组合爆炸,只译词元(见 lib/categoryLabel 同款规则)。
  const catFineT = (
    category: string | null | undefined,
    subcategory: string | null | undefined,
  ): string => {
    const primary = t(catLabel(category));
    if (!subcategory) return primary;
    const sub = t(subLabel(subcategory));
    return sub === primary ? primary : `${primary}·${sub}`;
  };

  // ---- 加载与自动重试 ----------------------------------------------------
  // 死端是这个页面此前最大的失败模式:限流/上游故障 → 一条红字,用户只能
  // 手动刷新。现在:降级响应(本地档案)照常渲染 + 按服务端给的
  // retryAfterSec 倒计时自动重试;硬错误(网络断等)走 10→20→40→60s 阶梯,
  // 同样自动重试。重试期间**不清空屏上已有数据**,实时层到货后静默升级。
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!address) return;
    setRetryAt(null);
    const scheduleLadder = () => {
      const delay = Math.min(60, 10 * 2 ** Math.min(attemptRef.current, 3));
      attemptRef.current++;
      setRetryAt(Date.now() + delay * 1000);
    };
    try {
      const res = await fetch(`/api/wallet/${address}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as WalletResponse;
      if (!mountedRef.current) return;
      if (json.error) {
        setError(json.error);
        scheduleLadder();
        return;
      }
      setError("");
      setData(json);
      if (json.degraded) {
        attemptRef.current++;
        setRetryAt(Date.now() + (json.retryAfterSec ?? 60) * 1000);
      } else {
        attemptRef.current = 0;
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
      scheduleLadder();
    }
  }, [address]);

  useEffect(() => {
    void load();
  }, [load]);

  // 到点触发重试;倒计时显示走每秒 tick(只在有排期时跑)。
  useEffect(() => {
    if (retryAt == null) return;
    const timer = setTimeout(
      () => void load(),
      Math.max(0, retryAt - Date.now()),
    );
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    setNowMs(Date.now());
    return () => {
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, [retryAt, load]);

  const retrySecsLeft =
    retryAt != null ? Math.max(0, Math.ceil((retryAt - nowMs) / 1000)) : null;

  const p = data?.profile;
  const maxBandUsd = p ? Math.max(1, ...p.priceBands.map((b) => b.buyUsd)) : 1;

  // ---- 纯展示派生量(条件与改造前逐条一致,只是提到 JSX 外面复用) ----
  const alertWindowDays = data?.alertHitsWindowDays ?? 90;
  const holdingsCount = data?.holdings?.count ?? 0;
  const showHoldings = !!data?.holdings && holdingsCount > 0;
  const showHoldingsEmpty =
    !!data?.holdings && holdingsCount === 0 && !data?.degraded;
  const impact = data?.impact;
  const showImpact = !!impact && impact.n > 0;
  const impactMeasured =
    !!impact && impact.verdict !== "insufficient" && impact.rate != null;
  const styleInfo = data?.style;
  const showStyle = !!styleInfo && styleInfo.tags.length > 0;

  // 概览卡「已结算口径」栏 —— 四格恒定(缺数据给「—」+ 副行写成因)。
  const overviewCells: { id: string; node: ReactNode }[] = data
    ? [
        {
          id: "winrate",
          node: (
            <StatCard label={t("已结算胜率")} icon="📐">
              <div
                className="kpi-value"
                title={
                  data.stats?.isMarketMaker
                    ? t(
                        "高频做市/机器人(交易过大量不同市场):做市赚点差、非定向下注,胜率不适用",
                      )
                    : data.stats?.truncated
                      ? t(
                          "已结算市场过多,只能取到按盈亏排序的最赚一部分(赢家偏差),胜率无法可靠统计",
                        )
                      : undefined
                }
              >
                {data.stats?.isMarketMaker ? (
                  "🤖"
                ) : data.stats?.winRate != null ? (
                  `${Math.round(data.stats.winRate * 100)}%`
                ) : (
                  <Dash />
                )}
              </div>
              <div className="kpi-sub">
                {!data.stats
                  ? t("无数据")
                  : data.stats.isMarketMaker
                    ? t("高频做市/机器人 · {n} 市场 · 胜率不适用", {
                        n:
                          data.stats.marketsTraded?.toLocaleString() ??
                          t("海量"),
                      })
                    : data.stats.truncated
                      ? t("{n}+ 个已结算市场 · 过多,胜率不可靠", {
                          n: data.stats.settledCount,
                        })
                      : t("{n} 个已结算市场", {
                          n: data.stats.settledCount,
                        })}
              </div>
            </StatCard>
          ),
        },
        {
          id: "pnl",
          node: (
            <StatCard label={t("净盈亏")} icon="💰">
              <div
                className={
                  data.stats?.netPnl == null
                    ? "kpi-value"
                    : `kpi-value ${data.stats.netPnl < 0 ? "down" : "up"}`
                }
                title={t(
                  "Polymarket 口径净盈亏（已实现 + 当前持仓浮动盈亏），取自官方 user-pnl 曲线，与主页 Profit/loss 一致",
                )}
              >
                {data.stats?.netPnl != null ? (
                  fmtSignedUsdCompact(data.stats.netPnl)
                ) : (
                  <Dash />
                )}
              </div>
              <div className="kpi-sub">
                {t("已结算 ROI")}{" "}
                {data.stats?.roi != null ? (
                  `${(data.stats.roi * 100).toFixed(1)}%`
                ) : (
                  <Dash />
                )}
              </div>
            </StatCard>
          ),
        },
        {
          id: "pusd",
          node: (
            <StatCard label={t("PUSD 现金余额")} icon="💵">
              <div className="kpi-value">
                {data.pusdBalance != null ? (
                  `$${fmtUsd(data.pusdBalance)}`
                ) : (
                  <Dash />
                )}
              </div>
              <div
                className="kpi-sub"
                title={t(
                  "Polymarket 账户内未下注的现金（链上 PUSD 余额，实时查询）",
                )}
              >
                {data.pusdBalance != null
                  ? t("账户内可用资金")
                  : t("RPC 暂不可用")}
              </div>
            </StatCard>
          ),
        },
        {
          id: "alerts",
          node: (
            <StatCard
              label={t("近 {d} 天告警", { d: alertWindowDays })}
              icon="📣"
            >
              <div className="kpi-value">
                {data.alertHits.length.toLocaleString()}
              </div>
              <div className="kpi-sub">{t("本工具发出")}</div>
            </StatCard>
          ),
        },
      ]
    : [];

  // 概览卡「更多信息」栏 —— 有几项算几项(实时画像/影响/风格都可能缺席)。
  const moreCells: { id: string; node: ReactNode }[] = [];
  if (data && (showHoldings || showHoldingsEmpty)) {
    moreCells.push({
      id: "holdings",
      node: (
        <StatCard label={t("当前持仓")} icon="🐳">
          <div className="kpi-value">
            {t("{n} 个活仓", { n: holdingsCount })}
          </div>
          <div className="kpi-sub">
            {t("总市值 ${v}", { v: fmtUsd(data.holdings.totalValue) })}
          </div>
        </StatCard>
      ),
    });
  }
  if (p) {
    moreCells.push({
      id: "flow",
      node: (
        <StatCard label={t("近窗买入 / 卖出")} icon="📊">
          <div className="kpi-value">
            <span className="up">${fmtUsd(p.buyUsd)}</span>
            <span className="muted"> / </span>
            <span className="down">${fmtUsd(p.sellUsd)}</span>
          </div>
          <div className="kpi-sub">
            {t("平均每笔 ${n}", { n: fmtUsd(p.avgTradeUsd) })}
          </div>
        </StatCard>
      ),
    });
    moreCells.push({
      id: "split",
      node: (
        <StatCard label={t("拆单倾向")} icon="🧩">
          <div className="kpi-value">
            {p.smallBuyShare != null ? (
              `${Math.round(p.smallBuyShare * 100)}%`
            ) : (
              <Dash />
            )}
          </div>
          <div className="kpi-sub">{t("买单中 <$1k 的占比")}</div>
        </StatCard>
      ),
    });
  }
  if (impact && impactMeasured) {
    moreCells.push({
      id: "impact",
      node: (
        <StatCard label={t("初动留存率")} icon="📡">
          <div className="kpi-value">
            {Math.round((impact.rate ?? 0) * 100)}%
          </div>
          <div className="kpi-sub">
            {t("95% 区间 {lo}–{hi}% · {k} 个市场", {
              lo: Math.round((impact.ciLo ?? 0) * 100),
              hi: Math.round((impact.ciHi ?? 1) * 100),
              k: impact.markets,
            })}
          </div>
        </StatCard>
      ),
    });
  }
  if (styleInfo && styleInfo.similar.length > 0) {
    moreCells.push({
      id: "similar",
      node: (
        <StatCard label={t("风格最像的池内钱包")} icon="🔥">
          <div className="kpi-value">
            {styleInfo.similar.map((w, i) => (
              <span key={w}>
                {i > 0 && " · "}
                <WalletLink address={w}>
                  {w.slice(0, 6)}…{w.slice(-4)}
                </WalletLink>
              </span>
            ))}
          </div>
          <div className="kpi-sub">
            {t("近 90 天告警样本 {n} 条", { n: styleInfo.alerts })}
          </div>
        </StatCard>
      ),
    });
  }

  // 档案分区导航 —— Etherscan 地址页的 tab 行语法。这里每一项都是锚点跳转
  // (不是互斥切换):全部区块始终在页面上,tab 行只负责「跳到哪一段」。
  const sections: { id: string; label: string }[] = [];
  if (data) {
    if (showHoldings || showHoldingsEmpty)
      sections.push({
        id: "wallet-holdings",
        label: `${t("当前持仓")} ${holdingsCount}`,
      });
    if (data.categories.length > 0)
      sections.push({ id: "wallet-categories", label: t("专攻类别") });
    if (p) {
      sections.push({ id: "wallet-bands", label: t("买入赔率带") });
      sections.push({ id: "wallet-top-markets", label: t("头部市场") });
    }
    sections.push({
      id: "wallet-hits",
      label: `${t("历史命中")} ${data.alertHits.length}`,
    });
    if (showImpact)
      sections.push({ id: "wallet-impact", label: t("价格影响") });
    if (showStyle) sections.push({ id: "wallet-style", label: t("交易风格") });
    if (p)
      sections.push({
        id: "wallet-recent",
        label: `${t("最近成交")} ${data.recent.length}`,
      });
    sections.push({ id: "wallet-selftest", label: t("聪明钱自测判决") });
  }

  return (
    <main className="ds-main">
      {/* 页头 —— 12px 小标 + 22px 钱包地址 + 名称标签行;右侧外链钮。
          地址是全站唯一做首尾省略的东西(市场名/结果名永不截断)。 */}
      <header className="page-head" style={{ alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div className="page-head__eyebrow">{t("🕵️ 钱包档案")}</div>
          <div
            style={{
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              gap: "var(--s-2)",
              flexWrap: "wrap",
            }}
          >
            <h1
              className="page-head__title"
              style={{ margin: 0, fontSize: 22 }}
              title={address}
            >
              {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ""}
            </h1>
            {address ? <CopyButton text={address} /> : null}
            {data ? <AgeBadge ageDays={data.ageDays} /> : null}
            {data?.smart ? (
              // 灰底名称标签(Etherscan name tag)。白名单时字色转绿 —— 绿是
              // 「过闸/正常」,底色不承担状态。
              <span
                className="ds-tag"
                style={
                  data.smart.isWhitelist ? { color: "var(--ww-up)" } : undefined
                }
              >
                {t("🏆 聪明钱")}
                {data.smart.score != null
                  ? t(" · 评分 {n}", { n: Math.round(data.smart.score) })
                  : ""}
                {data.smart.isWhitelist ? t(" · 手动白名单") : ""}
              </span>
            ) : null}
            {data?.stats?.isMarketMaker ? (
              <Tag variant="warn">
                {t("🤖 高频做市 / 机器人")}
                {data.stats.marketsTraded != null
                  ? t(" · {n} 市场", {
                      n: data.stats.marketsTraded.toLocaleString(),
                    })
                  : ""}
              </Tag>
            ) : null}
            {/* Derived tags (same model as /discovery): pool-source attribution
                and discovery-channel evidence. bot/whitelist are filtered out —
                the richer badges above already carry them. */}
            {data?.tags ? (
              <WalletTagChips
                tags={data.tags.filter(
                  (tag) => tag.key !== "bot" && tag.key !== "whitelist",
                )}
              />
            ) : null}
          </div>
          {p?.firstTs && p?.lastTs ? (
            <p
              className="page-head__desc"
              title={`${fmtDateTimeFull(p.firstTs, dtLocale)} → ${fmtDateTimeFull(p.lastTs, dtLocale)}`}
            >
              {t("分析窗口：近 {n} 笔成交（{from} → {to}）", {
                n: p.tradeCount,
                from: fmtDateTimeWithYear(p.firstTs),
                to: fmtDateTimeWithYear(p.lastTs),
              })}
            </p>
          ) : null}
        </div>
        <div className="page-head__actions">
          <a
            className="ds-btn"
            href={`https://polymarket.com/profile/${address}`}
            target="_blank"
            rel="noreferrer"
          >
            {t("Polymarket 主页 ↗")}
          </a>
          <a
            className="ds-btn"
            href={`https://polygonscan.com/address/${address}`}
            target="_blank"
            rel="noreferrer"
          >
            Polygonscan ↗
          </a>
        </div>
      </header>

      {/* 口径条放在数据前面:降级 = 需留神的口径(琥珀),不是错误。 */}
      {data?.degraded && !error ? (
        <div
          className="ds-callout ds-callout--warn"
          style={{ marginBottom: "var(--s-4)" }}
        >
          {data.degraded === "rate_limited"
            ? t("⏳ 实时档案被限流（公共接口预算已满）——先展示本地留存数据。")
            : t("⚠️ 上游接口暂时不可用——先展示本地留存数据。")}
          {retrySecsLeft != null ? (
            <> {t("{n}s 后自动重试", { n: retrySecsLeft })}</>
          ) : null}
          <button
            className="ds-btn ds-btn--sm"
            style={{ marginLeft: 8 }}
            onClick={() => void load()}
          >
            {t("立即重试")}
          </button>
        </div>
      ) : null}

      {error ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-4)" }}
        >
          {t("加载失败")}: {error}
          {retrySecsLeft != null ? (
            <> · {t("{n}s 后自动重试", { n: retrySecsLeft })}</>
          ) : null}
          <button
            className="ds-btn ds-btn--sm"
            style={{ marginLeft: 8 }}
            onClick={() => void load()}
          >
            {t("立即重试")}
          </button>
        </div>
      ) : null}

      {!data && !error ? (
        <div className="ds-empty">{t("档案加载中…")}</div>
      ) : null}

      {data ? (
        <>
          {/* 概览 / 更多信息 —— Etherscan 地址页的双栏卡。左栏是已结算口径的
              战绩与资金,右栏是实时层与池内派生量。格间 1px 分格线。 */}
          <section
            className="ds-card"
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(100%, 380px), 1fr))",
              gap: 1,
              background: "var(--ww-border)",
              overflow: "hidden",
              marginBottom: "var(--s-5)",
            }}
          >
            <OverviewColumn
              title={t("概览 · 已结算口径")}
              cells={overviewCells}
            />
            {moreCells.length > 0 ? (
              <OverviewColumn title={t("更多信息")} cells={moreCells} />
            ) : null}
          </section>

          {/* 分区导航(锚点跳转,不是互斥切换) */}
          {sections.length > 0 ? (
            <nav
              className="ds-card"
              aria-label={t("档案分区导航")}
              style={{ overflow: "hidden", marginBottom: "var(--s-5)" }}
            >
              <div
                className="ds-tabrow"
                style={{ borderBottom: 0, flexWrap: "wrap" }}
              >
                {/* globals 的 .ds-tabrow 只给 > button 上色,<a> 匹配不上,会
                    掉回全局链接蓝 + hover 下划线 —— 而蓝在 tab 行里是「当前
                    选中」的语义,一排全蓝等于宣称 8 个分区同时选中。这些是锚点
                    跳转,没有当前项,所以逐个补上未选中态的字色与去下划线。 */}
                {sections.map((s) => (
                  <a
                    key={s.id}
                    href={`#${s.id}`}
                    style={{
                      padding: "6px var(--s-3)",
                      borderRadius: "var(--r-btn)",
                      whiteSpace: "nowrap",
                      color: "var(--ww-text)",
                      textDecoration: "none",
                    }}
                  >
                    {s.label}
                  </a>
                ))}
              </div>
            </nav>
          ) : null}

          {/* Current holdings (live positions) */}
          {showHoldings ? (
            <section
              id="wallet-holdings"
              style={{ marginBottom: "var(--s-5)" }}
            >
              <div className="ds-table-wrap">
                {/* 卡内标题条走设计稿的「· 分段」语法，不用全角括号包一长串。 */}
                <div className="card-bar">
                  <span>
                    🐳{" "}
                    {t("当前持仓 · {n} 个活仓 · 总市值 ${v} · 浮动盈亏 ", {
                      n: data.holdings.count,
                      v: fmtUsd(data.holdings.totalValue),
                    })}
                    <span
                      className={
                        data.holdings.totalCashPnl >= 0 ? "up" : "down"
                      }
                    >
                      {fmtSignedUsdCompact(data.holdings.totalCashPnl)}
                    </span>
                    {data.holdings.truncated ? t(" · 仅前若干页") : ""}
                  </span>
                </div>
                <table className="ds-table">
                  <thead>
                    <tr>
                      <th>{t("市场 / 结果")}</th>
                      <th className="is-right">{t("份额")}</th>
                      <th
                        className="is-right"
                        title={t("按金额加权的建仓均价")}
                      >
                        {t("建仓均价")}
                      </th>
                      <th className="is-right">{t("现价")}</th>
                      <th className="is-right">{t("市值")}</th>
                      <th className="is-right">{t("浮动盈亏")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.holdings.holdings.map((h, i) => (
                      <tr key={`${h.eventSlug}-${h.outcome}-${i}`}>
                        <td className="cell-wrap" style={{ maxWidth: 360 }}>
                          {h.eventSlug ? (
                            <a
                              href={`https://polymarket.com/event/${h.eventSlug}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {h.title}
                            </a>
                          ) : (
                            h.title
                          )}
                          <div
                            style={{
                              marginTop: "var(--s-1)",
                              display: "flex",
                              alignItems: "center",
                              gap: "var(--s-1)",
                              flexWrap: "wrap",
                            }}
                          >
                            <OutcomeTag>{h.outcome}</OutcomeTag>
                            <MarketSlugActions
                              slug={h.slug}
                              eventSlug={h.eventSlug}
                              conditionId={h.conditionId}
                            />
                          </div>
                        </td>
                        <td className="is-right" data-label={t("份额")}>
                          {fmtUsd(h.size)}
                        </td>
                        {/* 成本类数字一律中性色:建仓均价不是盈亏。 */}
                        <td className="is-right" data-label={t("建仓均价")}>
                          {h.avgPrice.toFixed(3)}
                        </td>
                        <td className="is-right" data-label={t("现价")}>
                          {h.curPrice.toFixed(3)}
                        </td>
                        <td className="is-right" data-label={t("市值")}>
                          ${fmtUsd(h.currentValue)}
                        </td>
                        <td
                          className={`is-right ${h.cashPnl >= 0 ? "up" : "down"}`}
                          data-label={t("浮动盈亏")}
                        >
                          {fmtSignedUsdCompact(h.cashPnl)} (
                          {h.percentPnl >= 0 ? "+" : ""}
                          {h.percentPnl.toFixed(1)}%)
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="note-strip">
                  {t(
                    "建仓均价与现价是成本口径，一律中性色；只有浮动盈亏用涨绿跌红。",
                  )}
                </div>
              </div>
            </section>
          ) : showHoldingsEmpty ? (
            // 降级响应里的空持仓只是「没查」,不是「没有」—— 顶部横幅已交代,
            // 这里不渲染会撒谎的空态。
            <section
              id="wallet-holdings"
              style={{ marginBottom: "var(--s-5)" }}
            >
              <div className="ds-card" style={{ overflow: "hidden" }}>
                <div className="card-bar">🐳 {t("当前持仓")}</div>
                <div style={{ padding: "var(--s-4)" }}>
                  <div className="ds-empty">
                    {t("该钱包当前没有活跃持仓（或未查询到）")}
                    <div style={{ marginTop: "var(--s-2)" }}>
                      <a
                        className="ds-btn ds-btn--sm"
                        href={`https://polymarket.com/profile/${address}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("Polymarket 主页 ↗")}
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          {/* Category focus */}
          {data.categories.length > 0 ? (
            <section
              id="wallet-categories"
              style={{ marginBottom: "var(--s-5)" }}
            >
              <div className="ds-card" style={{ overflow: "hidden" }}>
                <div className="card-bar">
                  🎯 {t("专攻类别 · 按头部市场成交额")}
                </div>
                <div
                  style={{
                    padding: "var(--s-4)",
                    display: "flex",
                    gap: "var(--s-2)",
                    flexWrap: "wrap",
                  }}
                >
                  {data.categories.map((c) => (
                    <Tag key={c.category} variant="default">
                      {t(catLabel(c.category))} {Math.round(c.share * 100)}%
                    </Tag>
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          {/* Price-band histogram + top markets:实时画像(p)专属区块 */}
          {p ? (
            <>
              <section id="wallet-bands" style={{ marginBottom: "var(--s-5)" }}>
                <div className="ds-card" style={{ overflow: "hidden" }}>
                  <div className="card-bar">
                    📐 {t("买入赔率带分布 · 近 {n} 笔", { n: p.tradeCount })}
                  </div>
                  <div
                    style={{
                      padding: "var(--s-4)",
                      display: "flex",
                      flexDirection: "column",
                      gap: "var(--s-3)",
                    }}
                  >
                    {p.priceBands.map((b) => (
                      <div
                        key={b.from}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "var(--s-3)",
                        }}
                      >
                        <span
                          className="muted"
                          style={{
                            width: 86,
                            flexShrink: 0,
                            fontSize: "var(--t-base)",
                          }}
                        >
                          {b.from.toFixed(1)}–{b.to.toFixed(1)}
                        </span>
                        <div className="split-bar" style={{ flex: 1 }}>
                          <span
                            style={{
                              width: `${(b.buyUsd / maxBandUsd) * 100}%`,
                              background: "var(--ww-up)",
                            }}
                          />
                        </div>
                        <span
                          className="muted"
                          style={{
                            width: 140,
                            flexShrink: 0,
                            textAlign: "right",
                            fontSize: "var(--t-base)",
                          }}
                        >
                          ${fmtUsd(b.buyUsd)} · {t("{n}笔", { n: b.buyCount })}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              {/* Top markets */}
              <section
                id="wallet-top-markets"
                style={{ marginBottom: "var(--s-5)" }}
              >
                <div className="ds-table-wrap">
                  <div className="card-bar">🏟️ {t("头部市场 · 按成交额")}</div>
                  <table className="ds-table">
                    <thead>
                      <tr>
                        <th>{t("市场")}</th>
                        <th>{t("类别")}</th>
                        <th className="is-right">{t("买入")}</th>
                        <th className="is-right">{t("卖出")}</th>
                        <th className="is-right">{t("净买入")}</th>
                        <th className="is-right">{t("笔数")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.topMarkets.map((m) => (
                        <tr key={m.conditionId}>
                          <td className="cell-wrap" style={{ maxWidth: 360 }}>
                            {m.eventSlug ? (
                              <a
                                href={`https://polymarket.com/event/${m.eventSlug}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {m.title}
                              </a>
                            ) : (
                              m.title
                            )}
                          </td>
                          <td data-label={t("类别")}>
                            {m.category ? (
                              <span className="ds-tag ds-tag--sm">
                                {catFineT(m.category, m.subcategory)}
                              </span>
                            ) : (
                              <Dash />
                            )}
                          </td>
                          <td className="is-right up" data-label={t("买入")}>
                            ${fmtUsd(m.buyUsd)}
                          </td>
                          <td className="is-right down" data-label={t("卖出")}>
                            ${fmtUsd(m.sellUsd)}
                          </td>
                          <td className="is-right" data-label={t("净买入")}>
                            ${fmtUsd(m.netUsd)}
                          </td>
                          <td className="is-right" data-label={t("笔数")}>
                            {m.trades}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="note-strip note-strip--warn">
                    ⚠️{" "}
                    {t(
                      "类别栏的「—」= 上游没有给出分类标注，不是「其他」这一档。",
                    )}
                  </div>
                </div>
              </section>
            </>
          ) : null}

          {/* This tool's alert history for the wallet(本地台账,降级也在) */}
          <section id="wallet-hits" style={{ marginBottom: "var(--s-5)" }}>
            <div className="ds-table-wrap">
              <div className="card-bar">
                🏆{" "}
                {t("本工具历史命中 · 近 {d} 天 {n} 条", {
                  d: alertWindowDays,
                  n: data.alertHits.length,
                })}
              </div>
              {data.alertHits.length === 0 ? (
                // 空态给内容也给出路:这个钱包这段时间没被本站点过名,
                // 想看有谁被点过就去实时告警流。
                <div style={{ padding: "var(--s-4)" }}>
                  <div className="ds-empty">
                    {t("近 {d} 天内该钱包未触发过告警", {
                      d: alertWindowDays,
                    })}
                    <div style={{ marginTop: "var(--s-2)" }}>
                      <a className="ds-btn ds-btn--sm" href="/alerts">
                        {t("看全站实时告警")}
                      </a>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <table className="ds-table">
                    <thead>
                      <tr>
                        <th>{t("类型")}</th>
                        <th>{t("市场 / 结果")}</th>
                        <th>{t("方向")}</th>
                        <th className="is-right">{t("金额")}</th>
                        <th className="is-right">{t("价格")}</th>
                        <th className="is-right">{t("时间")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.alertHits.map((h, i) => (
                        <tr key={`${h.createdAt}-${i}`}>
                          <td data-label={t("类型")}>
                            <span className="ds-tag">
                              {ALERT_TYPE_LABEL[h.type]
                                ? t(ALERT_TYPE_LABEL[h.type])
                                : h.type}
                            </span>
                          </td>
                          <td className="cell-wrap" style={{ maxWidth: 340 }}>
                            {h.eventSlug ? (
                              <a
                                href={`https://polymarket.com/event/${h.eventSlug}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {h.title}
                              </a>
                            ) : (
                              h.title
                            )}
                            <div style={{ marginTop: "var(--s-1)" }}>
                              <OutcomeTag>{h.outcome}</OutcomeTag>
                            </div>
                          </td>
                          <td data-label={t("方向")}>
                            <SideTag side={h.side} />
                          </td>
                          <td className="is-right" data-label={t("金额")}>
                            ${fmtUsd(h.usd)}
                          </td>
                          <td className="is-right" data-label={t("价格")}>
                            {h.price != null ? h.price.toFixed(3) : <Dash />}
                          </td>
                          <td
                            className="is-right muted"
                            data-label={t("时间")}
                            title={fmtDateTimeFull(h.createdAt, dtLocale)}
                          >
                            {fmtDateTime(h.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="note-strip note-strip--warn">
                    ⚠️{" "}
                    {t(
                      "价格栏的「—」= 当时的告警载荷没有记录成交价，不是成交价为 0。",
                    )}
                  </div>
                </>
              )}
            </div>
          </section>

          {/* 价格影响持久性:他的告警落地后,市场初动有没有被留住。 */}
          {showImpact && impact ? (
            <section id="wallet-impact" style={{ marginBottom: "var(--s-5)" }}>
              <div className="ds-card" style={{ overflow: "hidden" }}>
                <div className="card-bar">
                  📡 {t("价格影响 · 告警后市场反应")}
                </div>
                {!impactMeasured ? (
                  <div
                    style={{
                      padding: "var(--s-4)",
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--s-3)",
                      flexWrap: "wrap",
                    }}
                  >
                    <Tag variant="warn">{t("样本不足")}</Tag>
                    <span className="ds-hint">
                      {t(
                        "样本不足：可测初动 {m} 条 · 覆盖 {k} 个市场（需 ≥8）",
                        {
                          m: impact.measured,
                          k: impact.markets,
                        },
                      )}
                    </span>
                  </div>
                ) : (
                  <div className="metric-grid">
                    <div>
                      <div className="metric__label">{t("判定")}</div>
                      {/* 徽章只给方向性判定:绿 = 被跟随、琥珀 = 被回吐。
                          「反应不一」是中性判定,退回普通文字 —— 灰底是名称
                          标签,五类语义里没有「中性状态徽章」这一档。 */}
                      {impact.verdict === "followed" ||
                      impact.verdict === "faded" ? (
                        <div className="metric__value">
                          <Tag
                            variant={
                              impact.verdict === "followed" ? "up" : "warn"
                            }
                          >
                            {impact.verdict === "followed"
                              ? t("被市场跟随")
                              : t("被市场回吐")}
                          </Tag>
                        </div>
                      ) : (
                        <div className="metric__value">{t("反应不一")}</div>
                      )}
                    </div>
                    <div>
                      <div className="metric__label">{t("初动留存率")}</div>
                      <div className="metric__value">
                        {Math.round((impact.rate ?? 0) * 100)}%
                      </div>
                      <div className="metric__sub">
                        {t("95% 区间 {lo}–{hi}% · {k} 个市场", {
                          lo: Math.round((impact.ciLo ?? 0) * 100),
                          hi: Math.round((impact.ciHi ?? 1) * 100),
                          k: impact.markets,
                        })}
                      </div>
                    </div>
                    {impact.medImpactCents != null &&
                    impact.med24hCents != null ? (
                      <div>
                        <div className="metric__label">
                          {t("中位初动 → 24h")}
                        </div>
                        <div className="metric__value">
                          +{impact.medImpactCents.toFixed(1)}¢ →{" "}
                          {impact.med24hCents.toFixed(1)}¢
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}
                {/* 口径条:免责那半句加粗独立成句（设计稿末句 600 字重），
                    读者不会把「描述统计」当成「可以跟」。 */}
                <div className="note-strip note-strip--warn">
                  ⚠️{" "}
                  {t(
                    "口径：初动 = 告警后 10 分钟的方向化价移（≥2¢ 才可测），留住 = 24h 后保住初动一半以上；区间按市场聚簇。",
                  )}{" "}
                  <strong style={{ fontWeight: 600 }}>
                    {t("这是市场对他的反应的描述统计，不是任何跟随建议。")}
                  </strong>
                </div>
              </div>
            </section>
          ) : null}

          {/* 交易风格(池内专属):规则型标签,每个都能一句话核对。 */}
          {showStyle && styleInfo ? (
            <section id="wallet-style" style={{ marginBottom: "var(--s-5)" }}>
              <div className="ds-card" style={{ overflow: "hidden" }}>
                <div className="card-bar">
                  🧭{" "}
                  {t("交易风格 · 池内 · 近 90 天告警样本 {n} 条", {
                    n: styleInfo.alerts,
                  })}
                </div>
                <div
                  style={{
                    padding: "var(--s-4)",
                    display: "flex",
                    gap: "var(--s-2)",
                    flexWrap: "wrap",
                  }}
                >
                  {styleInfo.tags.map((k) => (
                    <Tag key={k} variant="default">
                      {styleTagLabel(k, t)}
                    </Tag>
                  ))}
                </div>
                {styleInfo.similar.length > 0 ? (
                  <div className="note-strip">
                    {t("风格最像的池内钱包：")}
                    {styleInfo.similar.map((w, i) => (
                      <span key={w}>
                        {i > 0 && " · "}
                        <WalletLink address={w}>
                          {w.slice(0, 6)}…{w.slice(-4)}
                        </WalletLink>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* Recent trades(实时画像专属) */}
          {p ? (
            <section id="wallet-recent" style={{ marginBottom: "var(--s-5)" }}>
              <div className="ds-table-wrap">
                <div className="card-bar">
                  💰 {t("最近成交 · 近 {n} 笔", { n: data.recent.length })}
                </div>
                <table className="ds-table">
                  <thead>
                    <tr>
                      <th>{t("时间")}</th>
                      <th>{t("市场 / 结果")}</th>
                      <th>{t("方向")}</th>
                      <th className="is-right">{t("金额")}</th>
                      <th className="is-right">{t("价格")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((r, i) => (
                      <tr key={`${r.timestamp}-${i}`}>
                        <td
                          className="muted"
                          data-label={t("时间")}
                          title={fmtDateTimeFull(r.timestamp, dtLocale)}
                        >
                          {fmtDateTime(r.timestamp)}
                        </td>
                        <td className="cell-wrap" style={{ maxWidth: 360 }}>
                          {r.eventSlug ? (
                            <a
                              href={`https://polymarket.com/event/${r.eventSlug}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {r.title}
                            </a>
                          ) : (
                            r.title
                          )}
                          <div style={{ marginTop: "var(--s-1)" }}>
                            <OutcomeTag>{r.outcome}</OutcomeTag>
                          </div>
                        </td>
                        <td data-label={t("方向")}>
                          <SideTag side={r.side} />
                        </td>
                        <td className="is-right" data-label={t("金额")}>
                          ${fmtUsd(r.usdcSize)}
                        </td>
                        <td className="is-right" data-label={t("价格")}>
                          {r.price.toFixed(3)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      {/* 自测判决块:独立取数、点击加载 —— 档案降级时也可体检 */}
      {address ? <SelfTestBlock address={address} /> : null}
    </main>
  );
}
