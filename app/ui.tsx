"use client";

// Shared design-system primitives (MM Manage v3) for the Polymarket monitor.
// Single source of truth so the three pages stop duplicating inline styles.
// Visuals live in app/globals.css; these components only wire props → classes.

import type {
  FocusEvent as ReactFocusEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { formatAge, type AgeTone } from "./ageFormat";
import { iconTip } from "./glossary";

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
  { href: "/consensus", label: "聪明钱共识" },
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
  realizedPnl: number;
  roi: number | null;
  settledCount: number;
  truncated: boolean;
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
  const pct = Math.round((stats.winRate ?? 0) * 100);
  const tone = stats.realizedPnl >= 0 ? "up" : "down";
  // Survivorship caveat mirrors computeScore's haircut cases: 100% or a
  // truncated record are upper bounds — zeroed positions never settle into
  // /closed-positions, so "ride it to zero" wallets overstate their win rate.
  const survivorship =
    stats.truncated || (stats.winRate != null && stats.winRate >= 1)
      ? "\n仅含已结算仓位：持有到归零的仓位不计入，死扛型胜率被高估"
      : "";
  const title =
    `已结算 ${stats.settledCount}${stats.truncated ? "+" : ""} 市场 · 胜率 ${pct}%` +
    (stats.roi != null ? ` · ROI ${(stats.roi * 100).toFixed(1)}%` : "") +
    survivorship;
  return (
    <span className="mono" style={{ whiteSpace: "nowrap" }}>
      {trophy}
      {trophy ? " " : ""}
      <span className="tip-pop" title={title} {...tipPopProps(title)}>
        {pct}% ·{" "}
        <span className={tone}>{fmtSignedUsdCompact(stats.realizedPnl)}</span>
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
