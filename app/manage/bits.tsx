"use client";

import { useEffect, useState, type ReactNode } from "react";

// /manage 专用的微型呈现原语 —— 全部建立在设计系统 token 上,零硬编码色值。

export type Tone = "up" | "down" | "warn" | "muted";

const DOT_BG: Record<Tone, string> = {
  up: "var(--ww-up)",
  down: "var(--ww-down)",
  // --warn-500 指向的是**描边**色 rgba(255,193,7,.6) —— 7px 的实心圆点用它
  // 淡到看不见。琥珀的实体色是 --ww-warn(#b47d00),与琥珀徽章的文字同源。
  warn: "var(--ww-warn)",
  muted: "var(--ww-text-faint)",
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
 *
 * 视觉(Etherscan 风):它不再是一张独立的卡,而是分区导航卡内部的一条
 * **卡内标题条**(.card-bar,12px 16px + 底边 1px)。层级来自那条 1px 分格线
 * 与 14/600 的标题,不来自字号跳档或投影 —— 卡中卡会把「地图」和「主表」
 * 并列成两块内容,而它其实是主表的抬头。
 */
export function Foldable({
  storageKey,
  title,
  hint,
  summary,
  defaultOpen = false,
  flush = false,
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
  /**
   * 独占一张卡时置 true:不画自己那条收尾分格线 —— 卡片边框就在紧下方,
   * 两条 1px 贴在一起会读成一条 2px 的粗线。默认 false(卡内多段并列时,
   * 这条线正是段与段之间的层级来源)。
   */
  flush?: boolean;
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
      style={{
        borderBottom: flush ? "none" : "1px solid var(--ww-border)",
      }}
    >
      {/* 整条标题条都是开关 —— 折叠态那行读数(summary)本来就是它的说明,
          让人去瞄准一枚 30px 小钮是没必要的精细活。 */}
      <button
        type="button"
        className="card-bar"
        aria-expanded={open}
        onClick={toggle}
        style={{
          width: "100%",
          textAlign: "left",
          alignItems: "baseline",
          background: "transparent",
          border: 0,
          borderBottom: open ? "1px solid var(--ww-border)" : "none",
          borderRadius: 0,
          fontFamily: "inherit",
          cursor: "pointer",
        }}
      >
        <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
          {open ? "▾" : "▸"} {title}
        </span>
        {!open && summary && (
          <span className="ds-hint" style={{ minWidth: 0 }}>
            {summary}
          </span>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontSize: "var(--t-base)",
            color: "var(--ww-link)",
            whiteSpace: "nowrap",
          }}
        >
          {open ? "收起" : "展开"}
        </span>
      </button>
      {open && (
        <>
          {/* 说明条限宽 700 —— 与页头描述同一条规矩:1120 宽的一行中文能塞
              六十多个字,读到行尾就找不着下一行的行首了。长段落走
              text-wrap:pretty,不让末行只剩一两个字。 */}
          {hint && (
            <div
              className="ds-hint"
              style={{
                padding: "var(--s-3) var(--s-4)",
                lineHeight: "var(--lh-note)",
                maxWidth: 700,
                textWrap: "pretty",
                borderBottom: "1px solid var(--ww-border)",
              }}
            >
              {hint}
            </div>
          )}
          {children}
        </>
      )}
    </section>
  );
}

/**
 * 区块标题行:左侧标题 + 右侧补充(计数 Tag / 操作)+ 下方说明。
 *
 * 视觉:16 / 600 的卡片标题 + 一条 1px 分格线 —— 层级来自那条线,不来自
 * 字号跳档。说明文字走 13px muted / 1.6 行高,限宽 700 以免长句拉成一行。
 */
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
    <header
      style={{
        marginBottom: "var(--s-4)",
        paddingBottom: "var(--s-3)",
        borderBottom: "1px solid var(--ww-border)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "var(--s-3)",
          flexWrap: "wrap",
        }}
      >
        <h2
          style={{
            fontSize: "var(--t-lg)",
            fontWeight: 600,
            lineHeight: "var(--lh-tight)",
            margin: 0,
          }}
        >
          {title}
        </h2>
        {aside}
      </div>
      {hint && (
        <div
          className="ds-hint"
          style={{
            marginTop: "var(--s-2)",
            maxWidth: 700,
            lineHeight: "var(--lh-note)",
            textWrap: "pretty",
          }}
        >
          {hint}
        </div>
      )}
    </header>
  );
}
