"use client";

import { useEffect, useState, type ReactNode } from "react";

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

/**
 * 可折叠的说明性区块。**默认折叠**,展开状态记在 localStorage。
 *
 * 用在概念总览表上:那些「是什么 / 在这页管什么」的表格解释的是分类模型,
 * 理解成本是一次性的,但摆在首屏就变成每次打开都要付的租金 —— 实测两个可
 * 操作 tab 的第一个控件分别落在 1082px 与 1164px,而视口只有 900px,运营者
 * 每次都得先滚过一屏才碰得到开关。
 *
 * 折叠态**不是空的**:summary 那行照常显示当前读数。折教学,不折状态 ——
 * 否则就不是折叠而是藏起来了。
 */
export function Foldable({
  storageKey,
  title,
  hint,
  summary,
  defaultOpen = false,
  children,
}: {
  storageKey: string;
  title: ReactNode;
  /** 展开后才显示的说明文字。 */
  hint?: ReactNode;
  /** 折叠态那一行状态摘要。 */
  summary?: ReactNode;
  /**
   * 没有存过偏好时的初始态。教学性总览默认折(false);状态仪表盘(路由矩阵)
   * 默认展开 —— 它不是教学,折它等于折掉一块读数,但仍给运营者收起的权利。
   */
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // localStorage 只能在客户端读 —— 与 page.tsx 的 tab 记忆同一套姿态。
  useEffect(() => {
    const saved = window.localStorage.getItem(storageKey);
    setOpen(saved == null ? defaultOpen : saved === "1");
  }, [storageKey, defaultOpen]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    window.localStorage.setItem(storageKey, next ? "1" : "0");
  };

  return (
    <section
      className="ds-card"
      style={{ marginBottom: open ? "var(--s-5)" : "var(--s-4)" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "var(--s-3)",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          className="ds-btn ds-btn--subtle ds-btn--sm"
          aria-expanded={open}
          onClick={toggle}
        >
          {open ? "▾" : "▸"} {title}
        </button>
        {!open && summary && (
          <span className="ds-hint" style={{ flex: "1 1 auto" }}>
            {summary}
          </span>
        )}
      </div>
      {open && (
        <>
          {hint && (
            <div className="ds-hint" style={{ margin: "var(--s-3) 0" }}>
              {hint}
            </div>
          )}
          <div style={{ marginTop: hint ? 0 : "var(--s-3)" }}>{children}</div>
        </>
      )}
    </section>
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
