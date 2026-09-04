import type { ContinuityReport } from "./continuity";
import type { HealthReport } from "./health";
import type { RecordFeed, RecordFeedStrategy } from "./recordFeed";
import type { AxisPercentile, SelfTestVerdict } from "./selfTest";

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

// 嵌入卡拿不到 globals.css(iframe 里没有它),所以颜色必须在这里写死。
// 导出是给测试用的:主题断言应该表达「dark 换了底色」这个意图,而不是钉死
// 某个十六进制值 —— 后者每次调色板微调都会红一次,且在 dark.bg 恰好等于
// light.fg 时(本套皮就是如此,都是 #081d35)还会给出假阴性。
export const EMBED_PALETTE: Record<
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
  // light 是站点本体的 Etherscan 风点值(与 app/globals.css 的 --ww-* 一一
  // 对应),这样嵌到别处的卡和站内看到的是同一套颜色。dark 是给嵌入方的
  // 深底适配 —— 它不是「站内深色面」(站内唯一深色面是代码面板),而是
  // 别人页面底色深时的可读性兜底,用同一族色相压暗/提亮得来。
  light: {
    bg: "#ffffff",
    fg: "#081d35",
    muted: "#6c757d",
    border: "#e9ecef",
    up: "#00a186",
    down: "#dc3545",
    link: "#0784c3",
  },
  dark: {
    bg: "#081d35",
    fg: "rgba(255,255,255,0.86)",
    muted: "rgba(255,255,255,0.55)",
    border: "rgba(255,255,255,0.12)",
    up: "#3fd6b8",
    down: "#ff7b86",
    link: "#4db8e8",
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
  const p = EMBED_PALETTE[theme];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  html,body{margin:0;padding:0;background:${p.bg};color:${p.fg};font:13px/1.5 "Helvetica Neue",Helvetica,Arial,"PingFang SC","Noto Sans SC",sans-serif}
  .wrap{padding:12px 16px}
  .title{font-size:14px;font-weight:600;margin:0 0 8px}
  table{border-collapse:collapse;width:100%}
  td,th{padding:4px 0;text-align:left;font-weight:400}
  /* 数字不用等宽,与正文同字体同字号常规字重 —— 与站内同一条规矩。 */
  td.num{text-align:right;white-space:nowrap}
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
      ? ` · digest ${escapeHtml(feed.digest.day)} <span>${escapeHtml((feed.digest.tail ?? "").slice(0, 10))}…</span>`
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

// ---- /embed/selftest —— 聪明钱自测判决卡 -------------------------------

export interface SelfTestEmbedInput {
  address: string;
  verdict: SelfTestVerdict;
  /** wallet_stats 行的拉取时间(秒);卡上标「数据截至」。 */
  statsFetchedAt: number | null;
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const fmtPctile = (p: AxisPercentile | null): string =>
  p ? `P${Math.round(p.pct)} of ${p.sampleN}` : "—";

const fmtUsdSigned = (n: number): string =>
  `${n >= 0 ? "+" : "−"}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;

/** 判决词与色调。「没过」与「判不了」在措辞上严格分家。 */
export function selfTestHeadline(v: SelfTestVerdict): {
  text: string;
  tone: "up" | "down" | "muted";
} {
  switch (v.verdict) {
    case "pass":
      return { text: "PASS — clears the pool-admission bar", tone: "up" };
    case "fail":
      return {
        text: "BELOW BAR — does not clear the pool-admission bar",
        tone: "down",
      };
    case "bot":
      return {
        text: "N/A — HF market-maker / bot, win-rate basis not applicable",
        tone: "muted",
      };
    case "unjudged": {
      const why =
        v.unjudgedReason === "truncated"
          ? "record truncated upstream (profit-sorted winner slice)"
          : v.unjudgedReason === "small_sample"
            ? `fewer than ${v.criteria.minSettledRoi} settled markets`
            : "net P/L unavailable";
      return { text: `UNJUDGEABLE — ${why}`, tone: "muted" };
    }
    default:
      return { text: "Not tested yet", tone: "muted" };
  }
}

/**
 * /embed/selftest —— 判决卡。红线:渲染层拿到什么画什么,取数侧保证零上游
 * (只读 wallet_stats 现存行);no_data = 本地无缓存 → 引导卡,绝不替围观者
 * 花上游预算。免责声明与样本口径随卡走 —— 分发出去的卡必须自带上下文。
 */
export function renderSelfTestEmbed(
  input: SelfTestEmbedInput,
  opts: { theme: EmbedTheme; baseUrl: string },
): string {
  const host = new URL(opts.baseUrl).host;
  const v = input.verdict;
  const head = selfTestHeadline(v);
  const addr = shortAddr(input.address);

  let inner: string;
  if (v.verdict === "no_data") {
    inner = `<p class="title">WhaleWatch · smart-money self-test</p>
<p><span>${escapeHtml(addr)}</span> — <b>Not tested yet</b>: no cached record for this address.</p>
<p class="muted">Run the self-test on ${escapeHtml(host)} to get a verdict against the smart-money pool-admission bar.</p>`;
  } else {
    const s = v.stats;
    const rows: [string, string, string][] = [
      [
        "Win rate",
        s?.winRate != null ? `${Math.round(s.winRate * 100)}%` : "—",
        fmtPctile(v.percentiles.winRate),
      ],
      [
        "Net P/L",
        s?.netPnl != null ? fmtUsdSigned(s.netPnl) : "—",
        fmtPctile(v.percentiles.netPnl),
      ],
      [
        "Score",
        v.score != null ? String(v.score) : "—",
        fmtPctile(v.percentiles.score),
      ],
    ];
    const trs = rows
      .map(
        ([k, val, pctile]) =>
          `<tr><td>${k}</td><td class="num">${escapeHtml(val)}</td><td class="num muted">${escapeHtml(pctile)}</td></tr>`,
      )
      .join("");
    const c = v.criteria;
    const bar =
      `Bar: ≥${c.minSettled} settled · ≥${Math.round(c.minWinRate * 100)}% win rate · positive net P/L — ` +
      `or ≥${c.minSettledRoi} settled · ≥${Math.round(c.minRoi * 100)}% ROI · positive net P/L`;
    const asOf =
      input.statsFetchedAt != null
        ? ` · Data as of ${new Date(input.statsFetchedAt * 1000).toISOString().slice(0, 10)}`
        : "";
    inner = `<p class="title">WhaleWatch · smart-money self-test · <span>${escapeHtml(addr)}</span></p>
<p class="${head.tone}" style="font-weight:600;margin:0 0 8px">${escapeHtml(head.text)}</p>
<table><tr class="muted"><th></th><th style="text-align:right">value</th><th style="text-align:right">pool pct</th></tr>${trs}</table>
<div class="muted" style="margin-top:6px">${s ? `${s.settledCount} settled` : ""}${asOf} · pool of ${v.poolSize}${v.inPool ? " (already a member)" : ""}</div>
<div class="muted" style="margin-top:4px">${escapeHtml(bar)}</div>
<div class="muted" style="margin-top:4px">Track-record checkup against this site's pool-admission bar — not certification, not investment advice. Percentiles vs the current pool (picked by this site's own bar, not all traders).</div>`;
  }
  return shell(
    opts.theme,
    `WhaleWatch self-test ${addr}`,
    inner,
    `${opts.baseUrl}/selftest`,
    host,
  );
}

/** /embed/status —— 引擎状态 + 连续性时钟徽章。 */
export function renderStatusEmbed(
  health: HealthReport,
  cont: ContinuityReport,
  opts: { theme: EmbedTheme; baseUrl: string },
): string {
  const p = EMBED_PALETTE[opts.theme];
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
