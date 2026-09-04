"use client";

// Shared design-system primitives (MM Manage v3) for the Polymarket monitor.
// Single source of truth so the three pages stop duplicating inline styles.
// Visuals live in app/globals.css; these components only wire props → classes.
//
// 双语化:所有用户可见文案过 useLang().t(中文键);中文键即字典键,缺译
// 回退中文(lib/i18n/core)。代码注释不翻译。

import {
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { formatAge, type AgeTone } from "./ageFormat";
import { NAV, type NavEntry, type NavItem } from "./nav";
import { iconTip } from "./glossary";
import { useLang } from "./i18n";
import type { MarketPos } from "./useMarketPositions";

/* --------------------------------------------------------------- tip-pop */

// Tap-popover plumbing shared by Icon / AgeBadge / WalletStatsBadge. Touch
// browsers never show HTML `title` tooltips, so every glossary hint used to be
// desktop-only. A click toggles focus on the tip element (tabindex=-1 spans
// are click-focusable but never keyboard tab stops — hundreds of per-row
// symbols must not pollute the tab order) and globals.css paints data-tip as
// a :focus popover. Desktop hover behavior is unchanged (`title` stays).
// The data-popOpen flag makes a second tap on the SAME symbol a working
// dismiss even on browsers where tapping non-focusable page chrome doesn't
// blur (iOS Safari). No stopPropagation: a tip inside a link or a clickable
// row keeps its existing click-through behavior.
function popTipToggle(e: ReactMouseEvent<HTMLElement>) {
  const el = e.currentTarget;
  if (el.dataset.popOpen === "1") {
    delete el.dataset.popOpen;
    el.blur();
  } else {
    el.dataset.popOpen = "1";
    el.focus();
  }
}

function popTipClose(e: ReactFocusEvent<HTMLElement>) {
  delete e.currentTarget.dataset.popOpen;
}

// Prop bundle for a tip-pop element; spread over a span that also sets
// className="tip-pop" (plus any other classes) and `title` for desktop hover.
function tipPopProps(tip: string) {
  return {
    "data-tip": tip,
    tabIndex: -1,
    onClick: popTipToggle,
    onBlur: popTipClose,
  } as const;
}

/* ---------------------------------------------------------------- TopNav */

// 顶栏信息架构:两个高频直达入口(首页 / 说明)夹着三个下拉分组。
// 页面涨到 9 个后平铺会挤进 overflow-x 滚动区(用户实测「信号战绩看不到」),
// 而分组同时解决拥挤与「这些页面彼此什么关系」的认知问题 —— 按用户在做
// 什么分:看盘 / 追聪明钱 / 看策略战绩。
// 导航数据本体在 app/nav.ts(纯数据模块):/guide 的覆盖闸测试消费它,
// 新页面进导航却漏写说明书会直接红。信息架构理由见上注释与 nav.ts。
// /status 刻意**不进** NAV:它是运维视角的页面,放在面向交易者的导航里是
// 拿一个「一切正常」的绿灯占掉主路径上的注意力。入口在 /manage(锁定态与
// 健康度区块各一个)。页面本身仍无需令牌可直达 —— 它没有秘密(数据源就是
// 公开的 /api/health),只是不再主动对外推。

// 一个下拉分组。**只由点击控制**:hover 展开叠加 click 切换会互相打架
// (鼠标移上去已经展开,这一下点击反而把它关掉,表现为「点了没反应」),
// 而且鼠标路过顶栏就弹菜单本身也是干扰。纯 click 在触屏与桌面行为一致。
// 点击组外、Esc、以及点进任意子项都收起。组内含当前页时按钮显示激活态,
// 这样折叠状态下也能看出「我在哪一组」。
function NavGroup({
  label,
  items,
  pathname,
  t,
}: {
  label: string;
  items: NavItem[];
  pathname: string;
  t: (zh: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const active = items.some((i) => i.href === pathname);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="nav-group">
      <button
        type="button"
        className="nav-link nav-group__btn"
        data-active={active}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
      >
        {t(label)}
        <span className="nav-group__caret" aria-hidden />
      </button>
      {open ? (
        <div className="nav-group__menu" role="menu">
          {items.map((i) => (
            <Link
              key={i.href}
              href={i.href}
              className="nav-group__item"
              data-active={pathname === i.href}
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              {t(i.label)}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// 顶栏右侧的实时时钟（绿点 + 「实时 HH:MM:SS」)。设计稿每一幅都有它 ——
// 它是「这页是活的」的唯一常驻证据。挂载前渲染 null:服务端渲染一个时间
// 串必然与客户端首帧不一致(水合错位),而这块纯装饰,晚一帧出现无代价。
// 用 UTC:全站数据时间都是 UTC(各页头也这么写),顶栏跟着走本地时区会让
// 「实时 22:42」与表里的 22:34 对不上号。
function LiveClock() {
  const { t } = useLang();
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date().toISOString().slice(11, 19));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  if (!now) return null;
  return (
    <span className="topbar__clock" title={t("当前 UTC 时间")}>
      <span className="topbar__clock-dot" aria-hidden />
      {t("实时")} {now}
    </span>
  );
}

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { lang, setLang, t } = useLang();
  // 分组下拉带来的性能退化补偿:<Link> 的自动预取靠「进入视口」触发,而
  // 折叠状态下菜单里的 Link 根本不在 DOM 里 —— 改成下拉之前 9 个链接常驻
  // 顶栏、页面一加载就全部预取完;之后每次点击都要现场下载页面 chunk,
  // 表现为「切换页面卡顿」。这里在挂载时显式预取全部目标,把行为拉回改版前。
  useEffect(() => {
    for (const entry of NAV) {
      if ("items" in entry) {
        for (const i of entry.items) router.prefetch(i.href);
      } else {
        router.prefetch(entry.href);
      }
    }
  }, [router]);
  return (
    <nav className="topbar">
      <div className="topbar__inner">
        {/* 字标就是 WhaleWatch（22/700）—— 设计稿 25 幅一致。站点对外名片、
            metadata title、TG 频道名本来就是这个名字。 */}
        <span className="topbar__brand">
          <span className="topbar__whale" aria-hidden>
            🐋
          </span>
          WhaleWatch
        </span>
        {/* 导航右靠（设计稿：字标居左，导航与右侧 chrome 连成一片） */}
        <span style={{ flex: 1 }} />
        <div className="topbar__nav">
          {NAV.map((entry) =>
            "items" in entry ? (
              <NavGroup
                key={entry.label}
                label={entry.label}
                items={entry.items}
                pathname={pathname}
                t={t}
              />
            ) : (
              <Link
                key={entry.href}
                href={entry.href}
                className="nav-link"
                data-active={pathname === entry.href}
              >
                {t(entry.label)}
              </Link>
            ),
          )}
        </div>
        <span className="topbar__sep" aria-hidden />
        <LiveClock />
        {/* External channel link — same explicit window.open fallback as
            WalletLink (the webview ignores target=_blank on its own). */}
        <a
          className="nav-btn"
          href="https://t.me/Polymarket_WhaleWatch"
          target="_blank"
          rel="noreferrer"
          title={t("Telegram 频道：实时信号推送，每条自带 30 天可验证命中率")}
          onClick={(e) => {
            e.preventDefault();
            window.open(
              "https://t.me/Polymarket_WhaleWatch",
              "_blank",
              "noopener,noreferrer",
            );
          }}
        >
          📣 {t("TG 频道")}
        </a>
        {/* 语言切换:显示的是「切过去」的目标语言。 */}
        <button
          type="button"
          className="nav-btn"
          onClick={() => setLang(lang === "zh" ? "en" : "zh")}
          title={t("切换语言")}
          aria-label={t("切换语言")}
        >
          {lang === "zh" ? "EN" : "中文"}
        </button>
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------- Segmented */

export type SegOption<T extends string | number> = {
  label: ReactNode;
  value: T;
};

// Controlled segmented toggle/tab. Active item = white thumb + shadow.
// className is optional and additive (e.g. "ds-segmented--wrap") — most call
// sites have 2-5 options that always fit one row on desktop, so the shared
// base rule stays a plain non-wrapping inline-flex; a caller with many/long
// options (e.g. /follow's per-strategy filter) opts into wrapping instead of
// that behavior change leaking into every other Segmented on the site.
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  options: ReadonlyArray<SegOption<T>>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={className ? `ds-segmented ${className}` : "ds-segmented"}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------- CopyButton */

// execCommand fallback for contexts without the async clipboard API — e.g.
// the dashboard opened over plain http from another device on the LAN.
function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied / insecure context — fall through to execCommand.
    }
  }
  return legacyCopy(text);
}

// Tiny inline copy-to-clipboard button (e.g. the market slug next to a title).
// Shows ✓ briefly after copying. Click never bubbles (rows may be clickable).
export function CopyButton({
  text,
  label = "复制",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const { t } = useLang();
  if (!text) return null;
  return (
    <button
      type="button"
      className={copied ? "copy-btn is-copied" : "copy-btn"}
      title={copied ? t("已复制") : `${t(label)}: ${text}`}
      aria-label={`${t(label)} ${text}`}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void copyToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}

/* ------------------------------------------------------------ QuietLink */

// External jump in the same barely-there style as CopyButton (shares its
// .copy-btn look: faint glyph, row-hover reveal). Click never bubbles.
export function QuietLink({
  href,
  title,
  children,
}: {
  href: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <a
      className="copy-btn"
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      aria-label={title}
      onClick={(e) => e.stopPropagation()}
      style={{ textDecoration: "none" }}
    >
      {children}
    </a>
  );
}

/* ----------------------------------------------------- MarketSlugActions */

// External trade page for a market slug (wired.fund tooling).
export const TRADE_LINK_BASE =
  "https://onchain-dev.wired.fund/polymarket/trade-slug?slug=";

// The ⧉↗🎯 trio that follows a market subtitle everywhere: ⧉ copies the
// MARKET slug (the per-market key gamma /markets?slug= takes — not the event
// slug), ↗ opens the wired.fund trade page, 🎯 opens THIS tool's market
// signal card (new tab, same forced window.open as WalletLink — embedded
// webviews ignore target=_blank). One component so every list (scanner /
// consensus / disagreement / accumulation / wallet / discovery) renders the
// exact same affordance. Renders nothing without a slug; 🎯 renders only
// when the caller has the conditionId at hand.
export function MarketSlugActions({
  slug,
  eventSlug,
  conditionId,
}: {
  slug?: string | null;
  eventSlug?: string | null;
  conditionId?: string | null;
}) {
  const { t } = useLang();
  const s = slug || eventSlug || "";
  if (!s && !conditionId) return null;
  const cardHref = conditionId ? `/market/${conditionId}` : null;
  return (
    <>
      {s && <CopyButton text={s} label="复制 market slug" />}
      {s && (
        <QuietLink
          href={`${TRADE_LINK_BASE}${encodeURIComponent(s)}`}
          title={t("在 wired.fund 打开交易页：{s}", { s })}
        >
          ↗
        </QuietLink>
      )}
      {cardHref && (
        <a
          className="copy-btn"
          href={cardHref}
          target="_blank"
          rel="noreferrer"
          title={t(
            "打开市场信号卡：共识/分歧 · 聪明钱敞口 · 拆单 · 新钱包 · 告警战绩",
          )}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            window.open(cardHref, "_blank", "noopener,noreferrer");
          }}
        >
          🎯
        </a>
      )}
    </>
  );
}

/* ----------------------------------------------------------- WalletLink */

// Every wallet-address click in the app opens the dossier in a NEW tab —
// never an in-place navigation (the user is mid-scan; losing the list state
// costs more than a tab). One shared component instead of seven hand-rolled
// anchors, and the click handler FORCES the new tab via window.open:
// target="_blank" alone is ignored by some embedded webviews (preview
// panels), which would fall back to exactly the in-place jump we're
// preventing. The href stays real so middle-click / copy-link still work.
export function WalletLink({
  address,
  children,
  title,
}: {
  address: string;
  children: ReactNode;
  title?: string;
}) {
  const { t } = useLang();
  const href = `/wallet/${address.toLowerCase()}`;
  return (
    <a
      className="mono"
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title ?? t("{address} · 新标签打开钱包档案", { address })}
      onClick={(e) => {
        e.stopPropagation(); // never trigger the row's expand/select
        e.preventDefault();
        window.open(href, "_blank", "noopener,noreferrer");
      }}
    >
      {children}
    </a>
  );
}

/* ------------------------------------------------------------- Category */

// 实现移至 lib/categoryLabel.ts(2026-08-13 二级分类:合成规则可测,app/
// 下没有测试基建);这里 re-export 保持既有调用方的 import 面不变,并把
// 新的 catLabelFine(「体育·NBA」合成)一并暴露给各页面。
import { catLabelFine as catLabelFineRaw } from "../lib/categoryLabel";
export { catLabel, catLabelFine } from "../lib/categoryLabel";

// 双语版分类标签:合成/去重规则仍归 catLabelFine 唯一属主,这里只把合成
// 结果按「·」**逐段**过字典 —— 整串("体育·NBA")永远不会是字典键(词表
// 收的是单个词元),整串查表必然 miss 并回退中文。段内未知值(NBA/F1 等
// 拉丁名)透传原文。t 由调用方从 useLang 传入(本函数保持纯函数)。
export function catLabelFineT(
  t: (zh: string) => string,
  category: string | null | undefined,
  subcategory: string | null | undefined,
): string {
  return catLabelFineRaw(category, subcategory)
    .split("·")
    .map((seg) => t(seg))
    .join("·");
}

/* ----------------------------------------------------------------- Icon */

// A glossary-backed symbol: hovering any 🐳/🏆/🔥/… shows what it means, and
// a TAP shows the same text as a popover (see tip-pop above) so touch screens
// aren't locked out of the explanations. Tooltip text comes from
// app/glossary.ts (the same source as /glossary), so meanings can never drift
// between the hover, the popover and the docs page. 译文键=词表原文,由
// glossary 字典分片统一供给。
export function Icon({ s, title }: { s: string; title?: string }) {
  const { t } = useLang();
  const rawTip = title ?? iconTip(s);
  if (!rawTip) return <span>{s}</span>;
  const tip = t(rawTip);
  return (
    <span
      className="tip-pop"
      title={tip}
      aria-label={tip}
      {...tipPopProps(tip)}
    >
      {s}
    </span>
  );
}

/* ------------------------------------------------------------------ Tag */

type TagVariant = "default" | "brand" | "up" | "down" | "warn";

export function Tag({
  variant = "default",
  children,
}: {
  variant?: TagVariant;
  children: ReactNode;
}) {
  const cls = variant === "default" ? "ds-tag" : `ds-tag ds-tag--${variant}`;
  return <span className={cls}>{children}</span>;
}

// BUY → 绿描边，SELL → 红描边。方向是金融含义。
// 固定 56px 宽(.ds-tag--dir):BUY / SELL 在表格的方向列里要对齐成一条直线,
// 宽度随字数变化会让整列参差。
export function SideTag({ side }: { side: string }) {
  const v = side === "BUY" ? "up" : side === "SELL" ? "down" : "default";
  const base = v === "default" ? "ds-tag" : `ds-tag ds-tag--${v}`;
  return <span className={`${base} ds-tag--dir`}>{side}</span>;
}

/* ------------------------------------------------------------- Field row */

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="ds-field">
      <span className="ds-field__label">{label}</span>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------- KPI card */

// KPI 分格 —— 一格。整排格子由外层 .kpi 拼成一张白卡，格间 1px 竖线。
// icon 是设计稿的图标位:emoji 20px(承担语义,如 💰 / 🐳 / 🏆)。不给就
// 只有小标 + 值,布局不变 —— 现有调用方一个都不用改。
export function StatCard({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="kpi-card"
      style={
        icon
          ? { display: "flex", alignItems: "flex-start", gap: "var(--s-3)" }
          : undefined
      }
    >
      {icon ? (
        <span
          aria-hidden
          style={{ flex: "0 0 auto", fontSize: 20, lineHeight: 1.1 }}
        >
          {icon}
        </span>
      ) : null}
      <div style={icon ? { minWidth: 0, flex: 1 } : undefined}>
        <div className="ds-label">{label}</div>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ AgeBadge */

const AGE_CLASS: Record<AgeTone, string> = {
  new: "age-new",
  young: "age-young",
  normal: "age-normal",
  old: "age-old",
  unknown: "age-unknown",
};

// Renders an address age (days → badge). Keeps the emoji freshness markers
// from formatAge per product choice; tone drives the (financial) color.
// Tip is tap-reachable via the shared tip-pop popover (cursor comes with it).
export function AgeBadge({ ageDays }: { ageDays: number | null | undefined }) {
  const { lang, t } = useLang();
  const { text, tone } = formatAge(ageDays, lang);
  const title =
    ageDays == null
      ? t(iconTip("…") ?? "")
      : t(
          "地址年龄：钱包首次 Polymarket 活动至今。🆕 = ≤30 天新钱包，红色 = <7 天 — 为一笔交易专门开的新钱包是最强内幕信号之一",
        );
  return (
    <span
      className={`${AGE_CLASS[tone]} tip-pop`}
      title={title}
      {...tipPopProps(title)}
    >
      {text}
    </span>
  );
}

/* ------------------------------------------------------ WalletStatsBadge */

// Client-safe mirror of lib/walletStats.WalletStats (type-only; the lib module
// itself imports better-sqlite3 and must stay server-only).
export type WalletStatsLite = {
  winRate: number | null;
  netPnl: number | null; // net P/L (realized + unrealized), Polymarket-profile figure; null = unknown
  roi: number | null;
  settledCount: number;
  truncated: boolean;
  marketsTraded: number | null; // distinct markets traded; high = automated operator
  isMarketMaker: boolean; // high-frequency market maker/bot — win rate skipped, labeled instead
};

export type SmartInfoLite = { score: number | null; isWhitelist: boolean };

// Compact signed USD: +$38k / −$1.2m. Sub-$1k amounts round to whole dollars.
export function fmtSignedUsdCompact(n: number): string {
  const sign = n < 0 ? "−" : "+";
  const abs = Math.abs(n);
  const num =
    abs >= 1_000_000
      ? `${(abs / 1_000_000).toFixed(1)}m`
      : abs >= 1_000
        ? `${(abs / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`
        : `${Math.round(abs)}`;
  return `${sign}$${num}`;
}

// Settled-market track record for a wallet row: "72% · +$38k", green when the
// wallet is net-profitable, red when net-losing. `undefined` = still loading,
// `null` = lookup failed, settledCount 0 = no settled history yet.
// The trophy and the stats text are SIBLING tip-pops (not nested) so a tap on
// either shows exactly its own popover — a nested tip would have its focus
// stolen by the outer one's click handler.
export function WalletStatsBadge({
  stats,
  smart,
}: {
  stats: WalletStatsLite | null | undefined;
  smart?: SmartInfoLite | null;
}) {
  const { t } = useLang();
  const trophyTip = smart
    ? smart.score != null
      ? t("聪明钱白名单 · 评分 {score}", { score: Math.round(smart.score) })
      : t("聪明钱白名单")
    : "";
  const trophy = smart ? (
    <span
      className="ds-tag ds-tag--brand tip-pop"
      title={trophyTip}
      {...tipPopProps(trophyTip)}
    >
      🏆
    </span>
  ) : null;
  if (stats === undefined) {
    return (
      <span className="mono muted">
        {trophy}
        {trophy ? " " : ""}…
      </span>
    );
  }
  // High-frequency market maker / bot: win rate is meaningless and uncomputable,
  // so we skip it entirely and label the wallet (see lib/walletStats). Must come
  // BEFORE the settledCount===0 branch (a market maker has no fetched positions).
  if (stats && stats.isMarketMaker) {
    const mmTitle = t(
      "🤖 高频做市 / 机器人：交易过 {n} 个不同市场，胜率不适用（做市赚点差、非定向下注）\n盈亏为净盈亏（官方 user-pnl 口径）",
      { n: stats.marketsTraded?.toLocaleString() ?? t("海量") },
    );
    const mmTone = stats.netPnl != null && stats.netPnl < 0 ? "down" : "up";
    return (
      <span className="mono" style={{ whiteSpace: "nowrap" }}>
        {trophy}
        {trophy ? " " : ""}
        <span className="tip-pop" title={mmTitle} {...tipPopProps(mmTitle)}>
          🤖{" "}
          <span className={mmTone}>
            {stats.netPnl != null ? fmtSignedUsdCompact(stats.netPnl) : "—"}
          </span>
        </span>
      </span>
    );
  }
  if (stats === null || stats.settledCount === 0) {
    return (
      <span className="mono muted">
        {trophy}
        {trophy ? " " : ""}
        <span
          className="tip-pop"
          title={t("无已结算战绩")}
          {...tipPopProps(t("无已结算战绩"))}
        >
          —
        </span>
      </span>
    );
  }
  // winRate is null for a TRUNCATED record (the fetched slice is the top of a
  // profit-sorted list — winner-biased, so a real ~100% is a lie). Then the badge
  // shows ONLY the authoritative netPnl, no fake "0%"/"100%". netPnl is the
  // Polymarket-profile net figure (realized + unrealized), NOT the settled-only
  // sum — the tooltip spells that out. null netPnl = value was unavailable.
  const pct = stats.winRate != null ? Math.round(stats.winRate * 100) : null;
  const tone = stats.netPnl != null && stats.netPnl < 0 ? "down" : "up";
  const title = stats.truncated
    ? t(
        "已结算 {n}+ 市场 · 胜率/ROI 无法可靠统计（结算过多，只取到按盈亏排序的最赚一部分）\n盈亏为净盈亏（官方 user-pnl 口径，不受截断影响）",
        { n: stats.settledCount },
      )
    : t("已结算 {n} 市场", { n: stats.settledCount }) +
      (pct != null ? t(" · 胜率 {pct}%", { pct }) : "") +
      (stats.roi != null
        ? t(" · ROI {roi}%", { roi: (stats.roi * 100).toFixed(1) })
        : "") +
      t(
        "\n盈亏数字为净盈亏（已实现+浮动，官方 user-pnl 口径），非上面的已结算口径",
      );
  return (
    <span className="mono" style={{ whiteSpace: "nowrap" }}>
      {trophy}
      {trophy ? " " : ""}
      <span className="tip-pop" title={title} {...tipPopProps(title)}>
        {pct != null ? `${pct}% · ` : ""}
        <span className={tone}>
          {stats.netPnl != null ? fmtSignedUsdCompact(stats.netPnl) : "—"}
        </span>
      </span>
    </span>
  );
}

/* ---------------------------------------------------------- SoundToggle */

// New-record notification sound toggle. Drive it with the useSoundToggle hook
// (state + persistence + chime-on-enable). 🔔 = on, 🔕 = off.
export function SoundToggle({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  const { t } = useLang();
  return (
    <button
      type="button"
      className={`ds-btn ${on ? "ds-btn--subtle" : "ds-btn--ghost"}`}
      onClick={onToggle}
      aria-pressed={on}
      title={
        on
          ? t("新增记录时播放气泡提示音（点击关闭）")
          : t("开启新增记录气泡提示音")
      }
      style={{ flexShrink: 0 }}
    >
      {on ? `🔔 ${t("提示音 开")}` : `🔕 ${t("提示音 关")}`}
    </button>
  );
}

/* ------------------------------------------------------------------ Modal */

// 弹窗 —— 背板点击 + Esc 关闭,卡内滚动。
// 版式出自设计稿:标题条 `16px 24px` + 底边,内容 `16px 24px 24px`,
// 圆角 12,遮罩 rgba(8,29,53,.45),阴影 0 24px 64px rgba(8,29,53,.28)。
// 横向 24px 不是拍脑袋:此前 /follow 详情弹窗实测(getBoundingClientRect
// 量内容块与弹窗四边的实际间距)发现 16px 夹在两个 24px 中间(区块间 gap
// 24、背板外间距 24),两侧看起来比上下更紧 —— 该弹窗单独调到 24 修掉了它。
// 设计稿把 24 定为全站弹窗的横向内边距,于是这里成为默认值,调用方不再
// 需要传 padding(那个 prop 已随之删除)。
export function Modal({
  open,
  onClose,
  title,
  children,
  width = 560,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  // number(px)一直够用,直到 /follow 的详情弹窗想要"大屏 1200、窄屏按
  // vw 收窄"这种响应式上限——CSS `min(1200px, 92vw)` 表达力比单个数字强,
  // 加 string 分支让调用方能直接传这类表达式,不用引入新的 prop。
  width?: number | string;
}) {
  const { t } = useLang();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--ww-scrim)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "var(--s-6, 24px)",
        zIndex: 1000,
        overflow: "auto",
      }}
    >
      <div
        className="ds-card"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: width,
          boxShadow: "var(--shadow-modal)",
          // 这个 div 是外层 flex 容器(justifyContent:center)里唯一的
          // flex item。flex item 的默认 min-width 是 "auto"(= 内容的
          // min-content 宽度),这个自动最小值会压过 max-width——弹窗内一旦
          // 出现不可换行的宽内容(长表格、横向指标网格),会把整张卡撑得
          // 比 max-width/视口还宽,内容区被迫出现横向滚动条。显式清零,让
          // max-width 说了算,溢出交给下面内容区自己的 overflow:auto 处理。
          minWidth: 0,
          // bug 修复(2026-08):Modal 不用 portal——挂载在调用方 JSX 树里
          // 原来的位置,不脱离文档流。/follow 详情弹窗从"列表"视图的
          // 「详情」按钮打开时,那个按钮在一个 <td> 里,而 .ds-table td 全站
          // 统一 white-space:nowrap(表格默认不换行,靠横向滚动兜底)——这
          // 条继承属性的规则会一路传给弹窗内部所有文字,弹窗里几段本该自动
          // 换行的长提示文案(如成本四段分解、账户推演的说明段)因此被强制
          // 单行,横向撑爆弹窗宽度,出现横向滚动条。从"卡片"视图打开同一个
          // 弹窗不触发——那里的挂载点是普通 div,没有这条继承。显式重置成
          // normal,弹窗的排版不该被它恰好挂在哪个 DOM 位置这种实现细节
          // 影响,这也是更稳妥的做法:以后任何新的挂载点(卡片/列表之外)
          // 都不会重新踩到这个坑。
          whiteSpace: "normal",
          // bug 修复(2026-08,/follow 详情弹窗 tab 化验收时发现):同一个
          // "不用 portal,挂载点的祖先样式会继承进来"根因,这次是另一条继承
          // 属性——列表视图那个 <td> 用的是 .is-right(text-align:right,
          // 数值列右对齐的工具类)。white-space 当时单独重置过,text-align
          // 没有,于是从列表视图打开时,弹窗里所有没有自己显式对齐方式的块
          // (提示文案、tab 切换条等)会整体右对齐,从卡片视图打开则正常
          // 左对齐——本次加 tab 切换条后这条继承第一次变得肉眼可见(tab 条
          // 整体跑到弹窗右侧),此前的口径提示文案/区块标题字号小、行数少,
          // 同样受影响但不易察觉。同样显式重置,不依赖挂载点样式。
          textAlign: "left",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          padding: 0,
          overflow: "hidden",
        }}
      >
        {/* 标题条:20/600 + 底边分格线。关闭钮是 28px 无框图标钮 ——
            这套皮里「关闭」不是一个需要描边强调的动作。 */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "var(--s-4)",
            padding: "var(--s-4) var(--s-6)",
            borderBottom: "1px solid var(--ww-border)",
          }}
        >
          <span
            style={{
              minWidth: 0,
              fontSize: "var(--t-xl)",
              fontWeight: 600,
              lineHeight: 1.3,
              color: "var(--ww-text)",
              overflowWrap: "anywhere",
            }}
          >
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("关闭")}
            style={{
              flex: "0 0 auto",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              border: 0,
              borderRadius: "var(--r-btn)",
              background: "none",
              color: "var(--ww-text-muted)",
              fontSize: 18,
              lineHeight: 1,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
        {/* 滚动容器在卡片 padding 内侧,竖向滚动条会紧贴内容零间距渲染
            (2026-08-13 真机截图:深度分析各 tab 右列数字几乎顶着滚动条)。
            给滚动容器自己加右内边距,内容与滚动条之间恒有呼吸空间;
            scrollbarGutter:stable 让经典滚动条(Windows 等)出现/消失时
            不引起内容横向跳动,overlay 滚动条(macOS 默认)下宽度为 0、
            无副作用。所有弹窗所有 tab 共此一处,不逐弹窗修。 */}
        <div
          style={{
            overflow: "auto",
            minHeight: 0,
            padding: "var(--s-4) var(--s-6) var(--s-6)",
            scrollbarGutter: "stable",
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- HoldingCell */

// Current-market-position reference (the "stock"): market value + unrealized %,
// with shares / entry / cash PnL in the tooltip. `…` while loading, `—` when the
// wallet holds none of this outcome now (bought in-window but since cleared).
export function HoldingCell({
  pos,
  loading,
}: {
  pos?: MarketPos;
  loading?: boolean;
}) {
  const { t } = useLang();
  if (!pos) {
    return loading ? (
      <span className="mono muted">…</span>
    ) : (
      <span
        className="muted"
        title={t("当前在该结果无持仓（窗口内买过但已清仓/转向）")}
      >
        —
      </span>
    );
  }
  const tone = pos.cashPnl >= 0 ? "up" : "down";
  const title = t("{shares} 股 · 现价 {cur} · 建仓 {avg} · 浮盈 {pnl}", {
    shares: Math.round(pos.size).toLocaleString("en-US"),
    cur: pos.curPrice.toFixed(3),
    avg: pos.avgPrice.toFixed(3),
    pnl: `${pos.cashPnl >= 0 ? "+" : ""}$${Math.round(pos.cashPnl).toLocaleString("en-US")}`,
  });
  return (
    <span className="mono" title={title}>
      ${Math.round(pos.currentValue).toLocaleString("en-US")}{" "}
      <span className={tone}>
        ({pos.percentPnl >= 0 ? "+" : ""}
        {pos.percentPnl.toFixed(1)}%)
      </span>
    </span>
  );
}
