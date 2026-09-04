"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  HoldingCell,
  MarketSlugActions,
  Segmented,
  SoundToggle,
  StatCard,
  Tag,
  WalletLink,
  catLabelFineT,
} from "../ui";
import { useLang } from "../i18n";
import { useMarketPositions } from "../useMarketPositions";
import { useSoundToggle } from "../useSound";
import { useNewRecordChime } from "../useNewRecordChime";
import {
  buildQueryString,
  parseChoiceParam,
  parseNumParam,
  replaceUrlQuery,
} from "../urlQuery";
import {
  DisagreementSection,
  type DisagreementMarket,
} from "../DisagreementSection";
import { WhitelistDialog } from "../WhitelistDialog";

type ConsensusWallet = {
  wallet: string;
  netUsd: number;
  buyCount: number;
  avgBuyPrice: number;
  score: number | null;
};

type ConsensusGroup = {
  conditionId: string;
  outcome: string;
  title: string;
  slug: string;
  eventSlug: string;
  wallets: ConsensusWallet[];
  walletCount: number;
  totalNetUsd: number;
  avgBuyPrice: number;
  firstTs: number;
  lastTs: number;
  currentPrice: number | null;
  category: string | null;
  // 二级分类(体育联盟等;可选以对旧响应宽容),标签合成「体育·NBA」。
  subcategory?: string | null;
  closed: boolean;
};

type ConsensusResponse = {
  filters: { hours: number; minWallets: number; minPerWalletUsd: number };
  smartCount: number;
  truncated: boolean;
  // Start of the COMPLETE window actually covered (API depth is finite).
  effectiveSinceSec: number | null;
  groups: ConsensusGroup[];
  // Contested markets (smart money on opposing sides) — mutually exclusive
  // with `groups`, which the API already filters to one-sided consensus only.
  disagreement: DisagreementMarket[];
  // 离场(2026-08-28 八件套):卖侧窗口读数,同一把 minWallets/minPerWalletUsd 尺。
  exits?: ExitGroupView[];
  error?: string;
};

// 镜像 lib/smartExit 的 SmartExitGroup(前端手写平行类型,页面惯例)。
type ExitWalletView = {
  wallet: string;
  soldUsd: number;
  avgSellPrice: number;
  sellCount: number;
  score: number | null;
  winRate: number | null;
};
type ExitGroupView = {
  conditionId: string;
  outcome: string;
  title: string;
  slug: string;
  eventSlug: string;
  wallets: ExitWalletView[];
  walletCount: number;
  totalSoldUsd: number;
  avgSellPrice: number;
  lastTs: number;
};

type Hours = 2 | 6 | 12;

const PER_WALLET_PRESETS = [5000, 10000, 25000];
const HOURS_CHOICES = [2, 6, 12] as const;
const MIN_WALLETS_CHOICES = [2, 3, 4] as const;
type View = "consensus" | "disagreement" | "exits";
// Page defaults — doubling as the "omit from URL" baseline so the default
// view serializes to a bare pathname.
const DEFAULTS = { hours: 6 as Hours, minWallets: 2, minPerWalletUsd: 5000 };
// "Still followable": current price within 5¢ of the smart-money entry.
// 这个 5¢ 只管措辞(「仍可跟」/「已跑」),口径写在 app/glossary.ts「跟单空间」
// 词条里 —— 它不管颜色。
const FOLLOWABLE_GAP = 0.05;
// 跟单空间就是追价成本(现价 − 聪明钱建仓均价)那个 ¢ 差,按 readme §2.1
// 「成本类数字一律中性色」上色:负空间不标绿(那通常意味着共识形成后行情
// 已反向、进场即接飞刀,见 app/guide.ts 的「读法」),正空间也不标红(是成本
// 不是亏损)。只有 |¢差| > 10¢ 越线时转琥珀 —— 与全站开仓侧默认进场偏离
// 护栏、与 /follow 的 SLIP_WARN_CENTS 同一分界。
const GAP_WARN_CENTS = 10;

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

// Human window length between a start timestamp and now. Takes the caller's
// t so the composed span translates (helper lives outside the component tree).
function fmtWindowSpan(
  sinceSec: number,
  t: (zh: string, params?: Record<string, string | number>) => string,
): string {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - sinceSec) / 60));
  if (mins < 60) return t("~{m} 分钟", { m: mins });
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? t("~{h} 小时", { h }) : t("~{h} 小时 {m} 分", { h, m });
}

// Expanded consensus wallet detail. Mounts only when a group row is open, so it
// lazily fetches each wallet's CURRENT position in the market ("stock") to sit
// beside its window net-buy ("flow") — telling fresh entries from long holders.
function ConsensusDetail({ group }: { group: ConsensusGroup }) {
  const { t } = useLang();
  const wallets = group.wallets.map((w) => w.wallet);
  const { positions, loading } = useMarketPositions(
    group.conditionId,
    wallets,
    true,
  );
  return (
    // 展开面板 = 设计稿里跟在主表卡下面的第二张卡:标题条(14/600 + 400 灰
    // 续写)+ 紧凑表。行内不再有色块 / 🏆 前缀 —— 这张表里每一行都是白名单
    // 钱包,前缀不携带信息。
    <div
      style={{
        border: "1px solid var(--ww-border)",
        borderRadius: "var(--r-md)",
        overflow: "hidden",
        background: "var(--ww-surface)",
      }}
    >
      {/* 标题条照设计稿是「NO 一侧展开␣· 4 个钱包 · …」的一句连写:粗标题
          与灰色续写必须是同一个 flex 子项,否则 .card-bar 的 12px gap 会加在
          「· 」前面变成双重间隔,窄屏 flex-wrap 时灰续写还会整段掉到第二行、
          以一个孤零零的「· 」开头。包进一个 span 后是普通行内文本流,换行
          跟着文字走。 */}
      <div className="card-bar">
        <span style={{ minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>
            {t("{outcome} 一侧展开", { outcome: group.outcome })}
          </span>
          <span className="ds-hint">
            {t(" · {n} 个钱包 · 净买 ${net} · 建仓均价 {avg}", {
              n: group.walletCount,
              net: fmtUsd(group.totalNetUsd),
              avg: group.avgBuyPrice.toFixed(3),
            })}
            {group.currentPrice != null
              ? t(" · 现价 {cur}", { cur: group.currentPrice.toFixed(3) })
              : ""}
          </span>
        </span>
      </div>
      <table className="ds-table--compact">
        <thead>
          <tr>
            <th>{t("钱包")}</th>
            <th className="is-right">{t("评分")}</th>
            <th className="is-right">{t("净买入")}</th>
            <th className="is-right">{t("笔数")}</th>
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
          {group.wallets.map((w) => (
            <tr key={w.wallet}>
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
              <td className="is-right" data-label={t("净买入")}>
                ${fmtUsd(w.netUsd)}
              </td>
              <td className="is-right" data-label={t("笔数")}>
                {w.buyCount}
              </td>
              <td className="is-right" data-label={t("建仓均价")}>
                {w.avgBuyPrice.toFixed(3)}
              </td>
              <td className="is-right" data-label={t("当前持仓")}>
                <HoldingCell
                  pos={
                    positions?.[w.wallet.toLowerCase()]?.[
                      group.outcome.toLowerCase()
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
  );
}

export default function ConsensusPage() {
  const { t } = useLang();
  const [hours, setHours] = useState<Hours>(DEFAULTS.hours);
  const [minWallets, setMinWallets] = useState<number>(DEFAULTS.minWallets);
  const [minPerWalletUsd, setMinPerWalletUsd] = useState<number>(
    DEFAULTS.minPerWalletUsd,
  );
  const [data, setData] = useState<ConsensusResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Which section is visible — a tab toggle so a long list of one signal never
  // buries the other (both are fetched together; this only switches display).
  const [view, setView] = useState<View>("consensus");
  const [whitelistOpen, setWhitelistOpen] = useState(false);
  // Flips true once the URL params have been read into state — the first fetch
  // and the URL write-back both wait for it.
  const [urlReady, setUrlReady] = useState<boolean>(false);

  const activeReq = useRef<number>(0);

  // Hydrate filters from the URL once on mount (client-only, so SSR markup and
  // the first client render agree — no hydration mismatch). Absent or invalid
  // params keep the defaults; the write-back effect below then canonicalizes
  // the address bar.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const qHours = parseChoiceParam(p.get("hours"), HOURS_CHOICES);
    if (qHours != null) setHours(qHours);
    const qMinWallets = parseChoiceParam(
      p.get("minWallets"),
      MIN_WALLETS_CHOICES,
    );
    if (qMinWallets != null) setMinWallets(qMinWallets);
    const qMinPer = parseNumParam(p.get("minPerWalletUsd"), {
      min: 1,
      int: true,
    });
    if (qMinPer != null) setMinPerWalletUsd(qMinPer);
    const qView = p.get("view");
    if (qView === "disagreement" || qView === "consensus") setView(qView);
    setUrlReady(true);
  }, []);

  // Mirror the filter state back into the URL (replaceState → no history spam)
  // so a tuned view survives refresh and can be shared as a link.
  useEffect(() => {
    if (!urlReady) return;
    replaceUrlQuery(
      buildQueryString([
        ["hours", hours !== DEFAULTS.hours ? String(hours) : null],
        [
          "minWallets",
          minWallets !== DEFAULTS.minWallets ? String(minWallets) : null,
        ],
        [
          "minPerWalletUsd",
          minPerWalletUsd !== DEFAULTS.minPerWalletUsd
            ? String(minPerWalletUsd)
            : null,
        ],
        ["view", view !== "consensus" ? view : null],
      ]),
    );
  }, [urlReady, hours, minWallets, minPerWalletUsd, view]);

  const load = useCallback(async () => {
    const reqId = ++activeReq.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        hours: String(hours),
        minWallets: String(minWallets),
        minPerWalletUsd: String(minPerWalletUsd),
      });
      const res = await fetch(`/api/consensus?${qs.toString()}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as ConsensusResponse;
      if (reqId !== activeReq.current) return;
      setData(json);
      setLastRefreshed(
        new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      );
    } catch (e) {
      if (reqId !== activeReq.current) return;
      setData({
        filters: { hours, minWallets, minPerWalletUsd },
        smartCount: 0,
        truncated: false,
        effectiveSinceSec: null,
        groups: [],
        disagreement: [],
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (reqId === activeReq.current) setLoading(false);
    }
  }, [hours, minWallets, minPerWalletUsd]);

  // Refetch whenever a filter changes. The FIRST fetch waits for the URL
  // hydration above so a shared link never fires a throwaway default query.
  useEffect(() => {
    if (!urlReady) return;
    load();
  }, [urlReady, load]);

  // Optional 30s auto-refresh.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  // New-record chime: ring when a same-filter refresh surfaces a new consensus
  // group OR a new disagreement market (a filter change reseeds silently).
  const { soundOn, toggle } = useSoundToggle();
  useNewRecordChime(
    data
      ? `${data.filters.hours}|${data.filters.minWallets}|${data.filters.minPerWalletUsd}`
      : null,
    data
      ? [
          ...data.groups.map((g) => `c:${g.conditionId}:${g.outcome}`),
          ...(data.disagreement ?? []).map((m) => `d:${m.conditionId}`),
        ]
      : [],
    soundOn,
  );

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const groups = data?.groups ?? [];
  const disCount = data?.disagreement?.length ?? 0;
  const totalNet = groups.reduce((s, g) => s + g.totalNetUsd, 0);

  return (
    <main className="ds-main">
      {/* 页头 —— 12px 小标(emoji 前缀)+ 24/600 标题 + 14px 说明,右侧动作。 */}
      <header className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="page-head__eyebrow">
            {t("🔥 白名单同向与对立建仓")}
          </div>
          <h1 className="page-head__title">{t("共识 / 分歧")}</h1>
          {/* 说明句照设计稿收成一句:同一市场里白名单站同一侧还是分站两侧,
              天平两端各是谁的钱、谁更有战绩。 */}
          <p className="page-head__desc">
            {t(
              "同一市场里白名单钱包站同一侧 = 共识，分站两侧 = 分歧（两者互斥）：天平两端各是谁的钱、谁更有战绩。",
            )}
          </p>
        </div>
        <div className="page-head__actions">
          {lastRefreshed ? (
            <span className="ds-hint">
              {t("最后刷新 {time}", { time: lastRefreshed })}
            </span>
          ) : null}
          {/* 加载中是过程,不是「需留神的口径」—— 琥珀留给口径与样本不足,
              这里走 13px muted。 */}
          {loading ? <span className="ds-hint">{t("加载中…")}</span> : null}
          <SoundToggle on={soundOn} onToggle={toggle} />
        </div>
      </header>

      {/* 口径条 —— 统计声明一律放在数据前面,不放脚注。 */}
      {data?.error ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-4)" }}
        >
          {t("加载失败: {err}", { err: data.error })}
        </div>
      ) : null}

      {data && data.smartCount === 0 ? (
        <div
          className="ds-callout ds-callout--warn"
          style={{ marginBottom: "var(--s-4)" }}
        >
          {t(
            "聪明钱白名单为空 — 引擎启动后每日自动从官方盈利榜播种（首次约 1 分钟内完成）",
          )}
        </div>
      ) : null}

      {data?.truncated && data.effectiveSinceSec ? (
        <div
          className="ds-callout ds-callout--warn"
          style={{ marginBottom: "var(--s-4)" }}
        >
          {t("⏱️ 成交太密集，API 回看深度已用满 — 本页基于")}{" "}
          {t("完整覆盖的 {span}", {
            span: fmtWindowSpan(data.effectiveSinceSec, t),
          })}
          {t("（自 {time} 起，买卖双侧均完整）检测", {
            time: fmtTime(data.effectiveSinceSec),
          })}
        </div>
      ) : null}

      {data ? (
        <section className="kpi" style={{ marginBottom: "var(--s-5)" }}>
          {/* KPI 分格卡 —— 一张白卡内 N 等分,格间 1px 竖线;20px emoji 图标位 +
              12px 小标 + 18px 常规字重的值 + 13px 副行(一句话说清这个数是怎么
              来的)。设计稿的天平页把「方向分歧」也摆在这一排:这一格读的是同
              一次请求已经取回的 disagreement 长度,不新增取数。 */}
          <StatCard label={t("共识组数")} icon="🔥">
            <div className="kpi-value" style={{ color: "var(--ww-link)" }}>
              {t("{n} 个", { n: groups.length })}
            </div>
            <div className="kpi-sub">
              {t("≥{n} 个白名单同向", { n: minWallets })}
            </div>
          </StatCard>
          <StatCard label={t("方向分歧")} icon="⚖️">
            <div className="kpi-value">{t("{n} 个", { n: disCount })}</div>
            <div className="kpi-sub">{t("两侧各达门槛")}</div>
          </StatCard>
          <StatCard label={t("合计净买入")} icon="💰">
            <div className="kpi-value">${fmtUsd(totalNet)}</div>
            <div className="kpi-sub">{t("窗口内共识组合计")}</div>
          </StatCard>
          <StatCard label={t("白名单钱包")} icon="🏆">
            <div
              className="kpi-value"
              onClick={() => setWhitelistOpen(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setWhitelistOpen(true);
              }}
              title={t("点击查看全部白名单地址（支持搜索）")}
              style={{
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                color: "var(--ww-link)",
              }}
            >
              {data.smartCount}
              <span style={{ fontSize: 13 }}>▸</span>
            </div>
            <div className="kpi-sub">{t("点击查看全部地址")}</div>
          </StatCard>
        </section>
      ) : null}

      {/* 筛选条 —— 不是卡:它是主表卡的参数,不是与之并列的第二块内容。 */}
      <div className="filter-bar">
        <div className="filter-row">
          <span className="filter-row__label">{t("时间窗")}</span>
          <Segmented<Hours>
            ariaLabel={t("时间窗")}
            value={hours}
            onChange={setHours}
            options={([2, 6, 12] as Hours[]).map((h) => ({
              label: `${h}h`,
              value: h,
            }))}
          />
        </div>
        <div className="filter-row">
          <span className="filter-row__label">{t("最少钱包")}</span>
          <Segmented<number>
            ariaLabel={t("最少钱包数")}
            value={minWallets}
            onChange={setMinWallets}
            options={[2, 3, 4].map((n) => ({
              label: t("≥{n} 个", { n }),
              value: n,
            }))}
          />
        </div>
        <div className="filter-row">
          <span className="filter-row__label">{t("每钱包净买")}</span>
          <Segmented<number>
            ariaLabel={t("每钱包净买入下限")}
            value={minPerWalletUsd}
            onChange={setMinPerWalletUsd}
            options={PER_WALLET_PRESETS.map((p) => ({
              label: `$${fmtUsd(p)}`,
              value: p,
            }))}
          />
        </div>
        <div className="filter-bar__right">
          {/* 原生 checkbox 保留(可聚焦、语义不变),视觉换成 32×18 胶囊开关。 */}
          <label
            className="ds-hint"
            style={{
              position: "relative",
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--s-2)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              style={{
                position: "absolute",
                left: 0,
                top: "50%",
                transform: "translateY(-50%)",
                width: 32,
                height: 18,
                margin: 0,
                opacity: 0,
                cursor: "pointer",
              }}
            />
            <span
              className="ds-toggle"
              data-on={autoRefresh ? "true" : "false"}
              aria-hidden
            />
            {t("自动刷新 30s")}
          </label>
          <button className="ds-btn ds-btn--primary" onClick={() => load()}>
            {t("刷新")}
          </button>
        </div>
      </div>

      {/* Tab 行 —— 同一批白名单行为的三个侧面(不是互斥筛选:数据一次取回,
          这里只切换显示哪一面)。 */}
      {data ? (
        <div
          className="ds-tabrow"
          role="group"
          aria-label={t("共识或分歧")}
          style={{ marginBottom: "var(--s-4)" }}
        >
          <button
            type="button"
            aria-pressed={view === "consensus"}
            onClick={() => setView("consensus")}
          >
            {t("共识")} {groups.length}
          </button>
          <button
            type="button"
            aria-pressed={view === "disagreement"}
            onClick={() => setView("disagreement")}
          >
            {t("分歧")} {disCount}
          </button>
          <button
            type="button"
            aria-pressed={view === "exits"}
            onClick={() => setView("exits")}
          >
            {t("离场")} {data?.exits?.length ?? 0}
          </button>
        </div>
      ) : null}

      <div style={{ display: view === "consensus" ? "block" : "none" }}>
        {data && groups.length === 0 && !loading ? (
          <div className="ds-empty">
            {t("窗口内暂无聪明钱共识 — 出现时也会推送到实时告警")}
            <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
              {t(
                "把时间窗放宽到 12h、或把每钱包净买下限降到 $5,000 再看一次。",
              )}{" "}
              <a href="/alerts">{t("去实时告警 →")}</a>
            </div>
          </div>
        ) : groups.length > 0 ? (
          <div className="ds-card" style={{ overflow: "hidden" }}>
            <div className="card-bar">
              <span style={{ fontWeight: 600 }}>
                {t("共 {n} 组共识", { n: groups.length })}
              </span>
              <span className="ds-hint">
                {t("一边倒 · ≥{n} 个白名单钱包同向买入同一结果", {
                  n: minWallets,
                })}
              </span>
            </div>
            <div
              className="ds-table-wrap"
              style={{ border: 0, borderRadius: 0, boxShadow: "none" }}
            >
              <table className="ds-table">
                <thead>
                  <tr>
                    <th
                      style={{ width: 28, padding: "var(--s-2) var(--s-1)" }}
                    />
                    <th>{t("市场 · 结果")}</th>
                    <th className="is-right">{t("钱包数")}</th>
                    <th className="is-right">{t("合计净买入")}</th>
                    <th
                      className="is-right"
                      title={t("按金额加权的聪明钱建仓均价")}
                    >
                      {t("建仓均价")}
                    </th>
                    <th className="is-right" title={t("Gamma 最新赔率")}>
                      {t("现价")}
                    </th>
                    <th>{t("跟单空间")}</th>
                    <th className="is-right">{t("最新时间")}</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const key = `${g.conditionId}:${g.outcome}`;
                    const isOpen = expanded.has(key);
                    const gap =
                      g.currentPrice != null
                        ? g.currentPrice - g.avgBuyPrice
                        : null;
                    // A price pinned at 0/1 means the event is decided even
                    // when gamma's `closed` flag lags — either way "following"
                    // is moot.
                    const settled =
                      g.closed ||
                      (g.currentPrice != null &&
                        (g.currentPrice >= 0.999 || g.currentPrice <= 0.001));
                    return (
                      <Fragment key={key}>
                        <tr
                          onClick={() => toggleExpand(key)}
                          style={{ cursor: "pointer" }}
                          title={
                            isOpen
                              ? t("点击收起钱包明细")
                              : t("点击展开钱包明细")
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
                          {/* 市场名 / 结果名永不截断:换行,最多两行,顶对齐。
                              只有地址与哈希做首尾省略。 */}
                          <td className="cell-wrap" style={{ maxWidth: 380 }}>
                            {g.eventSlug ? (
                              <a
                                href={`https://polymarket.com/event/${g.eventSlug}`}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {g.title}
                              </a>
                            ) : (
                              g.title
                            )}
                            {/* 结果名走灰底名称标签(Etherscan name tag,不表示
                                状态);⧉ 复制 market slug、↗ 开交易页、🎯 开
                                市场信号卡 —— 与 24h 扫描同一套 affordance。 */}
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
                              <Tag>{g.outcome}</Tag>
                              {g.category ? (
                                <span>
                                  {catLabelFineT(t, g.category, g.subcategory)}
                                </span>
                              ) : null}
                              <span>
                                <MarketSlugActions
                                  slug={g.slug}
                                  eventSlug={g.eventSlug}
                                  conditionId={g.conditionId}
                                />
                              </span>
                            </div>
                          </td>
                          <td className="is-right" data-label={t("钱包数")}>
                            {g.walletCount}
                          </td>
                          <td className="is-right" data-label={t("合计净买入")}>
                            ${fmtUsd(g.totalNetUsd)}
                          </td>
                          <td className="is-right" data-label={t("建仓均价")}>
                            {g.avgBuyPrice.toFixed(3)}
                          </td>
                          <td className="is-right" data-label={t("现价")}>
                            {g.currentPrice != null ? (
                              g.currentPrice.toFixed(3)
                            ) : (
                              <span className="faint">—</span>
                            )}
                          </td>
                          <td data-label={t("跟单空间")}>
                            {gap == null ? (
                              <span className="faint">—</span>
                            ) : settled ? (
                              // Settled market: following is moot — show
                              // whether the smart-money consensus was RIGHT.
                              g.currentPrice != null && g.currentPrice > 0.5 ? (
                                <Tag variant="up">{t("已结算 ✓ 命中")}</Tag>
                              ) : (
                                <Tag variant="down">{t("已结算 ✗ 落空")}</Tag>
                              )
                            ) : (
                              // 未结算:这一格是成本类 ¢ 差,不是盈亏 ——
                              // 结论文字而非徽章(蓝/绿/红都不该在这里表态),
                              // 中性色打底,只在 |¢差| > 10¢ 时转琥珀。
                              <span
                                style={{
                                  whiteSpace: "nowrap",
                                  color:
                                    Math.abs(gap) * 100 > GAP_WARN_CENTS
                                      ? "var(--ww-warn)"
                                      : undefined,
                                }}
                              >
                                {gap <= FOLLOWABLE_GAP
                                  ? t("仍可跟 {gap}¢", {
                                      gap: `${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(1)}`,
                                    })
                                  : t("已跑 +{gap}¢", {
                                      gap: (gap * 100).toFixed(1),
                                    })}
                              </span>
                            )}
                          </td>
                          <td
                            className="muted is-right"
                            data-label={t("最新时间")}
                          >
                            {fmtTime(g.lastTs)}
                          </td>
                        </tr>
                        {isOpen ? (
                          <tr>
                            <td
                              colSpan={8}
                              style={{
                                padding: "0 var(--s-4) var(--s-4)",
                                background: "var(--ww-surface)",
                              }}
                            >
                              <ConsensusDetail group={g} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* 「—」是判不了,不是零 —— 每一处成因都要列全,不能穷举一半:
                主表的现价 / 跟单空间是一种,展开明细里的评分与「当前持仓」
                (ui.tsx HoldingCell 无仓位时也渲染 —)各是一种。 */}
            <div className="note-strip note-strip--warn">
              {t(
                "现价栏的 — 表示该结果缺 asset、取不到价（不是加载中），跟单空间也随之判不了；展开明细里有两种 —：评分栏的 — 是该钱包还没有已结算样本、评分算不出来，当前持仓栏的 — 是它此刻在该结果已无持仓（窗口内买过但已清仓或转向）。三种都不等于 0。建仓均价按金额加权；跟单空间是成本类 ¢ 差、一律中性色，只有 |¢差| 超过 10¢ 才转琥珀；已结算的市场不再谈跟单空间，只标命中或落空。",
              )}
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ display: view === "disagreement" ? "block" : "none" }}>
        {data ? (
          <DisagreementSection markets={data.disagreement ?? []} />
        ) : null}
      </div>

      <div style={{ display: view === "exits" ? "block" : "none" }}>
        {data && (data.exits?.length ?? 0) === 0 && !loading ? (
          <div className="ds-empty">
            {t("窗口内暂无池内钱包的集体离场")}
            <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
              {t(
                "离场比建仓稀疏：把时间窗放宽到 12h、或把最少钱包降到 ≥2 个再看一次。",
              )}
            </div>
          </div>
        ) : (data?.exits?.length ?? 0) > 0 ? (
          <div className="ds-card" style={{ overflow: "hidden" }}>
            <div className="card-bar">
              <span style={{ fontWeight: 600 }}>
                {t("共 {n} 组离场", { n: data?.exits?.length ?? 0 })}
              </span>
              <span className="ds-hint">
                {t("≥{n} 个池内钱包在同一结果上净卖出", { n: minWallets })}
              </span>
            </div>
            <div
              className="ds-table-wrap"
              style={{ border: 0, borderRadius: 0, boxShadow: "none" }}
            >
              <table className="ds-table">
                <thead>
                  <tr>
                    <th>{t("市场 / 结果")}</th>
                    <th className="is-right">{t("离场钱包")}</th>
                    <th className="is-right">{t("合计卖出")}</th>
                    <th className="is-right">{t("卖出均价")}</th>
                    <th>{t("钱包")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.exits ?? []).map((g) => (
                    <tr key={`${g.conditionId}:${g.outcome}`}>
                      <td className="cell-wrap" style={{ maxWidth: 380 }}>
                        {g.title}
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
                          <Tag>{g.outcome}</Tag>
                          {g.slug && (
                            <span>
                              <MarketSlugActions
                                slug={g.slug}
                                eventSlug={g.eventSlug || undefined}
                              />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="is-right" data-label={t("离场钱包")}>
                        {g.walletCount}
                      </td>
                      <td className="is-right" data-label={t("合计卖出")}>
                        ${Math.round(g.totalSoldUsd).toLocaleString("en-US")}
                      </td>
                      <td className="is-right" data-label={t("卖出均价")}>
                        {(g.avgSellPrice * 100).toFixed(1)}¢
                      </td>
                      <td className="cell-wrap" data-label={t("钱包")}>
                        {g.wallets.slice(0, 3).map((w, i) => (
                          <span key={w.wallet} style={{ whiteSpace: "nowrap" }}>
                            {i > 0 && " · "}
                            <WalletLink address={w.wallet}>
                              {w.wallet.slice(0, 6)}…{w.wallet.slice(-4)}
                            </WalletLink>
                            <span style={{ color: "var(--ww-text-muted)" }}>
                              {" $"}
                              {Math.round(w.soldUsd / 1000)}k
                            </span>
                          </span>
                        ))}
                        {g.wallets.length > 3 && " …"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="note-strip note-strip--warn">
              {t(
                "只统计窗口内的卖单：窗内看不到这些仓位此前是怎么建的，所以获利了结与止损在这里长得一模一样。卖出均价按金额加权。",
              )}
            </div>
          </div>
        ) : null}
      </div>

      <WhitelistDialog
        open={whitelistOpen}
        onClose={() => setWhitelistOpen(false)}
      />
    </main>
  );
}
