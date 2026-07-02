"use client";

// Shared design-system primitives (MM Manage v3) for the Polymarket monitor.
// Single source of truth so the three pages stop duplicating inline styles.
// Visuals live in app/globals.css; these components only wire props → classes.

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { formatAge, type AgeTone } from "./ageFormat";
import { iconTip } from "./glossary";

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

// A glossary-backed symbol: hovering any 🐳/🏆/🔥/… shows what it means.
// Tooltip text comes from app/glossary.ts (the same source as /glossary),
// so meanings can never drift between the hover and the docs page.
export function Icon({ s, title }: { s: string; title?: string }) {
  const tip = title ?? iconTip(s);
  return (
    <span
      title={tip}
      style={tip ? { cursor: "help" } : undefined}
      aria-label={tip || undefined}
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
export function AgeBadge({ ageDays }: { ageDays: number | null | undefined }) {
  const { text, tone } = formatAge(ageDays);
  const title =
    ageDays == null
      ? iconTip("…")
      : "地址年龄：钱包首次 Polymarket 活动至今。🆕 = ≤30 天新钱包，红色 = <7 天 — 为一笔交易专门开的新钱包是最强内幕信号之一";
  return (
    <span className={AGE_CLASS[tone]} title={title} style={{ cursor: "help" }}>
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
export function WalletStatsBadge({
  stats,
  smart,
}: {
  stats: WalletStatsLite | null | undefined;
  smart?: SmartInfoLite | null;
}) {
  const trophy = smart ? (
    <span
      className="ds-tag ds-tag--brand"
      title={`聪明钱白名单${smart.score != null ? ` · 评分 ${Math.round(smart.score)}` : ""}`}
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
      <span className="mono muted" title="无已结算战绩">
        {trophy}
        {trophy ? " " : ""}—
      </span>
    );
  }
  const pct = Math.round((stats.winRate ?? 0) * 100);
  const tone = stats.realizedPnl >= 0 ? "up" : "down";
  const title =
    `已结算 ${stats.settledCount}${stats.truncated ? "+" : ""} 市场 · 胜率 ${pct}%` +
    (stats.roi != null ? ` · ROI ${(stats.roi * 100).toFixed(1)}%` : "");
  return (
    <span className="mono" title={title} style={{ whiteSpace: "nowrap" }}>
      {trophy}
      {trophy ? " " : ""}
      {pct}% ·{" "}
      <span className={tone}>{fmtSignedUsdCompact(stats.realizedPnl)}</span>
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
