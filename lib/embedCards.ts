import type { ContinuityReport } from "./continuity";
import type { HealthReport } from "./health";
import type { RecordFeed, RecordFeedStrategy } from "./recordFeed";

// 可嵌入卡片的纯渲染层(docs/plans/2026-08-27-outlet-trio-design.md #2)。
// 路由(app/embed/*)只做取数与响应头,HTML 全在这里 —— 可测的部分与接线分开。
//
// 自包含纪律:内联样式、零 JS、不依赖 globals.css(iframe 里没有它),
// 文案用英文(嵌入卡是对外名片,与 layout metadata / X 播报同一语言策略)。
// 每张卡固定携带署名回链 —— 嵌入即分发,分发必须带得回来。

export type EmbedTheme = "light" | "dark";

export function parseTheme(v: string | null): EmbedTheme {
  return v === "dark" ? "dark" : "light";
}

// 设计系统是 OKLCH token,但嵌入卡拿不到 globals.css —— 这里是对应色的
// sRGB 近似,只服务嵌入场景,站内永远用 token。
const PALETTE: Record<
  EmbedTheme,
  {
    bg: string;
    fg: string;
    muted: string;
    border: string;
    up: string;
    down: string;
    link: string;
  }
> = {
  light: {
    bg: "#ffffff",
    fg: "#1c1f2a",
    muted: "#6b7085",
    border: "#e3e5ee",
    up: "#0f7a4d",
    down: "#b3372c",
    link: "#2743e0",
  },
  dark: {
    bg: "#14161e",
    fg: "#e8eaf2",
    muted: "#9aa0b5",
    border: "#2a2e3d",
    up: "#3ecf8e",
    down: "#ff6b5e",
    link: "#8fa2ff",
  },
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const shell = (
  theme: EmbedTheme,
  title: string,
  inner: string,
  footerHref: string,
  host: string,
): string => {
  const p = PALETTE[theme];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  html,body{margin:0;padding:0;background:${p.bg};color:${p.fg};font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{padding:12px 14px}
  .title{font-size:13px;font-weight:600;margin:0 0 8px}
  table{border-collapse:collapse;width:100%}
  td,th{padding:3px 0;text-align:left;font-weight:400}
  td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .muted{color:${p.muted}}
  .up{color:${p.up}}
  .down{color:${p.down}}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:baseline}
  .foot{margin-top:8px;padding-top:7px;border-top:1px solid ${p.border};font-size:11px}
  a{color:${p.link};text-decoration:none}
</style></head><body><div class="wrap">${inner}
<div class="foot"><a href="${footerHref}" target="_blank" rel="noopener">${escapeHtml(host)} →</a></div>
</div></body></html>`;
};

/** 战绩摘要一格:样本为零给 "—",绝不用 0 冒充「测过了」。 */
export function fmtRecordCell(s: RecordFeedStrategy): {
  text: string;
  tone: "up" | "down" | "muted";
} {
  const r = s.record;
  if (r.settled === 0) return { text: "—", tone: "muted" };
  const sigma = r.sd > 0 ? ` (${(r.excess / r.sd).toFixed(1)}σ)` : "";
  const sign = r.excess >= 0 ? "+" : "";
  return {
    text: `${r.wins}/${r.settled} · ${sign}${r.excess.toFixed(1)} vs market${sigma}`,
    tone: r.excess >= 0 ? "up" : "down",
  };
}

/** /embed/record —— 已发布信号记分卡(与 /record 页同源 buildRecordFeed)。 */
export function renderRecordEmbed(
  feed: RecordFeed,
  opts: { theme: EmbedTheme; baseUrl: string; maxRows?: number },
): string {
  const maxRows = opts.maxRows ?? 8;
  const host = new URL(opts.baseUrl).host;
  const rows = [...feed.strategies].sort(
    (a, b) => b.pushedCount - a.pushedCount,
  );
  const shown = rows.slice(0, maxRows);
  const moreCount = rows.length - shown.length;

  let inner: string;
  if (rows.length === 0) {
    inner = `<p class="title">WhaleWatch · published-signal record</p>
<p class="muted">No published signals yet — the ledger is accumulating quietly.</p>`;
  } else {
    const trs = shown
      .map((s) => {
        const cell = fmtRecordCell(s);
        return `<tr><td>${escapeHtml(s.name)}</td><td class="num muted">${s.pushedCount}</td><td class="num ${cell.tone}">${escapeHtml(cell.text)}</td></tr>`;
      })
      .join("");
    const more =
      moreCount > 0
        ? `<div class="muted" style="margin-top:4px">+${moreCount} more tiers</div>`
        : "";
    const digest = feed.digest.day
      ? ` · digest ${escapeHtml(feed.digest.day)} <span style="font-family:ui-monospace,monospace">${escapeHtml((feed.digest.tail ?? "").slice(0, 10))}…</span>`
      : "";
    inner = `<p class="title">WhaleWatch · published-signal record (30d, price-adjusted)</p>
<table><tr class="muted"><th>tier</th><th style="text-align:right">pushed</th><th style="text-align:right">settled record</th></tr>${trs}</table>${more}
<div class="muted" style="margin-top:6px">Updated ${new Date(feed.updatedAt * 1000).toISOString().slice(0, 16)}Z${digest}</div>`;
  }
  return shell(
    opts.theme,
    "WhaleWatch record",
    inner,
    `${opts.baseUrl}/record`,
    host,
  );
}

/** /embed/status —— 引擎状态 + 连续性时钟徽章。 */
export function renderStatusEmbed(
  health: HealthReport,
  cont: ContinuityReport,
  opts: { theme: EmbedTheme; baseUrl: string },
): string {
  const p = PALETTE[opts.theme];
  const host = new URL(opts.baseUrl).host;
  const stale = health.loops.filter((l) => l.stale).length;
  const headline = health.ok
    ? "All systems operational"
    : stale > 0
      ? `${stale} loop(s) stalled`
      : "Engine not running";
  const dotColor = health.ok ? p.up : p.down;
  const streak =
    cont.recordStartDay == null
      ? "no cycle records yet"
      : `${cont.streakClipped ? "≥" : ""}${cont.streakDays}d continuous coverage` +
        (cont.streakStartDay ? ` · since ${cont.streakStartDay}` : "") +
        (cont.gateReached ? " · 30d gate ✓" : "");
  const inner = `<p class="title" style="margin-bottom:4px"><span class="dot" style="background:${dotColor}"></span>${escapeHtml(headline)}</p>
<div class="muted">${escapeHtml(streak)}</div>`;
  return shell(
    opts.theme,
    "WhaleWatch status",
    inner,
    `${opts.baseUrl}/status`,
    host,
  );
}
