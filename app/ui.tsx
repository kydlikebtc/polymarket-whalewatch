"use client";

// Shared design-system primitives (MM Manage v3) for the Polymarket monitor.
// Single source of truth so the three pages stop duplicating inline styles.
// Visuals live in app/globals.css; these components only wire props → classes.

import {
  useEffect,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { formatAge, type AgeTone } from "./ageFormat";
import { iconTip } from "./glossary";
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

const NAV = [
  { href: "/", label: "24h 扫描" },
  { href: "/alerts", label: "实时告警" },
  { href: "/accumulation", label: "拆单累计" },
  { href: "/consensus", label: "共识 / 分歧" },
  { href: "/follow", label: "纸面跟单" },
  { href: "/glossary", label: "说明" },
] as const;

export function TopNav() {
  const pathname = usePathname();
  return (
    <nav className="topbar">
      <div className="topbar__inner">
        <span className="topbar__brand">
          <span aria-hidden>🐋</span>
          Polymarket 监控
        </span>
        <div className="topbar__nav">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="nav-link"
              data-active={pathname === item.href}
            >
              {item.label}
            </Link>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <Tag>只读监控</Tag>
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
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: ReadonlyArray<SegOption<T>>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="ds-segmented" role="group" aria-label={ariaLabel}>
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
  if (!text) return null;
  return (
    <button
      type="button"
      className={copied ? "copy-btn is-copied" : "copy-btn"}
      title={copied ? "已复制" : `${label}：${text}`}
      aria-label={`${label} ${text}`}
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

/* ------------------------------------------------------------- Category */

// Chinese display names for the gamma tag taxonomy; unknown labels pass
// through as-is (the taxonomy grows over time).
const CATEGORY_ZH: Record<string, string> = {
  Politics: "政治",
  Elections: "选举",
  Sports: "体育",
  Esports: "电竞",
  Crypto: "加密",
  Economy: "经济",
  Finance: "金融",
  Business: "商业",
  Tech: "科技",
  Science: "科学",
  "Pop Culture": "文娱",
  Culture: "文娱",
  World: "国际",
  Weather: "天气",
  Games: "游戏",
};

// null/"" → 其他 (unknown category bucket).
export function catLabel(category: string | null | undefined): string {
  if (!category) return "其他";
  return CATEGORY_ZH[category] ?? category;
}

/* ----------------------------------------------------------------- Icon */

// A glossary-backed symbol: hovering any 🐳/🏆/🔥/… shows what it means, and
// a TAP shows the same text as a popover (see tip-pop above) so touch screens
// aren't locked out of the explanations. Tooltip text comes from
// app/glossary.ts (the same source as /glossary), so meanings can never drift
// between the hover, the popover and the docs page.
export function Icon({ s, title }: { s: string; title?: string }) {
  const tip = title ?? iconTip(s);
  if (!tip) return <span>{s}</span>;
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

// BUY → green (up) pill, SELL → red (down) pill. Direction is financial.
export function SideTag({ side }: { side: string }) {
  const v = side === "BUY" ? "up" : side === "SELL" ? "down" : "default";
  return <Tag variant={v}>{side}</Tag>;
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

export function StatCard({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="kpi-card">
      <div className="ds-label">{label}</div>
      {children}
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
  const { text, tone } = formatAge(ageDays);
  const title =
    ageDays == null
      ? iconTip("…")
      : "地址年龄：钱包首次 Polymarket 活动至今。🆕 = ≤30 天新钱包，红色 = <7 天 — 为一笔交易专门开的新钱包是最强内幕信号之一";
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
  const trophyTip = smart
    ? `聪明钱白名单${smart.score != null ? ` · 评分 ${Math.round(smart.score)}` : ""}`
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
    const mmTitle =
      `🤖 高频做市 / 机器人：交易过 ${stats.marketsTraded?.toLocaleString() ?? "海量"} 个不同市场，` +
      "胜率不适用（做市赚点差、非定向下注）\n盈亏为净盈亏（官方 user-pnl 口径）";
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
          title="无已结算战绩"
          {...tipPopProps("无已结算战绩")}
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
    ? `已结算 ${stats.settledCount}+ 市场 · 胜率/ROI 无法可靠统计（结算过多，只取到按盈亏排序的最赚一部分）` +
      "\n盈亏为净盈亏（官方 user-pnl 口径，不受截断影响）"
    : `已结算 ${stats.settledCount} 市场` +
      (pct != null ? ` · 胜率 ${pct}%` : "") +
      (stats.roi != null ? ` · ROI ${(stats.roi * 100).toFixed(1)}%` : "") +
      "\n盈亏数字为净盈亏（已实现+浮动，官方 user-pnl 口径），非上面的已结算口径";
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
  return (
    <button
      type="button"
      className={`ds-btn ${on ? "ds-btn--subtle" : "ds-btn--ghost"}`}
      onClick={onToggle}
      aria-pressed={on}
      title={
        on ? "新增记录时播放气泡提示音（点击关闭）" : "开启新增记录气泡提示音"
      }
      style={{ flexShrink: 0 }}
    >
      {on ? "🔔 提示音 开" : "🔕 提示音 关"}
    </button>
  );
}

/* ------------------------------------------------------------------ Modal */

// Lightweight centered modal: backdrop-click + Esc close, scroll-locked card.
// Reuses .ds-card for a surface consistent with the rest of the dashboard.
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
  width?: number;
}) {
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
        background: "rgba(0,0,0,0.45)",
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
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          padding: "var(--s-4, 16px)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--s-2)",
            marginBottom: "var(--s-3)",
          }}
        >
          <strong>{title}</strong>
          <button
            className="ds-btn ds-btn--ghost"
            onClick={onClose}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div style={{ overflow: "auto", minHeight: 0 }}>{children}</div>
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
  if (!pos) {
    return loading ? (
      <span className="mono muted">…</span>
    ) : (
      <span
        className="muted"
        title="当前在该结果无持仓（窗口内买过但已清仓/转向）"
      >
        —
      </span>
    );
  }
  const tone = pos.cashPnl >= 0 ? "up" : "down";
  const title =
    `${Math.round(pos.size).toLocaleString("en-US")} 股 · 现价 ${pos.curPrice.toFixed(3)} · ` +
    `建仓 ${pos.avgPrice.toFixed(3)} · 浮盈 ${pos.cashPnl >= 0 ? "+" : ""}$${Math.round(
      pos.cashPnl,
    ).toLocaleString("en-US")}`;
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
