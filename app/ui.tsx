"use client";

// Shared design-system primitives (MM Manage v3) for the Polymarket monitor.
// Single source of truth so the three pages stop duplicating inline styles.
// Visuals live in app/globals.css; these components only wire props → classes.

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { formatAge, type AgeTone } from "./ageFormat";

/* ---------------------------------------------------------------- TopNav */

const NAV = [
  { href: "/", label: "24h 扫描" },
  { href: "/alerts", label: "实时告警" },
  { href: "/accumulation", label: "拆单累计" },
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
  return <span className={AGE_CLASS[tone]}>{text}</span>;
}
