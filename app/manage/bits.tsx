"use client";

import type { ReactNode } from "react";

// /manage 专用的微型呈现原语 —— 全部建立在设计系统 token 上,零硬编码色值。

export type Tone = "up" | "down" | "warn" | "muted";

const DOT_BG: Record<Tone, string> = {
  up: "var(--up-500)",
  down: "var(--down-500)",
  warn: "var(--warn-500)",
  muted: "var(--n-300)",
};

/** 状态圆点(.ds-dot)+ 可选文字,语义色取 token。 */
export function Dot({ tone, children }: { tone: Tone; children?: ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--s-2)",
      }}
    >
      <span className="ds-dot" style={{ background: DOT_BG[tone] }} />
      {children}
    </span>
  );
}

/** 区块标题行:左侧标题 + 右侧补充(计数 Tag / 操作),间距按规范。 */
export function SectionHead({
  title,
  aside,
  hint,
}: {
  title: ReactNode;
  aside?: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <header style={{ marginBottom: "var(--s-4)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "var(--s-3)",
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ fontSize: "var(--t-lg)", fontWeight: 600, margin: 0 }}>
          {title}
        </h2>
        {aside}
      </div>
      {hint && (
        <div className="ds-hint" style={{ marginTop: "var(--s-1)" }}>
          {hint}
        </div>
      )}
    </header>
  );
}
